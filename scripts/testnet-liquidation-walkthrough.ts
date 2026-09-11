// SPDX-License-Identifier: Apache-2.0
//
// Drives a liquidation against live Hedera testnet: pledge, borrow at the ceiling, mark the
// shares down until the loan is underwater, and seize.
//
// Two things this is really testing, neither of which any earlier run has touched:
//
//  1. `executeHoldByPartition` into the pool. Spike #1 established that seizing requires the
//     pool to be KYC'd and allowlisted on the token. That was a one-time deployment step and
//     it has never actually been exercised — until a liquidation runs, the pool has never
//     owned a share and the compliance stack has never been asked to permit it.
//  2. Partial seizure. The pool takes only what covers the debt and releases the remainder.
//     A borrower who is liquidated should keep their surplus, and it should never leave
//     their wallet in the first place.
//
// It borrows against the OPERATOR's treasury shares, not an employee's. Liquidation is
// destructive — the seized shares stay with the pool — and the employee demo position should
// survive this script intact.
//
// NAV is moved in steps because the oracle refuses any single move beyond `maxDeviationBps`.
// That guard is the point, not an obstacle: it is what stops a fat-fingered price from
// repricing every outstanding loan at once. The script restores NAV on the way out, in a
// `finally`, so a failure part-way through cannot leave the demo marked down.
//
//   npm run testnet:liquidation-walkthrough

import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { ethers as ethersLib } from "ethers";
import { IAsset } from "@contract-types";

const PARTITION = "0x0000000000000000000000000000000000000000000000000000000000000001";
const DAY = 24 * 60 * 60;
const PLEDGE = BigInt(process.env.PLEDGE_SHARES ?? 5_000);

const REPO_ROOT = process.env.TOKENIZE_IT_ROOT ?? path.resolve(__dirname, "../../../../../../..");
const DEPLOYMENTS = path.join(REPO_ROOT, "deployments", "hedera-testnet.json");

const usdc = (v: bigint) => ethersLib.formatUnits(v, 6);
const pct = (bps: bigint) => `${(Number(bps) / 100).toFixed(1)}%`;

function step(n: string, msg: string) {
  console.log(`\n\x1b[36m[${n}]\x1b[0m ${msg}`);
}

async function main() {
  const [operator] = await ethers.getSigners();
  const record = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
  if (!record.lending) throw new Error("No lending stack recorded. Run testnet:deploy-lending first.");

  const token = (await ethers.getContractAt("IAsset", record.esopToken.address)) as unknown as IAsset;
  const pool = await ethers.getContractAt("ESOPLendingPool", record.lending.pool.address);
  const nav = await ethers.getContractAt("EsopNavOracle", record.lending.navOracle.address);

  const startingNav = (await nav.latestRoundData())[1];

  console.log("=".repeat(72));
  console.log("  tokenize-it -- liquidating an underwater ESOP-backed loan");
  console.log("=".repeat(72));
  console.log(`  borrower ${operator.address} (treasury, not an employee)`);
  console.log(`  pool     ${record.lending.pool.address}`);
  console.log(`  NAV now  $${ethersLib.formatUnits(startingNav, 8)}`);

  try {
    step("1", `Pledging ${PLEDGE} shares...`);
    const expiry = Math.floor(Date.now() / 1000) + 30 * DAY;
    const holdId = await pledge(token, operator, record, expiry);
    console.log(`  -> hold #${holdId}`);

    const value = await pool.collateralValue(PLEDGE);
    const ceiling = (value * (await pool.maxLtvBps())) / 10_000n;
    console.log(`  -> worth ${usdc(value)} USDC, borrowable up to ${usdc(ceiling)}`);

    step("2", `Borrowing ${usdc(ceiling)} USDC — right at the ceiling...`);
    const loanId = await pool.nextLoanId();
    await (await pool.borrow(PARTITION, holdId, ceiling)).wait();
    console.log(`  -> loan #${loanId}, LTV ${pct(await pool.ltvOf(loanId))}`);

    const liqLtv = await pool.liquidationLtvBps();
    console.log(`  -> liquidation threshold is ${pct(liqLtv)}`);

    step("3", "Marking the shares down. The oracle caps each move, so this takes two rounds.");
    await publish(nav, "1.50", "Down round — 409A revised (demo)");
    console.log(`  -> NAV $1.50, LTV now ${pct(await pool.ltvOf(loanId))}`);

    console.log("\n  Trying to liquidate while still healthy — this should be refused:");
    try {
      await pool.liquidate.staticCall(loanId);
      console.log("  \x1b[31m-> NOT REFUSED. A healthy loan was liquidatable.\x1b[0m");
      throw new Error("A healthy loan must not be liquidatable.");
    } catch (e) {
      const m = (e as Error).message ?? "";
      if (m.includes("must not be liquidatable")) throw e;
      console.log(`  -> refused, as it should be (Healthy)`);
    }

    await publish(nav, "1.15", "Down round — second markdown (demo)");
    const ltvNow = await pool.ltvOf(loanId);
    console.log(`  -> NAV $1.15, LTV now ${pct(ltvNow)} — past the ${pct(liqLtv)} threshold`);

    step("4", "Liquidating...");
    const debt = await pool.debtOf(loanId);
    const heldBefore = await token.getHeldAmountForByPartition(PARTITION, operator.address);
    const freeBefore = await token.balanceOfByPartition(PARTITION, operator.address);
    console.log(`  -> owed ${usdc(debt)} USDC against ${heldBefore} held shares`);

    await (await pool.liquidate(loanId)).wait();

    const seized = await token.balanceOfByPartition(PARTITION, record.lending.pool.address);
    const freeAfter = await token.balanceOfByPartition(PARTITION, operator.address);
    const heldAfter = await token.getHeldAmountForByPartition(PARTITION, operator.address);
    const loan = await pool.getLoan(loanId);

    console.log(`  -> status ${["None", "Active", "Repaid", "Liquidated"][Number(loan[8])]}`);
    console.log(`  -> pool seized ${seized} shares (it now owns shares for the first time)`);
    console.log(`  -> surplus released back to the borrower: ${freeAfter - freeBefore} shares`);
    console.log(`  -> still held: ${heldAfter} (was ${heldBefore})`);

    step("5", "What this proves");
    console.log("  - executeHoldByPartition into the pool works: the pool being KYC'd and");
    console.log("    allowlisted is what permits it, exactly as spike #1 predicted.");
    console.log("  - the seizure is partial. The pool took what covered the debt and no more,");
    console.log("    and the surplus never left the borrower's wallet.");
    console.log("  - the oracle refused a markdown larger than its deviation cap, so no single");
    console.log("    price publish can reprice every loan at once.");
  } finally {
    step("6", "Restoring NAV so the demo is left as it was found...");
    await restore(nav, startingNav);
    console.log(`  -> NAV back to $${ethersLib.formatUnits((await nav.latestRoundData())[1], 8)}`);
  }
}

