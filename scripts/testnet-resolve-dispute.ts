// SPDX-License-Identifier: Apache-2.0
//
// Rules on a contested termination, as the arbiter.
//
// The arbiter is a multisig CONTRACT, not a wallet: the controller refuses to register
// anything without code and a threshold of at least two. So a ruling is a call the arbiter
// makes on the controller. In this deployment the arbiter is a 2-of-N stand-in whose single
// executor is the operator key in .env, which is why this runs as the operator. A real
// deployment points setArbiter at an actual Safe, and a ruling becomes a Safe transaction
// its owners sign.
//
//   npm run testnet:resolve-dispute                                 # list open disputes
//   GRANT=4 UPHOLD=true  npm run testnet:resolve-dispute            # the termination stands
//   GRANT=4 UPHOLD=false npm run testnet:resolve-dispute            # overturned: reinstated
//   GRANT=4 UPHOLD=false DRY_RUN=1 npm run testnet:resolve-dispute  # check, change nothing

import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";

const REPO_ROOT = process.env.TOKENIZE_IT_ROOT ?? path.resolve(__dirname, "../../../../../../..");
const DEPLOYMENTS = path.join(REPO_ROOT, "deployments", "hedera-testnet.json");

/** Grant.status and Grant.dispute, from ESOPVestingController. */
const STATUS = ["None", "Funding", "Active", "Terminated"];
const DISPUTE = ["none", "raised", "upheld", "overturned"];
const LEAVER = ["none", "good leaver", "bad leaver"];
const TERMINATED = 3;
const RAISED = 1;

/** Hedera charges gas used, not offered, so a generous ceiling is free and a tight one fails silently. */
const GAS = { gasLimit: 3_000_000n };

const when = (s: bigint | number) => new Date(Number(s) * 1000).toISOString().replace("T", " ").slice(0, 19);

async function main() {
  const [operator] = await ethers.getSigners();
  const record = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
  const controllerAddress: string = record.esopVestingController.address;
  const arbiterAddress: string | undefined = record.esopVestingController.arbiter?.address;
  const controller = await ethers.getContractAt("ESOPVestingController", controllerAddress);

  console.log("=".repeat(72));
  console.log("  tokenize-it -- resolve a dispute, as the arbiter");
  console.log("=".repeat(72));
  console.log(`  controller ${controllerAddress}`);
  console.log(`  arbiter    ${arbiterAddress ?? "(none recorded)"}`);

  const grantEnv = process.env.GRANT;

  // ------------------------------------------------------------------ list mode
  if (!grantEnv) {
    const next = Number(await controller.nextGrantId());
    const open: number[] = [];
    const decided: string[] = [];

    for (let id = 1; id < next; id++) {
      // Positional reads: an ethers Result loses its field names when spread.
      const g = await controller.getGrant(id);
      const dispute = Number(g[9]);
      if (dispute === 0) continue;
      if (dispute !== RAISED) {
        decided.push(`  grant #${id}  ${g[0]}  ${DISPUTE[dispute]}`);
        continue;
      }
      open.push(id);
      const atStake = await controller.unvestedAmount(id);
      console.log(`\n  \x1b[33mgrant #${id}\x1b[0m  awaiting a ruling`);
      console.log(`    employee       ${g[0]}`);
      console.log(`    terminated as  ${LEAVER[Number(g[8])]} on ${when(g[5])}`);
      console.log(`    decided by     ${g[11]}`);
      console.log(`    at stake       ${atStake} unvested options, forfeited if the termination stands`);
      console.log(`    to rule:       GRANT=${id} UPHOLD=true  npm run testnet:resolve-dispute   # stands`);
      console.log(`                   GRANT=${id} UPHOLD=false npm run testnet:resolve-dispute   # overturned`);
    }

    if (open.length === 0) {
      console.log("\n  No disputes are waiting for a ruling.");
      console.log("  An employee raises one from their portal (\"Contest this termination\"), and only");
      console.log("  while the dispute window after their termination is still open.");
    }
    if (decided.length > 0) {
      console.log("\n  Already decided:");
      decided.forEach((line) => console.log(line));
    }
    return;
  }

  // ------------------------------------------------------------------ rule mode
  const grantId = Number(grantEnv);
  const upholdEnv = process.env.UPHOLD;
  // Never defaulted. A ruling that happened because someone forgot a flag is not a ruling.
  if (upholdEnv !== "true" && upholdEnv !== "false") {
    throw new Error("Say which way: UPHOLD=true (the termination stands) or UPHOLD=false (overturned).");
  }
  const upheld = upholdEnv === "true";
  if (!arbiterAddress) throw new Error("No arbiter recorded in deployments/hedera-testnet.json.");

  const arbiter = await ethers.getContractAt("MockMultisig", arbiterAddress);
  if (!(await controller.isArbiter(arbiterAddress))) {
    throw new Error(`${arbiterAddress} is not registered as an arbiter on this controller.`);
  }
  const executor: string = await arbiter.executor();
  if (executor.toLowerCase() !== operator.address.toLowerCase()) {
    throw new Error(`The arbiter acts only for ${executor}; this key is ${operator.address}.`);
  }

  const g = await controller.getGrant(grantId);
  if (Number(g[7]) !== TERMINATED && Number(g[9]) !== RAISED) {
    throw new Error(`Grant #${grantId} is ${STATUS[Number(g[7])]} with dispute ${DISPUTE[Number(g[9])]} -- nothing to rule on.`);
  }
  if (Number(g[9]) !== RAISED) {
    throw new Error(`Grant #${grantId}'s dispute is ${DISPUTE[Number(g[9])]}, not raised -- there is nothing to rule on.`);
  }

  console.log(`\n  grant #${grantId}  ${g[0]}`);
  console.log(`    ruling: ${upheld ? "UPHELD -- the termination stands" : "OVERTURNED -- the grant is reinstated"}`);

  const call = controller.interface.encodeFunctionData("resolveDispute", [grantId, upheld]);

  if (process.env.DRY_RUN === "1") {
    await arbiter.execute.staticCall(controllerAddress, call, GAS);
    console.log("\n  \x1b[32mDry run: this ruling would go through.\x1b[0m Nothing was sent.");
    return;
  }

  await (await arbiter.execute(controllerAddress, call, GAS)).wait();
  const after = await controller.getGrant(grantId);
  console.log(`\n  \x1b[32mRecorded.\x1b[0m dispute ${DISPUTE[Number(after[9])]}, grant ${STATUS[Number(after[7])]}`);
  console.log(
    upheld
      ? "  HR can now claw back the unvested remainder: Clawback on the employee's card in the issuer console."
      : "  Vesting resumes from where it stopped. The employee's portal shows the grant reinstated.",
  );
}

main().catch((e) => {
  console.error("\n\x1b[31mFAILED\x1b[0m", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
