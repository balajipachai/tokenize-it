// SPDX-License-Identifier: Apache-2.0
//
// Issues an ESOP grant to an arbitrary address against the already-deployed
// controller. This is what you run after logging into the portal, to grant
// options to the Privy embedded wallet the portal shows you.
//
//   EMPLOYEE=0x... npm run testnet:grant
//   EMPLOYEE=0x... DEMO_CLIFF_SECONDS=60 npm run testnet:grant

import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { ethers as ethersLib } from "ethers";
import { IAsset } from "@contract-types";

const PARTITION = "0x0000000000000000000000000000000000000000000000000000000000000001";
const MAX_UINT256 = ethersLib.MaxUint256;

const CLIFF_AMOUNT = Number(process.env.DEMO_CLIFF_AMOUNT ?? 1_200);
const TRANCHE_AMOUNT = Number(process.env.DEMO_TRANCHE_AMOUNT ?? 100);
const TRANCHE_COUNT = Number(process.env.DEMO_TRANCHE_COUNT ?? 12);
const CLIFF_DELAY = Number(process.env.DEMO_CLIFF_SECONDS ?? 120);
const TRANCHE_SPACING = Number(process.env.DEMO_TRANCHE_SECONDS ?? 900);

const REPO_ROOT = process.env.TOKENIZE_IT_ROOT ?? path.resolve(__dirname, "../../../../../../..");
const DEPLOYMENTS = path.join(REPO_ROOT, "deployments", "hedera-testnet.json");

async function main() {
  const employee = process.env.EMPLOYEE;
  if (!employee || !ethersLib.isAddress(employee)) {
    throw new Error("Set EMPLOYEE to the address to grant to, e.g. EMPLOYEE=0x... npm run testnet:grant");
  }

  const [operator] = await ethers.getSigners();
  const record = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
  if (!record.esopVestingController) throw new Error("No controller recorded. Run testnet:deploy-controller first.");

  const token = (await ethers.getContractAt("IAsset", record.esopToken.address)) as unknown as IAsset;
  const controller = await ethers.getContractAt("ESOPVestingController", record.esopVestingController.address);

  console.log(`Granting to ${employee}`);
  console.log(`  token      ${record.esopToken.address}`);
  console.log(`  controller ${record.esopVestingController.address}`);

  // A holder must clear KYC and the allowlist before they can receive anything.
  const kyc = await token.getKycStatusFor(employee);
  if (Number(kyc) !== 1) {
    await (await token.grantKyc(employee, "", 0, MAX_UINT256, operator.address)).wait();
    console.log("  -> KYC granted");
  }
  if (!(await token.isInControlList(employee))) {
    await (await token.addToControlList(employee)).wait();
    console.log("  -> allowlisted");
  }

  const now = Math.floor(Date.now() / 1000);
  const amounts = [CLIFF_AMOUNT];
  const dates = [now + CLIFF_DELAY];
  for (let i = 1; i <= TRANCHE_COUNT; i++) {
    amounts.push(TRANCHE_AMOUNT);
    dates.push(now + CLIFF_DELAY + i * TRANCHE_SPACING);
  }

  const grantId = await controller.nextGrantId();
  await (await controller.createGrant(employee, PARTITION, amounts, dates)).wait();
  for (;;) {
    await (await controller.fundTranches(grantId, 20)).wait();
    if (Number((await controller.getGrant(grantId)).status) === 2) break;
  }

  const total = amounts.reduce((a, b) => a + b, 0);
  console.log(`\n  grant #${grantId}: ${total} options across ${amounts.length} tranches`);
  console.log(`  cliff of ${CLIFF_AMOUNT} vests in ${CLIFF_DELAY}s, then ${TRANCHE_AMOUNT} every ${TRANCHE_SPACING}s`);

  record.grants = record.grants ?? [];
  record.grants.push({
    grantId: Number(grantId),
    employee,
    totalAmount: total,
    trancheCount: amounts.length,
    cliffAt: dates[0],
    createdAt: new Date().toISOString(),
  });
  fs.writeFileSync(DEPLOYMENTS, JSON.stringify(record, null, 2) + "\n");
  console.log("  recorded in deployments/hedera-testnet.json");
}

main().catch((e) => {
  console.error("\n\x1b[31mFAILED\x1b[0m", e.message ?? e);
  process.exitCode = 1;
});