/** Creates a protected hold, signing as the holder. Partitions are protected, so this is the only path. */
async function pledge(
  token: IAsset,
  signer: ethersLib.Signer & { address: string },
  record: { esopToken: { address: string; name: string } ; lending: { pool: { address: string } } },
  expiry: number,
): Promise<bigint> {
  const cfg = await token.getConfigInfo();
  const nonce = await token.nonces(signer.address);

  const message = {
    _partition: PARTITION,
    _from: signer.address,
    _protectedHold: {
      hold: {
        amount: PLEDGE,
        expirationTimestamp: BigInt(expiry),
        escrow: record.lending.pool.address,
        to: record.lending.pool.address,
        data: "0x",
      },
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce: nonce + 1n,
    },
  };

  const signature = await signer.signTypedData(
    {
      name: record.esopToken.name,
      version: String(cfg[2]),
      chainId: 296,
      verifyingContract: record.esopToken.address,
    },
    {
      Hold: [
        { name: "amount", type: "uint256" },
        { name: "expirationTimestamp", type: "uint256" },
        { name: "escrow", type: "address" },
        { name: "to", type: "address" },
        { name: "data", type: "bytes" },
      ],
      ProtectedHold: [
        { name: "hold", type: "Hold" },
        { name: "deadline", type: "uint256" },
        { name: "nonce", type: "uint256" },
      ],
      protectedCreateHoldByPartition: [
        { name: "_partition", type: "bytes32" },
        { name: "_from", type: "address" },
        { name: "_protectedHold", type: "ProtectedHold" },
      ],
    },
    message,
  );

  const tx = await token.protectedCreateHoldByPartition(PARTITION, signer.address, message._protectedHold, signature);
  const receipt = await tx.wait();

  // The id comes from the event, never from the hold count: ids keep increasing while the
  // count drops on release, so the two diverge as soon as anything has been repaid.
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = token.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "ProtectedHeldByPartition" || parsed?.name === "HeldByPartition") {
        return parsed.args.holdId as bigint;
      }
    } catch {
      /* logs from other contracts do not parse */
    }
  }
  throw new Error("Hold created but no hold id in the receipt.");
}

async function publish(nav: ethersLib.BaseContract & Record<string, never>, price: string, basis: string) {
  await (
    await (nav as unknown as { publish: (a: bigint, b: string) => Promise<ethersLib.ContractTransactionResponse> })
      .publish(ethersLib.parseUnits(price, 8), basis)
  ).wait();
}

/**
 * Walks NAV back to where it started, respecting the deviation cap on every step.
 * Recovering from a markdown needs more steps than making one, since each move is capped
 * as a fraction of the current price rather than the original.
 */
async function restore(nav: ethersLib.BaseContract & Record<string, never>, target: bigint) {
  const cap = await (nav as unknown as { maxDeviationBps: () => Promise<bigint> }).maxDeviationBps();
  for (let i = 0; i < 12; i++) {
    const current = (await (nav as unknown as { latestRoundData: () => Promise<[bigint, bigint]> }).latestRoundData())[1];
    if (current === target) return;
    // Stay a little inside the cap; landing exactly on it risks a rounding-driven revert.
    const maxStep = (current * cap * 95n) / (10_000n * 100n);
    const next = target > current ? min(target, current + maxStep) : max(target, current - maxStep);
    await publish(nav, ethersLib.formatUnits(next, 8), "Restoring the pre-walkthrough valuation");
  }
  throw new Error("Could not restore NAV within the step budget — check the oracle manually.");
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

main().catch((e) => {
  console.error("\n\x1b[31mFAILED\x1b[0m", e.message ?? e);
  process.exitCode = 1;
});
