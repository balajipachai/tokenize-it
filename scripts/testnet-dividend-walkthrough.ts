// SPDX-License-Identifier: Apache-2.0
//
// Declares a dividend against the ESOP token and shows what each holder is owed.
//
// Deliberately uses ATS's OWN dividend facet rather than a contract of ours. The hard part of
// a dividend is not moving money — it is deciding who was a holder at the record date, and
// ATS already snapshots that. Writing a parallel implementation would mean maintaining a
// second answer to the same question, and the two would disagree the first time a transfer
// landed near a record date.
//
// Note what this does and does not do. ATS records the dividend, snapshots holders, and
// computes each holder's entitlement. It does NOT move cash — the paying leg is external, by
// design, because a security token should not assume what currency a dividend is paid in.
// Here that leg is the same accrue-then-withdraw shape as payroll: entitlements are known on
// chain, and settlement happens in the stablecoin.
//
// Employees hold vesting-restricted equity, so this is a real question rather than a
// decoration: an employee whose tranches have vested IS a shareholder and is owed their share.
//
//   npm run testnet:dividend-walkthrough
//   AMOUNT=50000 npm run testnet:dividend-walkthrough

import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { ethers as ethersLib } from "ethers";

const GAS = { gasLimit: 3_000_000n };
const PARTITION = "0x0000000000000000000000000000000000000000000000000000000000000001";
const ROLE_CORPORATE_ACTION = "0xa1acfc499025c99f55059195e6276f639d34a18aad7b8121b9192b7f438c55cd";

const REPO_ROOT = process.env.TOKENIZE_IT_ROOT ?? path.resolve(__dirname, "../../../../../../..");
const DEPLOYMENTS = path.join(REPO_ROOT, "deployments", "hedera-testnet.json");

const step = (n: string, m: string) => console.log(`\n\x1b[36m[${n}]\x1b[0m ${m}`);
const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);

const dividendAbi = [
  "function setDividend((uint256 recordDate,uint256 executionDate,uint256 amount,uint8 amountDecimals) newDividend) returns (uint256 dividendId_)",
  "function getDividendsCount() view returns (uint256)",
  "function getDividendFor(uint256 dividendId, address account) view returns ((uint256 tokenBalance,uint256 amount,uint8 amountDecimals,uint256 recordDate,uint256 executionDate,uint8 decimals,bool recordDateReached,bool isDisabled) dividendFor_)",
];

async function main() {
  const [operator] = await ethers.getSigners();
  const record = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
  const tokenAddress: string = record.esopToken.address;

  const token = await ethers.getContractAt("IAsset", tokenAddress);
  const dividend = new ethersLib.Contract(tokenAddress, dividendAbi, operator);

  const total = Number(process.env.AMOUNT ?? 50_000);
  const amountDecimals = 6;

  console.log("=".repeat(72));
  console.log("  tokenize-it -- declaring a dividend on vested ESOPs");
  console.log("=".repeat(72));
  console.log(`  token    ${tokenAddress}`);
  console.log(`  operator ${operator.address}`);

  step("1", "Granting the corporate-action role...");
  if (!(await token.hasRole(ROLE_CORPORATE_ACTION, operator.address))) {
    await (await token.grantRole(ROLE_CORPORATE_ACTION, operator.address, GAS)).wait();
    ok("ROLE_CORPORATE_ACTION granted — declaring a dividend is a privileged act");
  } else {
    ok("already held");
  }

  step("2", `Declaring a ${total.toLocaleString("en-US")} dividend...`);
  // ATS refuses a record date in the past and requires execution to follow it. A short gap
  // keeps the demo watchable; a real one would be days, so holders can see it coming.
  const now = Math.floor(Date.now() / 1000);
  const recordDate = now + 60;
  const executionDate = recordDate + 60;

  const id = await dividend.setDividend.staticCall({
    recordDate,
    executionDate,
    amount: ethersLib.parseUnits(String(total), amountDecimals),
    amountDecimals,
  });
  await (
    await dividend.setDividend(
      { recordDate, executionDate, amount: ethersLib.parseUnits(String(total), amountDecimals), amountDecimals },
      GAS,
    )
  ).wait();
  console.log(`  -> dividend #${id}`);
  console.log(`  -> record date    ${new Date(recordDate * 1000).toISOString().slice(0, 19)}`);
  console.log(`  -> execution date ${new Date(executionDate * 1000).toISOString().slice(0, 19)}`);
  ok("holders are snapshotted at the record date, not at payment — a transfer after it changes nothing");

  step("3", "Waiting for the record date so the snapshot binds...");
  await new Promise((r) => setTimeout(r, 70_000));

  step("4", "What each holder is owed");
  const employees: string[] = Array.from(new Set((record.grants ?? []).map((g: { employee: string }) => g.employee)));
  const supply = await token.totalSupply();
  console.log(`  total supply ${supply}\n`);

  for (const who of employees.slice(0, 8)) {
    const view = await dividend.getDividendFor(id, who);
    const balance = view[0] as bigint;
    if (balance === 0n) continue;
    const share = (BigInt(ethersLib.parseUnits(String(total), amountDecimals)) * balance) / supply;
    console.log(
      `  ${who.slice(0, 10)}…  held ${String(balance).padStart(7)} shares  ->  ${ethersLib.formatUnits(share, amountDecimals)} due`,
    );
  }

  step("5", "The settlement leg");
  console.log("  ATS has decided WHO is owed WHAT, from a snapshot nobody can rewrite.");
  console.log("  Paying it is the same accrue-then-withdraw shape as payroll: entitlements");
  console.log("  are known on chain, settlement happens in the stablecoin, and a holder who");
  console.log("  never claims does not block anyone else's payment.");

  record.dividends = {
    lastDividendId: Number(id),
    amount: total,
    amountDecimals,
    recordDate,
    executionDate,
    declaredAt: new Date().toISOString(),
    note: "Declared through the ATS dividend facet; ATS owns the record-date snapshot.",
  };
  fs.writeFileSync(DEPLOYMENTS, JSON.stringify(record, null, 2) + "\n");

  console.log("\n" + "=".repeat(72));
  console.log("  Vested ESOPs are shares. Shares receive dividends.");
  console.log("=".repeat(72));
}

main().catch((e) => {
  console.error("\n\x1b[31mFAILED\x1b[0m", String(e.message ?? e).slice(0, 300));
  process.exitCode = 1;
});
