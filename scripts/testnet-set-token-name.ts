// SPDX-License-Identifier: Apache-2.0
//
// Renames the deployed ESOP token. ERC-20 name and symbol are mutable on an ATS
// security token via ICore.setName/setSymbol, gated on ROLE_TREX_OWNER — so this is a
// real on-chain rename that HashScan and every wallet will pick up, not a relabelling
// of our own JSON.
//
//   NAME="Essential Links ESOP 2026-A" npm run testnet:set-token-name
//   NAME="..." SYMBOL="ESOP" npm run testnet:set-token-name

import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { ATS_ROLES } from "@scripts";
import { IAsset } from "@contract-types";

const REPO_ROOT = process.env.TOKENIZE_IT_ROOT ?? path.resolve(__dirname, "../../../../../../..");
const DEPLOYMENTS = path.join(REPO_ROOT, "deployments", "hedera-testnet.json");

async function main() {
  const name = process.env.NAME;
  const symbol = process.env.SYMBOL;
  if (!name && !symbol) throw new Error('Set NAME and/or SYMBOL, e.g. NAME="Essential Links ESOP 2026-A"');

  const [operator] = await ethers.getSigners();
  const record = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
  const token = (await ethers.getContractAt("IAsset", record.esopToken.address)) as unknown as IAsset;

  console.log(`Token   ${record.esopToken.address}`);
  console.log(`Current ${record.esopToken.name} (${record.esopToken.symbol})`);

  // setName/setSymbol are ROLE_TREX_OWNER, which the deployer does not hold by default
  // even though it is DEFAULT_ADMIN. Grant it rather than assuming.
  if (!(await token.hasRole(ATS_ROLES.ROLE_TREX_OWNER, operator.address))) {
    await (await token.grantRole(ATS_ROLES.ROLE_TREX_OWNER, operator.address)).wait();
    console.log("  -> granted ROLE_TREX_OWNER to the operator");
  }

  if (name) {
    await (await token.setName(name)).wait();
    record.esopToken.name = name;
    console.log(`  -> name   ${name}`);
  }
  if (symbol) {
    await (await token.setSymbol(symbol)).wait();
    record.esopToken.symbol = symbol;
    console.log(`  -> symbol ${symbol}`);
  }

  const on = await token.getERC20Metadata();
  console.log(`\nOn-chain now: ${on.info.name} (${on.info.symbol})`);

  fs.writeFileSync(DEPLOYMENTS, JSON.stringify(record, null, 2) + "\n");
  console.log("Recorded in deployments/hedera-testnet.json");
}

main().catch((e) => {
  console.error("\n\x1b[31mFAILED\x1b[0m", e.message ?? e);
  process.exitCode = 1;
});
