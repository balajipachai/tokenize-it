// SPDX-License-Identifier: Apache-2.0
//
// Deploys ESOPVestingController against the ESOP token from deployments/, onboards
// it as a token holder, funds it with the option pool, and seeds a demo grant so the
// employee portal has real on-chain data to read.
//
// Vesting is compressed (minutes, not years) so a demo can show a cliff actually
// landing. Amounts and cadence come from env so a fresh demo is one command away.
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

const POOL_TO_CONTROLLER = 500_000;
const CLIFF_AMOUNT = 1_200;
const TRANCHE_AMOUNT = 100;
const TRANCHE_COUNT = 12;

// Compressed schedule: the cliff lands during the demo, later tranches stay locked.
const CLIFF_DELAY = Number(process.env.DEMO_CLIFF_SECONDS ?? 120);
const TRANCHE_SPACING = Number(process.env.DEMO_TRANCHE_SECONDS ?? 900);
// Seconds for a demo; a real deployment would use weeks.
const DISPUTE_WINDOW = Number(process.env.DISPUTE_WINDOW_SECONDS ?? 120);

const REPO_ROOT = process.env.TOKENIZE_IT_ROOT ?? path.resolve(__dirname, "../../../../../../..");
const DEPLOYMENTS = path.join(REPO_ROOT, "deployments", "hedera-testnet.json");

function step(n: string, msg: string) {
  console.log(`\n\x1b[36m[${n}]\x1b[0m ${msg}`);
}

async function main() {
  const [operator] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();

  const record = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
  const tokenAddress: string = record.esopToken.address;

  console.log("=".repeat(72));
  console.log("  tokenize-it -- deploy ESOPVestingController + seed a demo grant");
  console.log("=".repeat(72));
  console.log(`  operator ${operator.address}`);
  console.log(`  chainId  ${net.chainId}`);
  console.log(`  token    ${tokenAddress}`);

  const token = (await ethers.getContractAt("IAsset", tokenAddress)) as unknown as IAsset;

  step("1", "Deploying ESOPVestingController...");
  const Factory = await ethers.getContractFactory("ESOPVestingController");
  const controller = await Factory.deploy(tokenAddress, operator.address, DISPUTE_WINDOW);
  await controller.waitForDeployment();
  const controllerAddress = await controller.getAddress();
  const deployTx = controller.deploymentTransaction();
  console.log(`  -> ${controllerAddress}`);

  step("2", "Granting the controller its ATS roles...");
  // It holds the pool, creates locks, force-releases and burns, and writes to a
  // protected partition -- so it needs all four.
  const partitionRole = ethersLib.keccak256(
    ethersLib.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32"],
      [ATS_ROLES.ROLE_PROTECTED_PARTITIONS_PARTICIPANT, PARTITION],
    ),
  );
  for (const role of [
    ATS_ROLES.ROLE_LOCKER,
    ATS_ROLES.ROLE_CONTROLLER,
    ATS_ROLES.ROLE_WILD_CARD,
    partitionRole,
  ]) {
    await (await token.grantRole(role, controllerAddress)).wait();
  }
  console.log("  -> LOCKER, CONTROLLER, WILD_CARD, PROTECTED_PARTITIONS_PARTICIPANT");

  step("3", "Onboarding the controller as a token holder (KYC + allowlist)...");
  // It receives and holds the pool, so the compliance stack treats it like a person.
  await (await token.grantKyc(controllerAddress, "", 0, MAX_UINT256, operator.address)).wait();
  await (await token.addToControlList(controllerAddress)).wait();
  console.log("  -> onboarded");

  step("4", `Transferring ${POOL_TO_CONTROLLER.toLocaleString("en-US")} options to the controller...`);
  await (
    await token.transferByPartition(PARTITION, { to: controllerAddress, value: POOL_TO_CONTROLLER }, EMPTY_HEX)
  ).wait();
  console.log(`  -> controller holds ${await token.balanceOfByPartition(PARTITION, controllerAddress)}`);

  step("5", "Onboarding the demo employee...");
  // Generated fresh and never funded -- the same position as a Privy embedded wallet.
  const employee = ethersLib.Wallet.createRandom();
  await (await token.grantKyc(employee.address, "", 0, MAX_UINT256, operator.address)).wait();
  await (await token.addToControlList(employee.address)).wait();
  console.log(`  -> ${employee.address}`);
  console.log(`     private key (DEMO ONLY, testnet): ${employee.privateKey}`);

  step("6", "Creating and funding the demo grant...");
  const now = Math.floor(Date.now() / 1000);
  const amounts = [CLIFF_AMOUNT];
  const dates = [now + CLIFF_DELAY];
  for (let i = 1; i <= TRANCHE_COUNT; i++) {
    amounts.push(TRANCHE_AMOUNT);
    dates.push(now + CLIFF_DELAY + i * TRANCHE_SPACING);
  }

  const grantId = await controller.nextGrantId();
  await (await controller.createGrant(employee.address, PARTITION, amounts, dates)).wait();
  for (;;) {
    await (await controller.fundTranches(grantId, 20)).wait();
    const g = await controller.getGrant(grantId);
    if (Number(g.status) === 2) break; // Active
  }
  const grant = await controller.getGrant(grantId);
  console.log(`  -> grant #${grantId}: ${grant.totalAmount} options across ${amounts.length} tranches`);
  console.log(`     cliff vests in ${CLIFF_DELAY}s, then one tranche every ${TRANCHE_SPACING}s`);

  record.esopVestingController = {
    address: controllerAddress,
    contractIdentifier: "contracts/tokenize-it/ESOPVestingController.sol:ESOPVestingController",
    creationTxHash: deployTx?.hash ?? null,
    admin: operator.address,
  };
  record.demoGrant = {
    grantId: Number(grantId),
    employee: employee.address,
    partition: PARTITION,
    totalAmount: Number(grant.totalAmount),
    trancheCount: amounts.length,
    cliffAt: dates[0],
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(DEPLOYMENTS, JSON.stringify(record, null, 2) + "\n");

  console.log("\n" + "=".repeat(72));
  console.log("  Recorded in deployments/hedera-testnet.json");
  console.log(`  Verify with: npm run verify -- ${controllerAddress} --contract ${record.esopVestingController.contractIdentifier}`);
  console.log("=".repeat(72));
}

main().catch((e) => {
  console.error("\n\x1b[31mFAILED\x1b[0m", e);
  process.exitCode = 1;
});
