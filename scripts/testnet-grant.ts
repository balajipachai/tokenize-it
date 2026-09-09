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

/**
 * Explicit gas for ATS token writes.
 *
 * Hedera's estimator under-counts, and `revokeKyc` proved it the expensive way: 97,641 gas
 * burned of a 98,458 limit -- 99.2% consumed, empty revert data -- while the identical call
 * succeeded under `staticCall`. That is out of gas, not a rejection, and an out-of-gas revert
 * tells you nothing about why.
 *
 * Over-asking is free: Hedera charges on gas USED, not the limit offered (the same call
 * offered 120,000 and 900,000 cost an identical 0.03710687 HBAR). So be generous here rather
 * than clever. Note that setting gasMultiplier in the Hardhat network config does NOT cover
 * these calls -- measured, the limit was unchanged -- so it has to be passed per call.
 */
const GAS = { gasLimit: 900_000n };

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
  //
  // What is real here, and what is stubbed, because this gets asked:
  //   * ATS enforces the gate on-chain -- a transfer to a non-KYC'd address reverts.
  //   * `grantKyc` reverts unless the attesting issuer is registered via
  //     ssiManagement.addIssuer, so credentials cannot be conjured by any random key.
  //   * Revocation is retroactive: drop the issuer and every credential it signed
  //     reads NOT_GRANTED immediately (KycStorageWrapper checks isIssuer on read).
  //   * What a production deployment swaps in is the off-chain provider that actually
  //     verifies the human and mints the credential. The contract does not change --
  //     only who holds ROLE_KYC and what `vcId` points at.
  if (!(await token.isIssuer(operator.address))) {
    await (await token.addIssuer(operator.address, GAS)).wait();
    console.log("  -> registered KYC issuer");
  }

  // Earlier runs granted KYC with an empty vcId and a 0..MAX window, which is a
  // credential that references nothing. Re-issue those so every holder carries a
  // traceable attestation with a real validity period.
  const existing = await token.getKycFor(employee);
  if (Number(existing.status) === 1 && existing.vcId === "") {
    await (await token.revokeKyc(employee, GAS)).wait();
    console.log("  -> revoked placeholder credential");
  }

  const kyc = await token.getKycStatusFor(employee);
  if (Number(kyc) !== 1) {
    const now = Math.floor(Date.now() / 1000);
    const validTo = now + 365 * 24 * 60 * 60;
    // A real credential reference rather than an empty string, so the portal can show
    // WHICH attestation admitted this holder and a reviewer can trace it.
    const vcId = `did:hedera:testnet:${operator.address}#kyc-${employee.slice(2, 10).toLowerCase()}-${now}`;
    await (await token.grantKyc(employee, vcId, now, validTo, operator.address, GAS)).wait();
    console.log(`  -> KYC granted`);
    console.log(`     credential ${vcId}`);
    console.log(`     valid until ${new Date(validTo * 1000).toISOString().slice(0, 10)}`);
  }
  if (!(await token.isInControlList(employee))) {
    await (await token.addToControlList(employee, GAS)).wait();
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
