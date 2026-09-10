// SPDX-License-Identifier: Apache-2.0
//
// Deploys the lending stack against the ESOP token from deployments/: a testnet
// stablecoin, the NAV oracle, and the pool — then onboards the pool as a token holder
// and seeds it with liquidity.
//
// The peg feed points at the REAL Chainlink USDC/USD feed on Hedera testnet, not a
// stand-in. The NAV feed is ours, because a private company's share price has no public
// source; it speaks the same AggregatorV3 interface so a listed issuer swaps it out.
//
//   npm run testnet:deploy-lending

import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { ethers as ethersLib } from "ethers";
import { IAsset } from "@contract-types";

const PARTITION = "0x0000000000000000000000000000000000000000000000000000000000000001";
const MAX_UINT256 = ethersLib.MaxUint256;

/**
 * Chainlink USDC/USD, live on Hedera testnet — verified answering in §5.3.2 of the plan.
 * Its heartbeat is slow (observed ~17h between updates), which is exactly why staleness
 * bounds are per feed rather than one global constant.
 */
const CHAINLINK_USDC_USD = "0xb632a7e7e02d76c0Ce99d9C62c7a2d1B5F92B6B5";

/** ROLE_PROTECTED_PARTITIONS_PARTICIPANT, from ATS contracts/constants/roles.sol. */
const ROLE_PROTECTED_PARTITIONS_PARTICIPANT =
  "0xda17771b6b3d06197fabbe8db1d7586004df4869992b9c7c7fccec5f36dcf604";

const DAY = 24 * 60 * 60;
const NAV_USD = process.env.NAV_USD ?? "2.00";
const NAV_BASIS = process.env.NAV_BASIS ?? "409A valuation 2026-Q1 (demo)";
const LIQUIDITY = Number(process.env.POOL_LIQUIDITY ?? 250_000);

const REPO_ROOT = process.env.TOKENIZE_IT_ROOT ?? path.resolve(__dirname, "../../../../../../..");
const DEPLOYMENTS = path.join(REPO_ROOT, "deployments", "hedera-testnet.json");

function step(n: string, msg: string) {
  console.log(`\n\x1b[36m[${n}]\x1b[0m ${msg}`);
}

