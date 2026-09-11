// SPDX-License-Identifier: Apache-2.0
//
// Empties the CURRENT lending pool and payroll contract before they are superseded.
//
// Redeploying a contract does not move what the old one holds. Without this, every
// redeploy quietly leaves a balance behind at an address nothing points at any more --
// which is exactly how the first pool ended up stranded with 2,174 seized shares, and the
// reason `withdrawSeizedShares` had to be added afterwards.
//
// It does two things, both of which the contracts were built to allow:
//   * delivers every employee's accrued salary to the employee (relayed, as usual, so
//     nobody needs gas to be paid what they are already owed);
//   * withdraws the pool's lendable stablecoin back to the admin.
//
// Refuses to touch a pool with a live loan -- collateral is under a hold in someone's
// wallet, and retiring the pool underneath it would leave them unable to repay.
//
//   npm run testnet:retire-stack

import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { ethers as ethersLib } from "ethers";

const REPO_ROOT = process.env.TOKENIZE_IT_ROOT ?? path.resolve(__dirname, "../../../../../../..");
const DEPLOYMENTS = path.join(REPO_ROOT, "deployments", "hedera-testnet.json");

function step(n: string, msg: string) {
  console.log(`\n\x1b[36m[${n}]\x1b[0m ${msg}`);
}

const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1";

/**
 * Explicit, generous, and not negotiable.
 *
 * The estimator on Hedera is not a bound you can rely on: `withdrawFor` estimated 73,491
 * and then ran out of gas having used 73,367, with the transaction reverting and empty
 * revert data while `eth_call` on the same inputs succeeded. Hedera charges gas USED
 * rather than gas OFFERED -- measured earlier in this project, identical cost at a 120k
 * and a 900k limit -- so a high ceiling costs nothing and a tight one costs the run.
 */
const GAS = { gasLimit: 3_000_000n };

/** keccak256("SalaryAccrued(uint256,address,uint256)") */
const SALARY_ACCRUED_TOPIC = ethersLib.id("SalaryAccrued(uint256,address,uint256)");

/**
 * Every address the payroll contract has ever credited.
 *
 * Read from the mirror node rather than `eth_getLogs`, which Hashio caps at a 7-day
 * window -- a range scan would silently miss anyone paid before that and this script's
 * whole job is to leave nothing behind. The mirror node pages by timestamp instead.
 */
async function employeesEverPaid(payrollAddress: string): Promise<string[]> {
  const seen = new Set<string>();
  let next: string | null = `/contracts/${payrollAddress}/results/logs?order=asc&limit=100`;
  while (next) {
    const url: string = next.startsWith("/api/v1") ? next.slice(7) : next;
    const res = await fetch(`${MIRROR}${url}`);
    if (!res.ok) throw new Error(`mirror node ${res.status} on ${url}`);
    const body = (await res.json()) as { logs?: { topics?: string[] }[]; links?: { next?: string } };
    for (const log of body.logs ?? []) {
      const topics = log.topics ?? [];
      // topics[2], not topics[1]: runId is indexed first, so the employee is the SECOND
      // indexed parameter. Reading topics[1] here would give run ids dressed as addresses.
      if (topics[0]?.toLowerCase() === SALARY_ACCRUED_TOPIC.toLowerCase() && topics[2]) {
        seen.add(ethersLib.getAddress(`0x${topics[2].slice(-40)}`));
      }
    }
    next = body.links?.next ?? null;
  }
  return [...seen];
}

async function main() {
  const [operator] = await ethers.getSigners();
  const record = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));

  console.log("=".repeat(72));
  console.log("  tokenize-it -- empty the current pool and payroll before superseding them");
  console.log("=".repeat(72));
  console.log(`  operator ${operator.address}`);

  // ---------------------------------------------------------------- payroll
  const payrollAddress: string | undefined = record.payroll?.address;
  if (!payrollAddress) {
    step("1", "No payroll contract recorded -- nothing to drain.");
  } else {
    step("1", `Delivering outstanding salary from ${payrollAddress}...`);
    const payroll = await ethers.getContractAt("PayrollDisburser", payrollAddress);
    const outstanding: bigint = await payroll.totalAccrued();

    if (outstanding === 0n) {
      console.log("  -> nothing accrued; every employee has already collected");
    } else {
      // Who is owed? Ask the chain rather than a file -- a run submitted from anywhere else
      // would be invisible to a local roster.
      const employees = await employeesEverPaid(payrollAddress);
      console.log(`  -> ${ethersLib.formatUnits(outstanding, 6)} USDC owed across ${employees.length} employees`);

      for (const employee of employees) {
        const owed: bigint = await payroll.accrued(employee);
        if (owed === 0n) continue;
        // withdrawFor, not withdraw: the employee holds no HBAR and cannot send this.
        // The funds still only ever go to them -- that is enforced in the contract.
        await (await payroll.withdrawFor(employee, GAS)).wait();
        console.log(`     ${employee}  ${ethersLib.formatUnits(owed, 6)} USDC delivered`);
      }
      console.log(`  -> ${ethersLib.formatUnits(await payroll.totalAccrued(), 6)} USDC still owed`);
    }
  }

  // ------------------------------------------------------------------- pool
  const poolAddress: string | undefined = record.lending?.pool?.address;
  if (!poolAddress) {
    step("2", "No lending pool recorded -- nothing to drain.");
  } else {
    step("2", `Withdrawing liquidity from ${poolAddress}...`);
    const pool = await ethers.getContractAt("ESOPLendingPool", poolAddress);

    // A live loan means collateral is held in a borrower's wallet against this pool.
    // Draining it would leave them owing a contract with no cash and no reason to exist.
    const nextLoanId: bigint = await pool.nextLoanId();
    const live: number[] = [];
    for (let id = 1n; id < nextLoanId; id++) {
      const loan = await pool.getLoan(id);
      if (Number(loan[8]) === 1) live.push(Number(id)); // LoanStatus.Active
    }
    if (live.length > 0) {
      console.log(`\n\x1b[31m  REFUSING\x1b[0m -- loans still active: ${live.join(", ")}`);
      console.log("  Repay or liquidate them first. Retiring the pool underneath a live");
      console.log("  loan would leave the borrower unable to repay and their shares held.");
      process.exitCode = 1;
      return;
    }

    const available: bigint = await pool.available();
    if (available === 0n) {
      console.log("  -> pool is already empty");
    } else {
      await (await pool.removeLiquidity(operator.address, available, GAS)).wait();
      console.log(`  -> ${ethersLib.formatUnits(available, 6)} USDC returned to the operator`);
    }
  }

  console.log("\n" + "=".repeat(72));
  console.log("  Safe to redeploy. Nothing of value is left at the old addresses.");
  console.log("=".repeat(72));
}

main().catch((e) => {
  console.error("\n\x1b[31mFAILED\x1b[0m", e);
  process.exitCode = 1;
});
