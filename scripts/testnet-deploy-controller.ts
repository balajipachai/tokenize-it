// SPDX-License-Identifier: Apache-2.0
//
// Deploys ESOPVestingController against the ESOP token from deployments/, onboards it
// as a token holder, funds it with the option pool, wires the dispute machinery, and
// seeds demo grants so both apps have real on-chain data to read.
//
// Re-runnable. The pool is already minted to `maxSupply`, so a redeploy funds the new
// controller by moving tokens across from the previous one and from the treasury rather
// than minting — the cap is hard, and a redeploy must not need headroom that is gone.
//
//   npm run testnet:deploy-controller

import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { ethers as ethersLib } from "ethers";
import { ATS_ROLES } from "@scripts";
import { IAsset } from "@contract-types";

const PARTITION = "0x0000000000000000000000000000000000000000000000000000000000000001";
const EMPTY_HEX = "0x";
const MAX_UINT256 = ethersLib.MaxUint256;

const POOL_TARGET = Number(process.env.POOL_TARGET ?? 500_000);
const CLIFF_AMOUNT = Number(process.env.DEMO_CLIFF_AMOUNT ?? 1_200);
const TRANCHE_AMOUNT = Number(process.env.DEMO_TRANCHE_AMOUNT ?? 100);
const TRANCHE_COUNT = Number(process.env.DEMO_TRANCHE_COUNT ?? 12);

// Compressed schedule: the cliff lands during the demo, later tranches stay locked.
const CLIFF_DELAY = Number(process.env.DEMO_CLIFF_SECONDS ?? 120);
const TRANCHE_SPACING = Number(process.env.DEMO_TRANCHE_SECONDS ?? 900);

// Seconds for a demo; a real deployment would use weeks.
const DISPUTE_WINDOW = Number(process.env.DISPUTE_WINDOW_SECONDS ?? 180);

const REPO_ROOT = process.env.TOKENIZE_IT_ROOT ?? path.resolve(__dirname, "../../../../../../..");
const DEPLOYMENTS = path.join(REPO_ROOT, "deployments", "hedera-testnet.json");

/**
 * Funding is the expensive call in this script: each tranche is a separate ATS lock at
 * roughly 425k gas, measured in Phase 1.
 *
 * Both numbers below are deliberate. The batch is small enough that 8 locks stay well
 * inside Hedera's 15M per-transaction ceiling, and the limit is the ceiling itself rather
 * than an estimate -- Hedera charges gas USED, not gas OFFERED, so a high limit costs
 * nothing while a tight one costs the run. This previously ran on the estimator, which
 * offered 5,343,980 for a 13-tranche grant and ran out having used 5,336,742: 99.86% of
 * the limit, reverting with empty revert data and no explanation.
 */
const FUND_BATCH = 8;
const FUND_GAS = { gasLimit: 15_000_000n };

function step(n: string, msg: string) {
  console.log(`\n\x1b[36m[${n}]\x1b[0m ${msg}`);
}

