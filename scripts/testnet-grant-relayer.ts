// SPDX-License-Identifier: Apache-2.0
//
// Authorises the portal's relayer to submit employees' signed holds.
//
// Why this is needed at all: `protectedCreateHoldByPartition` is gated on
//
//     onlyRole(ProtectedPartitionsStorageWrapper.protectedPartitionsRole(_partition))
//
// so the *caller* — our relayer, not the employee — must hold a partition-specific role.
// Spike #2 missed this because the operator signed and submitted, and the operator holds
// every role. Split those two jobs, as the portal does, and the gate appears.
//
// What the role does and does not permit, because this is the trust boundary:
//   - It does NOT let the relayer move anyone's tokens. Every call still carries an EIP-712
//     signature from the token holder over the exact hold — amount, escrow, expiry, and the
//     borrow amount in `data`. Without that signature the call reverts.
//   - It DOES decide who may relay. A relayer that stops submitting is a liveness problem,
//     not a safety one: employees keep custody either way, and the issuer can revoke this
//     role at any time.
// That is the whole reason ATS gates the relay step separately from the signature check.
//
//   npm run testnet:grant-relayer
//   RELAYER=0x... npm run testnet:grant-relayer   # to authorise a different one

import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { ethers as ethersLib } from "ethers";
import { IAsset } from "@contract-types";

/** ROLE_PROTECTED_PARTITIONS_PARTICIPANT, from ATS contracts/constants/roles.sol. */
const ROLE_PROTECTED_PARTITIONS_PARTICIPANT =
  "0xda17771b6b3d06197fabbe8db1d7586004df4869992b9c7c7fccec5f36dcf604";

const REPO_ROOT = process.env.TOKENIZE_IT_ROOT ?? path.resolve(__dirname, "../../../../../../..");
const DEPLOYMENTS = path.join(REPO_ROOT, "deployments", "hedera-testnet.json");

/** Packed, not ABI-encoded — ATS uses `encodePacked` here and the two differ. */
function partitionRole(partition: string): string {
  return ethersLib.keccak256(
    ethersLib.solidityPacked(["bytes32", "bytes32"], [ROLE_PROTECTED_PARTITIONS_PARTICIPANT, partition]),
  );
}

async function main() {
  const [operator] = await ethers.getSigners();
  const record = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));

  const relayer = process.env.RELAYER ?? record.relayer?.address;
  if (!relayer || !ethersLib.isAddress(relayer)) {
    throw new Error("No relayer address. Set RELAYER=0x... or record one in deployments/hedera-testnet.json");
  }

  const partition: string = record.esopToken.partition;
  const token = (await ethers.getContractAt("IAsset", record.esopToken.address)) as unknown as IAsset;
  const role = partitionRole(partition);

  console.log("Authorising the portal relayer to submit signed holds");
  console.log(`  token     ${record.esopToken.address}`);
  console.log(`  partition ${partition}`);
  console.log(`  relayer   ${relayer}`);
  console.log(`  role      ${role}`);
  console.log(`  signing as ${operator.address}`);

  if (await token.hasRole(role, relayer)) {
    console.log("\n  -> already held, nothing to do");
    return;
  }

  await (await token.grantRole(role, relayer)).wait();
  console.log("\n  -> granted");

  if (!(await token.hasRole(role, relayer))) {
    throw new Error("grantRole reported success but the role is still not held.");
  }
  console.log("  -> confirmed on chain");
}

main().catch((e) => {
  console.error("\n\x1b[31mFAILED\x1b[0m", e.message ?? e);
  process.exitCode = 1;
});
