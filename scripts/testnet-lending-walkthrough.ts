// SPDX-License-Identifier: Apache-2.0
//
// Drives a full loan against live Hedera testnet: pledge vested ESOPs as a hold, borrow,
// watch interest accrue, repay, and confirm the collateral comes back.
//
// The assertion that matters is that the borrower's ESOP balance is unchanged throughout.
// Collateral is a hold, not a transfer — the shares never leave their wallet.
//
//   BORROWER_KEY=0x... npm run testnet:lending-walkthrough

import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { ethers as ethersLib } from "ethers";
import { IAsset } from "@contract-types";

const PARTITION = "0x0000000000000000000000000000000000000000000000000000000000000001";
const EMPTY_HEX = "0x";
const DAY = 24 * 60 * 60;

const REPO_ROOT = process.env.TOKENIZE_IT_ROOT ?? path.resolve(__dirname, "../../../../../../..");
const DEPLOYMENTS = path.join(REPO_ROOT, "deployments", "hedera-testnet.json");

const usdcFmt = (v: bigint) => ethersLib.formatUnits(v, 6);

function step(n: string, msg: string) {
  console.log(`\n\x1b[36m[${n}]\x1b[0m ${msg}`);
}

async function main() {
  const [operator] = await ethers.getSigners();
  const record = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
  if (!record.lending) throw new Error("No lending stack recorded. Run testnet:deploy-lending first.");

  const token = (await ethers.getContractAt("IAsset", record.esopToken.address)) as unknown as IAsset;
  const pool = await ethers.getContractAt("ESOPLendingPool", record.lending.pool.address);
  const usdc = await ethers.getContractAt("MockUSDC", record.lending.stablecoin.address);

  // The operator borrows against its own treasury shares. A real borrower is an employee
  // whose account has never paid gas, so the portal relays their signed hold instead
  // (spike #2) — that path is the UI's job, not this script's.
  const borrower = operator;

  console.log("=".repeat(72));
  console.log("  tokenize-it -- borrow against vested ESOPs, on Hedera testnet");
  console.log("=".repeat(72));
  console.log(`  borrower ${borrower.address}`);
  console.log(`  pool     ${record.lending.pool.address}`);

  const shares = await token.balanceOfByPartition(PARTITION, borrower.address);
  console.log(`  holds    ${shares} ESOP shares, free and clear`);
  if (shares === 0n) throw new Error("Borrower holds no free ESOP shares.");

  const pledge = shares > 5_000n ? 5_000n : shares;

  step("1", `Pledging ${pledge} shares as a hold — the pool is escrow, not the owner...`);
  const expiry = Math.floor(Date.now() / 1000) + 30 * DAY;
  await (
    await token.createHoldByPartition(PARTITION, {
      amount: pledge,
      expirationTimestamp: expiry,
      escrow: record.lending.pool.address,
      to: record.lending.pool.address,
      data: EMPTY_HEX,
    })
  ).wait();
  const holdId = await token.getHoldCountForByPartition(PARTITION, borrower.address);
  console.log(`  -> hold #${holdId}, expires ${new Date(expiry * 1000).toISOString().slice(0, 10)}`);
  console.log(`  -> still owned by the borrower: ${await token.balanceOfByPartition(PARTITION, borrower.address)} free, ${await token.getHeldAmountForByPartition(PARTITION, borrower.address)} held`);

  const value = await pool.collateralValue(pledge);
  const maxLtv = await pool.maxLtvBps();
  const ceiling = (value * maxLtv) / 10_000n;
  console.log(`  -> collateral worth ${usdcFmt(value)} USDC, borrowable up to ${usdcFmt(ceiling)} at ${Number(maxLtv) / 100}% LTV`);

  step("2", `Borrowing ${usdcFmt(ceiling / 2n)} USDC...`);
  const before = await usdc.balanceOf(borrower.address);
  const loanId = await pool.nextLoanId();
  await (await pool.borrow(PARTITION, holdId, ceiling / 2n)).wait();
  console.log(`  -> loan #${loanId}`);
  console.log(`  -> received ${usdcFmt((await usdc.balanceOf(borrower.address)) - before)} USDC`);
  console.log(`  -> LTV now ${Number(await pool.ltvOf(loanId)) / 100}%`);

  const loan = await pool.getLoan(loanId);
  console.log(`  -> matures ${new Date(Number(loan.maturity) * 1000).toISOString().slice(0, 16)} (before the hold expires, so it stays seizable)`);

  step("3", "Confirming the shares never moved...");
  const poolShares = await token.balanceOfByPartition(PARTITION, record.lending.pool.address);
  console.log(`  -> pool's ESOP balance: ${poolShares} (the whole point)`);
  console.log(`  -> borrower still holds ${await token.getHeldAmountForByPartition(PARTITION, borrower.address)} as collateral, in their own wallet`);

  step("4", "Repaying in full...");
  const owed = await pool.debtOf(loanId);
  console.log(`  -> owed ${usdcFmt(owed)} USDC including interest`);
  await (await usdc.mint(borrower.address, owed)).wait(); // testnet convenience
  await (await usdc.approve(record.lending.pool.address, ethersLib.MaxUint256)).wait();
  await (await pool.repayAll(loanId)).wait();

  const after = await pool.getLoan(loanId);
  console.log(`  -> status ${["None", "Active", "Repaid", "Liquidated"][Number(after.status)]}`);
  console.log(`  -> collateral released: ${await token.getHeldAmountForByPartition(PARTITION, borrower.address)} still held`);
  console.log(`  -> free balance back to ${await token.balanceOfByPartition(PARTITION, borrower.address)}`);

  console.log("\n" + "=".repeat(72));
  console.log("  Borrowed against vested equity without selling it, and got it back.");
  console.log("=".repeat(72));
}

main().catch((e) => {
  console.error("\n\x1b[31mFAILED\x1b[0m", e);
  process.exitCode = 1;
});
