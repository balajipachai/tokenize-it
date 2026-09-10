// SPDX-License-Identifier: Apache-2.0
//
// Hands the payroll contract over to the Privy treasury wallet.
//
// This is the moment payroll stops being something one key can run and becomes something a
// quorum approves. Before it, the operator could fund a run alone; after it, only the wallet
// whose owner is the key quorum can, and that wallet cannot sign without the threshold.
//
//   TREASURY=0x... npm run testnet:set-payroll-treasury

import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { ethers as ethersLib } from "ethers";

const GAS = { gasLimit: 900_000n };
const REPO_ROOT = process.env.TOKENIZE_IT_ROOT ?? path.resolve(__dirname, "../../../../../../..");
const DEPLOYMENTS = path.join(REPO_ROOT, "deployments", "hedera-testnet.json");

async function main() {
  const [operator] = await ethers.getSigners();
  const record = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
  if (!record.payroll) throw new Error("No PayrollDisburser recorded.");

  const treasury = process.env.TREASURY ?? record.payroll.org?.treasuryAddress;
  if (!treasury || !ethersLib.isAddress(treasury)) {
    throw new Error("Set TREASURY, or run setup-payroll-org.mjs so it is recorded.");
  }

  const payroll = await ethers.getContractAt("PayrollDisburser", record.payroll.address);
  const before = await payroll.treasury();

  console.log(`Handing payroll over to the quorum-owned treasury`);
  console.log(`  payroll  ${record.payroll.address}`);
  console.log(`  from     ${before}`);
  console.log(`  to       ${treasury}`);
  console.log(`  signing as ${operator.address}`);

  if (before.toLowerCase() === treasury.toLowerCase()) {
    console.log("\n  -> already set, nothing to do");
    return;
  }

  await (await payroll.setTreasury(treasury, GAS)).wait();
  const after = await payroll.treasury();
  if (after.toLowerCase() !== treasury.toLowerCase()) throw new Error("setTreasury did not take effect.");

  console.log(`\n  -> treasury is now ${after}`);
  console.log(`  -> ${before} can no longer run payroll`);

  record.payroll.treasury = treasury;
  fs.writeFileSync(DEPLOYMENTS, JSON.stringify(record, null, 2) + "\n");
  console.log("  -> recorded");
}

main().catch((e) => {
  console.error("\n\x1b[31mFAILED\x1b[0m", e.message ?? e);
  process.exitCode = 1;
});
