/**
 * Re-points the treasury's Privy policy at the CURRENT payroll contract.
 *
 * The policy allows the treasury to send to exactly two addresses -- the payroll contract
 * and the stablecoin -- and denies everything else. That is the control which makes the
 * treasury structurally incapable of touching the ESOP token. It is also, therefore, the
 * control that silently breaks the moment the payroll contract is redeployed: the treasury
 * keeps a perfectly valid quorum, signs a perfectly valid transaction, and Privy refuses it
 * with `policy_violation` because the destination is an address the policy has never heard
 * of.
 *
 * Run this after any redeploy that changes `payroll.address`. It updates the existing
 * policy rather than creating a new treasury, which matters: the treasury holds HBAR that
 * had to be transferred in by hand, and a fresh wallet would need funding all over again.
 *
 *   node scripts/sync-payroll-policy.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrivyClient } from "@privy-io/node";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const DEPLOYMENTS = path.resolve(APP, "../../deployments/hedera-testnet.json");

const HEDERA_TESTNET_CHAIN_ID = 296;

// Load .env.local without printing anything from it.
for (const line of fs.readFileSync(path.join(APP, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);

async function main() {
  const record = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
  const org = record.payroll?.org;
  if (!org?.policyId) throw new Error("No policy recorded. Run scripts/setup-payroll-org.mjs first.");

  const privy = new PrivyClient({
    appId: process.env.NEXT_PUBLIC_PRIVY_APP_ID,
    appSecret: process.env.PRIVY_APP_SECRET,
  });

  const allowed = [record.payroll.address, record.payroll.stablecoin];
  console.log("Re-pointing the treasury policy");
  console.log(`  policy     ${org.policyId}`);
  console.log(`  treasury   ${org.treasuryAddress}`);
  console.log(`  payroll    ${record.payroll.address}`);
  console.log(`  stablecoin ${record.payroll.stablecoin}`);

  const before = await privy.policies().get(org.policyId);
  const was = before.rules?.[0]?.conditions?.find((c) => c.field === "to")?.value ?? [];
  console.log(`\n  currently allows: ${JSON.stringify(was)}`);

  if (JSON.stringify([...was].sort()) === JSON.stringify([...allowed].sort())) {
    ok("already correct — nothing to change");
    return;
  }

  // Rules are replaced wholesale, so this restates the ENTIRE policy rather than patching
  // one field. Both conditions have to be re-sent or the chain-id pin would be dropped
  // silently, which would leave the wallet able to sign for any network at all.
  await privy.policies()._update(org.policyId, {
    rules: [
      {
        name: "Only the payroll contract and the stablecoin",
        method: "eth_sendTransaction",
        action: "ALLOW",
        conditions: [
          { field_source: "ethereum_transaction", field: "to", operator: "in", value: allowed },
          {
            field_source: "ethereum_transaction",
            field: "chain_id",
            operator: "eq",
            value: String(HEDERA_TESTNET_CHAIN_ID),
          },
        ],
      },
    ],
  });

  const after = await privy.policies().get(org.policyId);
  const now = after.rules?.[0]?.conditions?.find((c) => c.field === "to")?.value ?? [];
  console.log(`  now allows:       ${JSON.stringify(now)}`);

  // Read it back rather than trusting the write. A policy that silently failed to update
  // fails later, at the worst moment, as an unexplained policy_violation mid-run.
  if (!allowed.every((a) => now.some((n) => n.toLowerCase() === a.toLowerCase()))) {
    throw new Error("Policy did not take the new destinations — refusing to report success.");
  }
  ok("policy now points at the current payroll contract");
}

main().catch((e) => {
  console.error("\n\x1b[31mFAILED\x1b[0m", e.message ?? e);
  process.exitCode = 1;
});
