// SPDX-License-Identifier: Apache-2.0
//
// Finishes funding a grant whose tranche locks were only partly created.
//
// Funding is deliberately resumable: `fundTranches` takes a cap and records how far it got,
// because a 13-tranche grant is roughly 5.5M gas and does not fit in one transaction next to
// Hedera's 15M ceiling with any comfort. The consequence is that funding can stop half way
// -- a failed batch, a dropped connection, a gas limit that was too tight -- leaving a grant
// the employee can see and cannot claim from. This is how you finish it.
//
// Safe to re-run: it stops as soon as the grant reports Funded, and funding an already
// funded grant is a no-op on the contract side.
//
//   GRANT=2 npm run testnet:fund-grant
//   npm run testnet:fund-grant            # finishes every unfunded grant it finds

import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";

/**
 * ICommonErrors.WrongExpirationTimestamp() -- ATS refuses a lock that expires in the past.
 * Recorded for the reader; it is deliberately NOT what this script matches on. Hashio drops
 * revert data, so the selector never reaches the client and a `wait()` failure arrives as a
 * bare CALL_EXCEPTION with `data: ""`. The dates are checked directly instead.
 */
const WRONG_EXPIRATION = "0xe39f4776";

const REPO_ROOT = process.env.TOKENIZE_IT_ROOT ?? path.resolve(__dirname, "../../../../../../..");
const DEPLOYMENTS = path.join(REPO_ROOT, "deployments", "hedera-testnet.json");

/** Grant statuses, from ESOPVestingController.GrantStatus. */
const CREATED = 1;
const FUNDED = 2;

// Eight locks at roughly 425k each stay well inside the 15M per-transaction ceiling, and
// the limit is that ceiling rather than an estimate: Hedera charges gas USED, not OFFERED.
// The estimator offered 5,343,980 here once and the call ran out having used 5,336,742.
const FUND_BATCH = 8;
const FUND_GAS = { gasLimit: 15_000_000n };

async function main() {
  const [operator] = await ethers.getSigners();
  const record = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
  const controller = await ethers.getContractAt(
    "ESOPVestingController",
    record.esopVestingController.address,
  );

  console.log("=".repeat(72));
  console.log("  tokenize-it -- finish funding partly-funded grants");
  console.log("=".repeat(72));
  console.log(`  operator   ${operator.address}`);
  console.log(`  controller ${record.esopVestingController.address}`);

  const only = process.env.GRANT ? Number(process.env.GRANT) : null;
  const next = Number(await controller.nextGrantId());
  const ids = only ? [only] : Array.from({ length: next - 1 }, (_, i) => i + 1);

  let touched = 0;
  for (const id of ids) {
    const grant = await controller.getGrant(id);
    const status = Number(grant[7]); // positional: ethers Result loses names when spread
    if (status !== CREATED) {
      if (only) console.log(`\n  grant #${id} is not awaiting funding (status ${status})`);
      continue;
    }

    touched++;
    console.log(`\n  grant #${id} -> ${grant[0]}`);
    console.log(`     ${grant[3]} of ${grant[2]} funded across ${grant[6]} tranches`);

    // Checked BEFORE sending anything, because this is unrecoverable and the transaction
    // that discovers it costs real gas to learn nothing. A tranche locks until its vesting
    // date, so once that date has passed ATS refuses the lock outright (`${WRONG_EXPIRATION}`,
    // WrongExpirationTimestamp) -- and a grant left unfunded long enough puts its own early
    // tranches in the past. There is no way to fund it afterwards.
    const tranches = await controller.getTranches(id);
    const chainNow = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const stale = tranches
      .slice(Number(grant[6]))
      .filter((t: { vestsAt: bigint }) => BigInt(t.vestsAt) <= chainNow).length;

    if (stale > 0) {
      console.log(`     \x1b[31mcannot be funded\x1b[0m -- ${stale} unfunded tranche(s) vest in the past`);
      console.log(`     ATS will not lock tokens until a date that has already gone by, so`);
      console.log(`     this grant is stuck however much gas you give it. Reissue instead:`);
      console.log(`       EMPLOYEE=${grant[0]} npm run testnet:grant`);
      continue;
    }

    for (let pass = 1; ; pass++) {
      await (await controller.fundTranches(id, FUND_BATCH, FUND_GAS)).wait();
      const now = await controller.getGrant(id);
      console.log(`     pass ${pass}: ${now[6]} tranches locked, ${now[3]} of ${now[2]} funded`);
      if (Number(now[7]) === FUNDED) {
        console.log(`     \x1b[32mfunded\x1b[0m`);
        break;
      }
    }
  }

  console.log(touched === 0 ? "\n  Nothing to do -- every grant is already funded." : "");
}

main().catch((e) => {
  console.error("\n\x1b[31mFAILED\x1b[0m", e);
  process.exitCode = 1;
});
