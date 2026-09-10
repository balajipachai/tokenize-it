// SPDX-License-Identifier: Apache-2.0
//
// Arms the next vesting tranche on Hedera's own clock, via the Schedule Service (HIP-1215).
//
// The point: nobody has to remember. `releaseVested` is already permissionless, so vesting is
// CORRECT with zero automation — an employee can always self-claim. This makes it automatic as
// well, without introducing a party who could withhold it: the consensus node executes the call
// whether or not anyone is watching.
//
// HIP-423 caps a schedule at 62 days, so a four-year schedule cannot be armed up front. This
// arms the NEXT due tranche and is re-run on each release to roll forward. A missed roll is
// recoverable precisely because release stays permissionless — automation is convenience here,
// never correctness.
//
//   GRANT=1 npm run testnet:arm-vesting
//   GRANT=1 ALL=1 npm run testnet:arm-vesting   # arm every tranche inside the 62-day window

import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { ethers as ethersLib } from "ethers";

const HSS = "0x000000000000000000000000000000000000016b";
const MAX_SCHEDULE_AHEAD = 62 * 24 * 60 * 60; // HIP-423
const SCHEDULED_GAS = 2_000_000n;
const GAS = { gasLimit: 3_000_000n };

const REPO_ROOT = process.env.TOKENIZE_IT_ROOT ?? path.resolve(__dirname, "../../../../../../..");
const DEPLOYMENTS = path.join(REPO_ROOT, "deployments", "hedera-testnet.json");

const step = (n: string, m: string) => console.log(`\n\x1b[36m[${n}]\x1b[0m ${m}`);
const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);

async function main() {
  const [operator] = await ethers.getSigners();
  const record = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
  const grantId = BigInt(process.env.GRANT ?? "1");

  const controller = await ethers.getContractAt("ESOPVestingController", record.esopVestingController.address);

  // Scheduling must originate from contract code: an EOA calling scheduleCall reverts with
  // INVALID_CONTRACT_ID after burning the whole gas limit, even though eth_call simulates it
  // happily. VestingScheduler exists solely to be that contract, so the controller — which
  // holds every grant — never had to be touched or redeployed for this.
  let schedulerAddress: string | undefined = record.autoVesting?.scheduler;
  if (!schedulerAddress) {
    const Scheduler = await ethers.getContractFactory("VestingScheduler");
    const deployed = await Scheduler.deploy();
    await deployed.waitForDeployment();
    schedulerAddress = await deployed.getAddress();
    console.log(`  deployed VestingScheduler at ${schedulerAddress}`);
  } else {
    console.log(`  scheduler  ${schedulerAddress}`);
  }
  const scheduler = await ethers.getContractAt("VestingScheduler", schedulerAddress);

  console.log("=".repeat(72));
  console.log("  tokenize-it -- arming vesting on Hedera's clock (HIP-1215)");
  console.log("=".repeat(72));
  console.log(`  controller ${record.esopVestingController.address}`);
  console.log(`  grant      #${grantId}`);

  // The system contract has no bytecode, so a code check would wrongly say "not deployed".
  // Calling a view is the only honest probe.
  const now = Math.floor(Date.now() / 1000);
  const capacity = await scheduler.hasCapacity(now + 600, SCHEDULED_GAS);
  console.log(`  schedule service at ${HSS}: capacity ${capacity ? "available" : "UNAVAILABLE"}`);
  if (!capacity) throw new Error("The network reports no scheduling capacity for that slot.");

  const tranches = await controller.getTranches(grantId);
  // Read POSITIONALLY. An ethers Result exposes named fields but loses every one of them
  // when spread into a plain object, so `{...t}.vestsAt` is silently undefined and every
  // tranche filters out as "nothing to arm" — which is exactly what happened first time.
  // Tranche is (amount, vestsAt, lockId, released, clawedBack).
  const due = (tranches as unknown as unknown[][])
    .map((t, i) => ({ i, vestsAt: Number(t[1]), released: Boolean(t[3]), clawedBack: Boolean(t[4]) }))
    .filter((t) => !t.released && !t.clawedBack && t.vestsAt > now)
    .filter((t) => t.vestsAt - now <= MAX_SCHEDULE_AHEAD);

  if (due.length === 0) {
    console.log("\n  Nothing to arm: every remaining tranche has vested, been forfeited,");
    console.log("  or sits beyond the 62-day scheduling horizon. Re-run after the next release.");
    return;
  }

  const targets = process.env.ALL === "1" ? due : [due[0]];
  step("1", `Scheduling ${targets.length} of ${due.length} armable tranche(s)...`);

  const armed: { tranche: number; vestsAt: number; schedule: string; tx: string }[] = [];

  for (const t of targets) {
    const tx = await scheduler.arm(
      record.esopVestingController.address,
      grantId,
      40,
      t.vestsAt,
      SCHEDULED_GAS,
      { ...GAS, value: ethersLib.parseEther("6") },
    );
    const receipt = await tx.wait();
    let schedule = "";
    for (const log of receipt?.logs ?? []) {
      try {
        const parsed = scheduler.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === "VestArmed") schedule = parsed.args.schedule as string;
      } catch {
        /* other contracts' logs do not parse */
      }
    }
    console.log(`  -> tranche ${t.i} at ${new Date(t.vestsAt * 1000).toISOString().slice(0, 16)}  schedule ${schedule}`);
    armed.push({ tranche: t.i, vestsAt: t.vestsAt, schedule, tx: receipt?.hash ?? "" });
  }

  ok(`${armed.length} vest(s) will now fire on Hedera's clock with nobody watching`);
  console.log("\n  Note: release stays permissionless regardless. If a schedule fails to fire,");
  console.log("  the employee or the keeper can still trigger it — automation never became");
  console.log("  the thing correctness depends on.");

  record.autoVesting = {
    scheduleService: HSS,
    scheduler: schedulerAddress,
    grantId: Number(grantId),
    armed,
    maxScheduleAheadDays: 62,
    armedAt: new Date().toISOString(),
  };
  fs.writeFileSync(DEPLOYMENTS, JSON.stringify(record, null, 2) + "\n");
}

main().catch((e) => {
  console.error("\n\x1b[31mFAILED\x1b[0m", String(e.message ?? e).slice(0, 300));
  process.exitCode = 1;
});
