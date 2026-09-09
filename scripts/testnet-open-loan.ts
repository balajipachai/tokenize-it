// SPDX-License-Identifier: Apache-2.0
//
// Opens a loan against a hold that already exists.
//
// A pledge and the loan it backs are two transactions. If the second fails, the borrower is
// left with their shares held and nothing to show for it — the hold is valid, signed, and
// carries the requested amount in its own `data`, but no loan stands against it. This closes
// that gap rather than making the borrower wait out the expiry.
//
// `borrowFor` needs no privileges by design: every term of the loan comes from the hold the
// borrower signed, so the caller is carrying out an instruction, not making a decision.
//
//   HOLDER=0x... HOLD_ID=2 npm run testnet:open-loan

import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { ethers as ethersLib } from "ethers";

const REPO_ROOT = process.env.TOKENIZE_IT_ROOT ?? path.resolve(__dirname, "../../../../../../..");
const DEPLOYMENTS = path.join(REPO_ROOT, "deployments", "hedera-testnet.json");

async function main() {
  const holder = process.env.HOLDER;
  const holdId = process.env.HOLD_ID;
  if (!holder || !ethersLib.isAddress(holder)) throw new Error("Set HOLDER to the borrower's address.");
  if (!holdId) throw new Error("Set HOLD_ID to the hold to borrow against.");

  const [operator] = await ethers.getSigners();
  const record = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
  const pool = await ethers.getContractAt("ESOPLendingPool", record.lending.pool.address);

  console.log(`Opening a loan for ${holder} against hold #${holdId}`);
  console.log(`  pool       ${record.lending.pool.address}`);
  console.log(`  signing as ${operator.address}`);

  const loanId = await pool.nextLoanId();
  await (await pool.borrowFor(record.esopToken.partition, holder, holdId)).wait();

  const loan = await pool.getLoan(loanId);
  console.log(`\n  -> loan #${loanId}`);
  console.log(`  -> principal ${ethersLib.formatUnits(loan.principal, 6)} USDC`);
  // Positional: the generated struct type does not always carry field names through.
  console.log(`  -> collateral ${loan[3]} shares, still in the borrower's wallet`);
}

main().catch((e) => {
  console.error("\n\x1b[31mFAILED\x1b[0m", e.message ?? e);
  process.exitCode = 1;
});
