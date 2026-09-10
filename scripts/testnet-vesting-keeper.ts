// SPDX-License-Identifier: Apache-2.0
//
// Releases every tranche that has vested, across every grant. The fallback tier of §7.
//
// This is tier 3, and it is currently the tier that runs, because tier 2 does not work:
// HIP-1215's `scheduleCall` reverts with INVALID_CONTRACT_ID on Hedera testnet for every
// target, from both EOA and contract context, even though `hasScheduleCapacity` on the same
// system contract returns true. See VestingScheduler.sol — that contract is correct and
// should start working the moment the network enables the function.
//
// Worth being clear about what a keeper is and is not here. Vesting is CORRECT without it:
// the ATS lock's expiry is the source of truth, and `releaseVested` is permissionless, so an
// employee can always claim for themselves. The keeper only means nobody has to. It is
// convenience, and it is deliberately not something correctness depends on — which is why
// missing a run is survivable and why it can be switched off.
//
//   npm run testnet:vesting-keeper              # one pass
//   WATCH=60 npm run testnet:vesting-keeper     # keep going, every 60s

import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";

const GAS_BASE = 250_000n;
const GAS_PER_TRANCHE = 140_000n;
const MAX_GAS = 14_000_000n;

const REPO_ROOT = process.env.TOKENIZE_IT_ROOT ?? path.resolve(__dirname, "../../../../../../..");
const DEPLOYMENTS = path.join(REPO_ROOT, "deployments", "hedera-testnet.json");

/** Sized from measured work, not from eth_estimateGas, which under-counts this loop by half. */
const releaseGas = (tranches: number) => {
  const g = GAS_BASE + GAS_PER_TRANCHE * BigInt(Math.max(tranches, 1));
  return g > MAX_GAS ? MAX_GAS : g;
};

async function pass(): Promise<number> {
  const record = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
  const controller = await ethers.getContractAt("ESOPVestingController", record.esopVestingController.address);
  const next = Number(await controller.nextGrantId());
  const now = Math.floor(Date.now() / 1000);
  let released = 0;

  for (let id = 1; id < next; id++) {
    let pending = 0;
    try {
      pending = Number(await controller.pendingTranches(id));
    } catch {
      continue; // a grant that cannot be read is not one to act on
    }
    if (pending === 0) continue;

    // Positional read: an ethers Result loses its named fields when spread, so anything
    // built on `{...t}.vestsAt` silently sees undefined and does nothing.
    const tranches = (await controller.getTranches(id)) as unknown as unknown[][];
    const due = tranches.filter((t) => !t[3] && !t[4] && Number(t[1]) <= now).length;
    if (due === 0) continue;

    process.stdout.write(`  grant #${id}: ${due} tranche(s) due... `);
    try {
      const tx = await controller.releaseVested(id, 40, { gasLimit: releaseGas(due) });
      await tx.wait();
      console.log("released");
      released += due;
    } catch (e) {
      console.log(`skipped (${String((e as Error).message).split("\n")[0].slice(0, 80)})`);
    }
  }
  return released;
}

async function main() {
  console.log("=".repeat(72));
  console.log("  tokenize-it -- vesting keeper (fallback tier)");
  console.log("=".repeat(72));
  console.log("  Vesting is correct without this. It only means nobody has to press claim.");

  const watch = Number(process.env.WATCH ?? 0);
  for (;;) {
    const n = await pass();
    console.log(n > 0 ? `\n  released ${n} tranche(s)` : "\n  nothing due");
    if (!watch) return;
    console.log(`  sleeping ${watch}s...\n`);
    await new Promise((r) => setTimeout(r, watch * 1000));
  }
}

main().catch((e) => {
  console.error("\n\x1b[31mFAILED\x1b[0m", String(e.message ?? e).slice(0, 240));
  process.exitCode = 1;
});