async function main() {
  const [operator] = await ethers.getSigners();
  const record = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
  const tokenAddress: string = record.esopToken.address;

  console.log("=".repeat(72));
  console.log("  tokenize-it -- deploy the lending stack");
  console.log("=".repeat(72));
  console.log(`  operator ${operator.address}`);
  console.log(`  token    ${tokenAddress}`);

  const token = (await ethers.getContractAt("IAsset", tokenAddress)) as unknown as IAsset;

  // The stablecoin and the NAV oracle are REUSED when they already exist, and only deployed
  // on a first run. Redeploying the pool is routine -- its own source changes -- but minting a
  // fresh stablecoin alongside it would silently strand every balance held in the old one and,
  // worse, split payroll and lending across two different dollars. Salary repaying a loan is
  // the whole story; it only works if both legs spend the same token.
  //
  // Set FRESH_STABLECOIN=1 to force new ones.
  const fresh = process.env.FRESH_STABLECOIN === "1";
  const existing = record.lending;

  let usdcAddress: string;
  if (!fresh && existing?.stablecoin?.address) {
    usdcAddress = existing.stablecoin.address;
    step("1", `Reusing the existing testnet stablecoin at ${usdcAddress}`);
    console.log("  -> balances and payroll wiring survive the redeploy");
  } else {
    step("1", "Deploying the testnet stablecoin...");
    const USDC = await ethers.getContractFactory("MockUSDC");
    const usdcContract = await USDC.deploy();
    await usdcContract.waitForDeployment();
    usdcAddress = await usdcContract.getAddress();
    console.log(`  -> ${usdcAddress}`);
  }
  const usdc = await ethers.getContractAt("MockUSDC", usdcAddress);

  let navAddress: string;
  if (!fresh && existing?.navOracle?.address) {
    navAddress = existing.navOracle.address;
    step("2", `Reusing the existing NAV oracle at ${navAddress}`);
    console.log(`  -> keeps the published price history rather than restarting it`);
  } else {
    step("2", `Deploying the NAV oracle at $${NAV_USD} per share...`);
    // 30% max single move: enough for a real revaluation, tight enough that a fat-fingered
    // price cannot reprice every outstanding loan in one call.
    const Nav = await ethers.getContractFactory("EsopNavOracle");
    const navContract = await Nav.deploy("ESOP / USD (Essential Links)", operator.address, 3_000);
    await navContract.waitForDeployment();
    navAddress = await navContract.getAddress();
    await (await navContract.publish(ethersLib.parseUnits(NAV_USD, 8), NAV_BASIS)).wait();
    console.log(`  -> ${navAddress}`);
    console.log(`     published ${NAV_USD} on basis "${NAV_BASIS}"`);
  }

  step("3", "Deploying the lending pool...");
  const Pool = await ethers.getContractFactory("ESOPLendingPool");
  const pool = await Pool.deploy(tokenAddress, usdcAddress, 6, operator.address);
  await pool.waitForDeployment();
  const poolAddress = await pool.getAddress();
  const poolTx = pool.deploymentTransaction();
  console.log(`  -> ${poolAddress}`);

  step("4", "Wiring the feeds...");
  // navMaxAge is deliberately long: an appraisal is annual by nature, so "stale" is its
  // normal condition and a market-feed threshold would brick the pool.
  await (await pool.setFeeds(navAddress, CHAINLINK_USDC_USD, 400 * DAY, 2 * DAY)).wait();
  console.log(`  -> NAV   ${navAddress} (ours, max age 400d)`);
  console.log(`  -> peg   ${CHAINLINK_USDC_USD} (Chainlink USDC/USD, max age 2d)`);

  step("5", "Onboarding the pool as a token holder...");
  // Required by spike #1: liquidation transfers shares to the pool, and a transfer to a
  // non-KYC'd, non-allowlisted address reverts. Compliance applies to contracts too.
  if (Number(await token.getKycStatusFor(poolAddress)) !== 1) {
    const at = Math.floor(Date.now() / 1000);
    const vcId = `did:hedera:testnet:${operator.address}#institution-lendingpool-${at}`;
    await (await token.grantKyc(poolAddress, vcId, at, at + 365 * DAY, operator.address)).wait();
    console.log("  -> KYC granted (as an institutional holder)");
  }
  if (!(await token.isInControlList(poolAddress))) {
    await (await token.addToControlList(poolAddress)).wait();
    console.log("  -> allowlisted");
  }

  // Lets the pool submit a borrower's signed hold itself, which is what makes
  // `pledgeAndBorrow` atomic — the hold and the loan land in one transaction, so a failure
  // cannot strand someone's shares against a loan that never opened.
  //
  // The role decides who may RELAY a signed hold, never whose tokens may move: every call
  // still carries the holder's own EIP-712 signature, so the pool cannot pledge anybody's
  // shares on its own initiative. Same grant the portal's relayer needs, same reasoning.
  const partitionRole = ethersLib.keccak256(
    ethersLib.solidityPacked(["bytes32", "bytes32"], [ROLE_PROTECTED_PARTITIONS_PARTICIPANT, PARTITION]),
  );
  if (!(await token.hasRole(partitionRole, poolAddress))) {
    await (await token.grantRole(partitionRole, poolAddress)).wait();
    console.log("  -> granted the partition participant role (enables pledgeAndBorrow)");
  }

  step("6", `Seeding ${LIQUIDITY.toLocaleString("en-US")} USDC of liquidity...`);
  const amount = ethersLib.parseUnits(String(LIQUIDITY), 6);
  await (await usdc.mint(operator.address, amount)).wait();
  await (await usdc.approve(poolAddress, MAX_UINT256)).wait();
  await (await pool.addLiquidity(amount)).wait();
  console.log(`  -> pool holds ${ethersLib.formatUnits(await pool.available(), 6)} USDC`);

  const sample = await pool.collateralValue(1_000);
  console.log(`\n  sanity: 1,000 shares value at ${ethersLib.formatUnits(sample, 6)} USDC`);

  record.lending = {
    pool: {
      address: poolAddress,
      contractIdentifier: "contracts/tokenize-it/lending/ESOPLendingPool.sol:ESOPLendingPool",
      creationTxHash: poolTx?.hash ?? null,
      admin: operator.address,
    },
    navOracle: {
      address: navAddress,
      contractIdentifier: "contracts/tokenize-it/lending/EsopNavOracle.sol:EsopNavOracle",
      navUsd: NAV_USD,
      basis: NAV_BASIS,
    },
    stablecoin: {
      address: usdcAddress,
      contractIdentifier: "contracts/tokenize-it/lending/MockUSDC.sol:MockUSDC",
      symbol: "USDC",
      decimals: 6,
      note: "Testnet stand-in. The interesting risk is in the collateral leg, not the cash leg.",
    },
    pegFeed: {
      address: CHAINLINK_USDC_USD,
      source: "Chainlink USDC/USD on Hedera testnet",
    },
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(DEPLOYMENTS, JSON.stringify(record, null, 2) + "\n");

  console.log("\n" + "=".repeat(72));
  console.log("  Recorded in deployments/hedera-testnet.json");
  console.log(`  Verify: npm run verify -- ${poolAddress} --contract ${record.lending.pool.contractIdentifier}`);
  console.log("=".repeat(72));
}

main().catch((e) => {
  console.error("\n\x1b[31mFAILED\x1b[0m", e);
  process.exitCode = 1;
});
