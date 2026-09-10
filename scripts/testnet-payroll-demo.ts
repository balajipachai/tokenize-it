// SPDX-License-Identifier: Apache-2.0
//
// Runs payroll against live Hedera testnet, then delivers it the way an employee would
// actually receive it — relayed, with the employee never paying gas.
//
//   npm run testnet:payroll-demo

import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { ethers as ethersLib } from "ethers";

const GAS = { gasLimit: 3_000_000n };
const REPO_ROOT = process.env.TOKENIZE_IT_ROOT ?? path.resolve(__dirname, "../../../../../../..");
const DEPLOYMENTS = path.join(REPO_ROOT, "deployments", "hedera-testnet.json");
const usd = (v: bigint) => ethersLib.formatUnits(v, 6);
const step = (n: string, m: string) => console.log(`\n\x1b[36m[${n}]\x1b[0m ${m}`);
const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);

async function main() {
  const [operator] = await ethers.getSigners();
  const rec = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
  if (!rec.payroll) throw new Error("No payroll recorded. Run testnet:deploy-payroll first.");

  const payroll = await ethers.getContractAt("PayrollDisburser", rec.payroll.address);
  const usdc = await ethers.getContractAt("MockUSDC", rec.payroll.stablecoin);
  const employee: string = rec.grants[0].employee;
  const salary = ethersLib.parseUnits(process.env.SALARY ?? "4000", 6);

  console.log("=".repeat(72));
  console.log("  tokenize-it -- payroll, on live testnet");
  console.log("=".repeat(72));
  console.log(`  payroll  ${rec.payroll.address}`);
  console.log(`  employee ${employee}`);

  step("1", `Running payroll: ${usd(salary)} USDC...`);
  await (await usdc.mint(operator.address, salary, GAS)).wait();
  await (await usdc.approve(rec.payroll.address, salary, GAS)).wait();
  const before = await usdc.balanceOf(employee);
  await (await payroll.fundRun([employee], [salary], GAS)).wait();

  console.log(`  -> accrued ${usd(await payroll.accrued(employee))} USDC`);
  console.log(`  -> employee wallet still ${usd(await usdc.balanceOf(employee))} USDC`);
  ok("salary is credited, not pushed — a blocked recipient cannot break a run");

  step("2", "Delivering it. The employee pays no gas and signs nothing.");
  await (await payroll.withdrawFor(employee, GAS)).wait();
  const gained = (await usdc.balanceOf(employee)) - before;
  console.log(`  -> employee received ${usd(gained)} USDC`);
  console.log(`  -> still owed ${usd(await payroll.accrued(employee))}`);
  console.log(`  -> lifetime earned ${usd(await payroll.lifetimeEarned(employee))} (the payslip history)`);
  if (gained !== salary) throw new Error("Delivered amount did not match the run.");

  step("3", "Solvency");
  console.log(`  -> solvent: ${await payroll.isSolvent()}, surplus ${usd(await payroll.surplus())} USDC`);

  console.log("\n" + "=".repeat(72));
  console.log("  Salary can now service the interest on an ESOP-backed loan.");
  console.log("=".repeat(72));
}

main().catch((e) => { console.error("\n\x1b[31mFAILED\x1b[0m", e.message ?? e); process.exitCode = 1; });
