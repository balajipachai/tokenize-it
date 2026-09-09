// SPDX-License-Identifier: Apache-2.0
//
// Mints testnet USDC to an address.
//
// Why this exists: interest accrues from the moment a loan opens, so a borrower who takes
// 500 USDC owes slightly more than 500 the instant they try to repay. That is not a bug —
// it is what borrowing is — but it means the borrowed funds alone can never close the loan.
// A real employee services the interest out of salary. On testnet there is no salary, so
// the demo needs a way to put a few dollars in a wallet.
//
// MockUSDC is a declared stand-in (see deployments/hedera-testnet.json), and its `mint` is
// deliberately open. Nothing here touches the ESOP token or the collateral leg, which is
// where the interesting risk actually lives.
//
//   TO=0x... npm run testnet:fund-usdc
//   TO=0x... AMOUNT=25 npm run testnet:fund-usdc

import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { ethers as ethersLib } from "ethers";

const REPO_ROOT = process.env.TOKENIZE_IT_ROOT ?? path.resolve(__dirname, "../../../../../../..");
const DEPLOYMENTS = path.join(REPO_ROOT, "deployments", "hedera-testnet.json");

async function main() {
  const to = process.env.TO;
  if (!to || !ethersLib.isAddress(to)) {
    throw new Error("Set TO to the recipient address, e.g. TO=0x... npm run testnet:fund-usdc");
  }
  const amount = process.env.AMOUNT ?? "10";

  const [operator] = await ethers.getSigners();
  const record = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
  if (!record.lending) throw new Error("No lending stack recorded. Run testnet:deploy-lending first.");

  const usdc = await ethers.getContractAt("MockUSDC", record.lending.stablecoin.address);
  const units = ethersLib.parseUnits(amount, 6);

  console.log(`Minting ${amount} test USDC to ${to}`);
  console.log(`  token      ${record.lending.stablecoin.address}`);
  console.log(`  signing as ${operator.address}`);

  const before = await usdc.balanceOf(to);
  await (await usdc.mint(to, units)).wait();
  const after = await usdc.balanceOf(to);

  console.log(`\n  -> ${ethersLib.formatUnits(before, 6)} to ${ethersLib.formatUnits(after, 6)} USDC`);
}

main().catch((e) => {
  console.error("\n\x1b[31mFAILED\x1b[0m", e.message ?? e);
  process.exitCode = 1;
});
