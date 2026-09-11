// SPDX-License-Identifier: Apache-2.0
//
// Deploys PayrollDisburser against the stablecoin the lending pool already uses.
//
// Sharing that token is not incidental. Salary is what services an ESOP-backed loan, and
// that only works if payroll pays in the same dollars the pool lends. If this script ever
// deploys its own stablecoin, the product's central claim quietly stops being true.
//
// The treasury starts as the operator and is expected to become a Privy server wallet whose
// key quorum gates payroll runs. `setTreasury` exists for exactly that handover, so the
// contract does not have to be redeployed when the wallet is created.
//
//   npm run testnet:deploy-payroll
//   TREASURY=0x... npm run testnet:deploy-payroll

import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { ethers as ethersLib } from "ethers";

const GAS = { gasLimit: 3_000_000n };
const REPO_ROOT = process.env.TOKENIZE_IT_ROOT ?? path.resolve(__dirname, "../../../../../../..");
const DEPLOYMENTS = path.join(REPO_ROOT, "deployments", "hedera-testnet.json");

function step(n: string, msg: string) {
  console.log(`\n\x1b[36m[${n}]\x1b[0m ${msg}`);
}

async function main() {
  const [operator] = await ethers.getSigners();
  const record = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
  if (!record.lending?.stablecoin?.address) {
    throw new Error("No stablecoin recorded. Run testnet:deploy-lending first — payroll must share it.");
  }

  const stable: string = record.lending.stablecoin.address;
  const token: string = record.esopToken.address;
  const treasury = process.env.TREASURY ?? operator.address;
  if (!ethersLib.isAddress(treasury)) throw new Error(`TREASURY is not an address: ${treasury}`);

  console.log("=".repeat(72));
  console.log("  tokenize-it -- deploy PayrollDisburser");
  console.log("=".repeat(72));
  console.log(`  operator   ${operator.address}`);
  console.log(`  stablecoin ${stable}  (shared with the lending pool)`);
  console.log(`  esop token ${token}   (consulted for its allowlist only)`);
  console.log(`  treasury   ${treasury}`);

  step("1", "Deploying...");
  const Payroll = await ethers.getContractFactory("PayrollDisburser");
  const payroll = await Payroll.deploy(stable, token, treasury, operator.address);
  await payroll.waitForDeployment();
  const address = await payroll.getAddress();
  const tx = payroll.deploymentTransaction();
  console.log(`  -> ${address}`);

  step("2", "Appointing the payout relayer...");
  // Employees hold wallets that have never paid gas. Without a relayer able to call
  // withdrawFor, salary would be earned on chain and unreachable in practice.
  const relayer: string | undefined = process.env.RELAYER_ADDRESS ?? record.relayer?.address;
  if (relayer && ethersLib.isAddress(relayer)) {
    await (await payroll.setPayoutRelayer(relayer, true, GAS)).wait();
    console.log(`  -> ${relayer} may deliver salary on an employee's behalf`);
  } else {
    console.log("  -> none recorded; employees would have to pay their own gas to be paid");
  }

  step("3", "Checking the compliance tie...");
  const esop = await ethers.getContractAt("IAsset", token);
  const demo: string | undefined = record.grants?.[0]?.employee;
  if (demo) {
    console.log(`  -> demo employee ${demo} allowlisted: ${await esop.isInControlList(demo)}`);
  }
  console.log(`  -> a run pays only allowlisted employees; that check is in bytecode, not a policy`);

  // Assignment, not replacement: `org` holds the Privy quorum, policy and treasury wallet
  // ids, which this script did not create and cannot recreate. Overwriting the whole object
  // wiped them on a redeploy and left the treasury unreachable -- a wallet holding real
  // HBAR, with the only pointer to it gone.
  record.payroll = {
    ...(record.payroll ?? {}),
    address,
    contractIdentifier: "contracts/tokenize-it/payroll/PayrollDisburser.sol:PayrollDisburser",
    creationTxHash: tx?.hash ?? null,
    admin: operator.address,
    treasury,
    stablecoin: stable,
    payoutRelayer: relayer ?? null,
    note: "Treasury becomes a Privy server wallet with a key quorum; setTreasury handles that handover.",
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(DEPLOYMENTS, JSON.stringify(record, null, 2) + "\n");

  if (record.payroll.org?.policyId) {
    console.log("\n\x1b[33m  The treasury policy still names the PREVIOUS payroll contract.\x1b[0m");
    console.log("  Until it is re-pointed, a quorum-approved run is refused with policy_violation:");
    console.log("    node apps/web/scripts/sync-payroll-policy.mjs");
  }

  console.log("\n" + "=".repeat(72));
  console.log("  Recorded in deployments/hedera-testnet.json");
  console.log(`  Verify: npm run verify -- ${address} --contract ${record.payroll.contractIdentifier}`);
  console.log("=".repeat(72));
}

main().catch((e) => {
  console.error("\n\x1b[31mFAILED\x1b[0m", e.message ?? e);
  process.exitCode = 1;
});
