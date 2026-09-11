// SPDX-License-Identifier: Apache-2.0
//
// Gives an HR wallet the roles the issuer console needs, so staff sign issuer
// actions as themselves rather than sharing the operator key.
//
// This is a real issuer task, not a test shim: `terminate` records msg.sender as the
// deciding address, so per-person signing is what makes that attribution mean
// anything. Sharing one key would make every forfeiture trace to the same address.
//
//   HR=0xYourMetaMaskAddress npm run testnet:grant-roles

import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { ethers as ethersLib } from "ethers";
import { ATS_ROLES } from "@scripts";
import { IAsset } from "@contract-types";

const REPO_ROOT = process.env.TOKENIZE_IT_ROOT ?? path.resolve(__dirname, "../../../../../../..");
const DEPLOYMENTS = path.join(REPO_ROOT, "deployments", "hedera-testnet.json");

async function main() {
  const hr = process.env.HR;
  if (!hr || !ethersLib.isAddress(hr)) {
    throw new Error("Set HR to the wallet address, e.g. HR=0x... npm run testnet:grant-roles");
  }

  const [operator] = await ethers.getSigners();
  const record = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
  const token = (await ethers.getContractAt("IAsset", record.esopToken.address)) as unknown as IAsset;
  const controller = await ethers.getContractAt("ESOPVestingController", record.esopVestingController.address);

  console.log(`Granting issuer-console roles to ${hr}`);
  console.log(`  signing as ${operator.address}`);

  // Token-level roles: onboarding employees and suspending them.
  const tokenRoles: [string, string][] = [
    ["KYC", ATS_ROLES.ROLE_KYC],
    ["CONTROL_LIST", ATS_ROLES.ROLE_CONTROL_LIST],
    ["SSI_MANAGER", ATS_ROLES.ROLE_SSI_MANAGER],
    ["FREEZE_MANAGER", ATS_ROLES.ROLE_FREEZE_MANAGER],
  ];
  for (const [name, role] of tokenRoles) {
    if (!role) continue;
    if (await token.hasRole(role, hr)) {
      console.log(`  -> ${name} already held`);
      continue;
    }
    await (await token.grantRole(role, hr)).wait();
    console.log(`  -> ${name} granted`);
  }

  // Controller-level: creating grants, terminating, clawing back.
  if (await controller.isGrantAdmin(hr)) {
    console.log("  -> grant admin already");
  } else {
    await (await controller.setGrantAdmin(hr, true)).wait();
    console.log("  -> grant admin granted");
  }

  // The dispute relayer lets an employee contest a termination from an account that has
  // never held gas. Without it the recourse we built is only reachable by someone who can
  // already pay for a transaction, which is exactly the person who does not need help.
  const relayer: string | undefined = process.env.RELAYER_ADDRESS ?? record.relayer?.address;
  if (relayer && ethersLib.isAddress(relayer)) {
    if (await controller.isDisputeRelayer(relayer)) {
      console.log("  -> dispute relayer already");
    } else {
      await (await controller.setDisputeRelayer(relayer, true)).wait();
      console.log(`  -> dispute relayer granted to ${relayer}`);
    }
  } else {
    console.log("  -> no relayer recorded; employees could not contest gaslessly");
  }

  console.log("\nDone. Connect this wallet in the issuer console at http://localhost:3000/issuer");
}

main().catch((e) => {
  console.error("\n\x1b[31mFAILED\x1b[0m", e.message ?? e);
  process.exitCode = 1;
});