async function main() {
  const [operator] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();

  const record = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
  const tokenAddress: string = record.esopToken.address;
  const previous = record.esopVestingController?.address as string | undefined;

  console.log("=".repeat(72));
  console.log("  tokenize-it -- deploy ESOPVestingController + seed demo data");
  console.log("=".repeat(72));
  console.log(`  operator ${operator.address}`);
  console.log(`  chainId  ${net.chainId}`);
  console.log(`  token    ${tokenAddress}`);
  if (previous) console.log(`  previous ${previous}`);

  const token = (await ethers.getContractAt("IAsset", tokenAddress)) as unknown as IAsset;

  step("1", `Deploying ESOPVestingController (dispute window ${DISPUTE_WINDOW}s)...`);
  const Factory = await ethers.getContractFactory("ESOPVestingController");
  const controller = await Factory.deploy(tokenAddress, operator.address, DISPUTE_WINDOW);
  await controller.waitForDeployment();
  const controllerAddress = await controller.getAddress();
  const deployTx = controller.deploymentTransaction();
  console.log(`  -> ${controllerAddress}`);

  step("2", "Granting the controller its ATS roles...");
  const partitionRole = ethersLib.keccak256(
    ethersLib.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32"],
      [ATS_ROLES.ROLE_PROTECTED_PARTITIONS_PARTICIPANT, PARTITION],
    ),
  );
  for (const role of [ATS_ROLES.ROLE_LOCKER, ATS_ROLES.ROLE_CONTROLLER, ATS_ROLES.ROLE_WILD_CARD, partitionRole]) {
    await (await token.grantRole(role, controllerAddress)).wait();
  }
  console.log("  -> LOCKER, CONTROLLER, WILD_CARD, PROTECTED_PARTITIONS_PARTICIPANT");

  step("3", "Onboarding the controller as a token holder (KYC + allowlist)...");
  if (Number(await token.getKycStatusFor(controllerAddress)) !== 1) {
    await (await token.grantKyc(controllerAddress, "", 0, MAX_UINT256, operator.address)).wait();
  }
  if (!(await token.isInControlList(controllerAddress))) {
    await (await token.addToControlList(controllerAddress)).wait();
  }
  console.log("  -> onboarded");

  step("4", `Funding the controller with ${POOL_TARGET.toLocaleString("en-US")} options...`);
  let held = Number(await token.balanceOfByPartition(PARTITION, controllerAddress));
  if (previous && held < POOL_TARGET) {
    // Recover the previous controller's unallocated pool rather than minting more.
    const old = await ethers.getContractAt("ESOPVestingController", previous);
    const stranded = Number(await token.balanceOfByPartition(PARTITION, previous));
    const move = Math.min(stranded, POOL_TARGET - held);
    if (move > 0) {
      await (await old.returnToTreasury(PARTITION, controllerAddress, move)).wait();
      held += move;
      console.log(`  -> recovered ${move.toLocaleString("en-US")} from the previous controller`);
    }
  }
  if (held < POOL_TARGET) {
    const fromTreasury = Math.min(
      Number(await token.balanceOfByPartition(PARTITION, operator.address)),
      POOL_TARGET - held,
    );
    if (fromTreasury > 0) {
      await (
        await token.transferByPartition(PARTITION, { to: controllerAddress, value: fromTreasury }, EMPTY_HEX)
      ).wait();
      held += fromTreasury;
      console.log(`  -> moved ${fromTreasury.toLocaleString("en-US")} from the treasury`);
    }
  }
  console.log(`  -> controller holds ${held.toLocaleString("en-US")}`);

  step("5", "Wiring the dispute machinery...");
  // Arbiters must be multisigs. This is a Safe-shaped STAND-IN so the appeal path can be
  // demonstrated end to end; it is not a Safe. A real deployment points setArbiter at an
  // actual multisig and never deploys this.
  const Mock = await ethers.getContractFactory("MockMultisig");
  const arbiter = await Mock.deploy(2, operator.address);
  await arbiter.waitForDeployment();
  const arbiterAddress = await arbiter.getAddress();
  await (await controller.setArbiter(arbiterAddress, true)).wait();
  console.log(`  -> demo arbiter (2-of-N stand-in, NOT a Safe): ${arbiterAddress}`);

  const relayer = process.env.RELAYER_ADDRESS;
  if (relayer && ethersLib.isAddress(relayer)) {
    await (await controller.setDisputeRelayer(relayer, true)).wait();
    console.log(`  -> dispute relayer: ${relayer}`);
  }

  const hr = process.env.HR;
  if (hr && ethersLib.isAddress(hr)) {
    await (await controller.setGrantAdmin(hr, true)).wait();
    console.log(`  -> grant admin: ${hr}`);
  }

  // ---------------------------------------------------------------------------
  // Written HERE, before seeding, and deliberately.
  //
  // The record used to be written only at the very end, after the grants. Seeding is the
  // longest and most failure-prone part of this script -- dozens of transactions, each one
  // a chance to run out of gas -- and a failure there meant the file never learned about a
  // controller that by then held the entire option pool, moved across from its predecessor.
  // The result was a deployments file pointing at an empty contract while the real one sat
  // unrecorded, which is a genuinely unpleasant thing to unpick by hand.
  //
  // Grants are appended afterwards. Losing the grant list to a crash is recoverable; losing
  // the address of the contract holding 500,000 options is not.
  // ---------------------------------------------------------------------------
  record.previousControllers = [...(record.previousControllers ?? []), ...(previous ? [previous] : [])];
  record.esopVestingController = {
    address: controllerAddress,
    contractIdentifier: "contracts/tokenize-it/ESOPVestingController.sol:ESOPVestingController",
    creationTxHash: deployTx?.hash ?? null,
    admin: operator.address,
    disputeWindowSeconds: DISPUTE_WINDOW,
    arbiter: {
      address: arbiterAddress,
      note: "2-of-N stand-in so the appeal path can be exercised. NOT a Safe; replace in production.",
    },
  };
  record.grants = [];
  delete record.demoGrant; // superseded by `grants`
  fs.writeFileSync(DEPLOYMENTS, JSON.stringify(record, null, 2) + "\n");
  console.log(`  recorded in deployments/hedera-testnet.json`);

  step("6", "Seeding grants...");
  const employees = (process.env.DEMO_EMPLOYEES ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter((a) => ethersLib.isAddress(a));

  const grants: unknown[] = [];
  for (const employee of employees) {
    if (Number(await token.getKycStatusFor(employee)) !== 1) {
      const at = Math.floor(Date.now() / 1000);
      const vcId = `did:hedera:testnet:${operator.address}#kyc-${employee.slice(2, 10).toLowerCase()}-${at}`;
      await (await token.grantKyc(employee, vcId, at, at + 365 * 24 * 60 * 60, operator.address)).wait();
    }
    if (!(await token.isInControlList(employee))) {
      await (await token.addToControlList(employee)).wait();
    }

    const at = Math.floor(Date.now() / 1000);
    const amounts = [CLIFF_AMOUNT];
    const dates = [at + CLIFF_DELAY];
    for (let i = 1; i <= TRANCHE_COUNT; i++) {
      amounts.push(TRANCHE_AMOUNT);
      dates.push(at + CLIFF_DELAY + i * TRANCHE_SPACING);
    }

    const grantId = await controller.nextGrantId();
    await (await controller.createGrant(employee, PARTITION, amounts, dates, FUND_GAS)).wait();
    for (;;) {
      await (await controller.fundTranches(grantId, FUND_BATCH, FUND_GAS)).wait();
      if (Number((await controller.getGrant(grantId)).status) === 2) break;
    }
    const total = amounts.reduce((a, b) => a + b, 0);
    console.log(`  -> grant #${grantId} to ${employee}: ${total} options over ${amounts.length} tranches`);
    grants.push({
      grantId: Number(grantId),
      employee,
      totalAmount: total,
      trancheCount: amounts.length,
      cliffAt: dates[0],
      createdAt: new Date().toISOString(),
    });
  }

  record.grants = grants;
  fs.writeFileSync(DEPLOYMENTS, JSON.stringify(record, null, 2) + "\n");

  console.log("\n" + "=".repeat(72));
  console.log("  Recorded in deployments/hedera-testnet.json");
  console.log(`  Verify: npm run verify -- ${controllerAddress} --contract ${record.esopVestingController.contractIdentifier}`);
  console.log("=".repeat(72));
}

main().catch((e) => {
  console.error("\n\x1b[31mFAILED\x1b[0m", e);
  process.exitCode = 1;
});
