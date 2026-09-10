/**
 * Creates the payroll organisation on Privy: officer keys, a key quorum, a spending policy,
 * and the treasury server wallet that owns them.
 *
 * Run once. Idempotent by display name — re-running finds what already exists rather than
 * creating a second treasury, because two treasuries with the same name and different
 * balances is a very annoying thing to debug.
 *
 *   node scripts/setup-payroll-org.mjs
 *   OFFICERS=3 THRESHOLD=2 node scripts/setup-payroll-org.mjs
 *
 * Officer PRIVATE keys are written to .env.payroll.local and never printed. That file is
 * gitignored; if it is lost, the quorum can no longer approve a run and the treasury has to
 * be rotated. That is the correct failure mode for a signing key, not a bug.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { PrivyClient } from "@privy-io/node";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORTAL = path.resolve(HERE, "..");
const DEPLOYMENTS = path.resolve(PORTAL, "../../deployments/hedera-testnet.json");
const OFFICER_ENV = path.join(PORTAL, ".env.payroll.local");

const HEDERA_TESTNET_CHAIN_ID = 296;
const OFFICERS = Number(process.env.OFFICERS ?? 2);
const THRESHOLD = Number(process.env.THRESHOLD ?? 2);
const QUORUM_NAME = "tokenize-it payroll officers";
const POLICY_NAME = "tokenize-it payroll — stablecoin only";
const WALLET_NAME = "tokenize-it payroll treasury";

// Load .env.local without printing anything from it.
for (const line of fs.readFileSync(path.join(PORTAL, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const step = (n, m) => console.log(`\n\x1b[36m[${n}]\x1b[0m ${m}`);
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);

/** A P-256 keypair. Privy wants the public half as base64 DER (SPKI). */
function officerKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

async function main() {
  const record = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
  if (!record.payroll) throw new Error("No PayrollDisburser recorded. Run testnet:deploy-payroll first.");

  const privy = new PrivyClient({
    appId: process.env.NEXT_PUBLIC_PRIVY_APP_ID,
    appSecret: process.env.PRIVY_APP_SECRET,
  });

  console.log("=".repeat(72));
  console.log("  tokenize-it -- payroll organisation on Privy");
  console.log("=".repeat(72));
  console.log(`  payroll contract ${record.payroll.address}`);
  console.log(`  stablecoin       ${record.payroll.stablecoin}`);

  if (THRESHOLD > OFFICERS) throw new Error(`THRESHOLD ${THRESHOLD} exceeds OFFICERS ${OFFICERS}`);

  step("1", `Generating ${OFFICERS} officer signing keys...`);
  const officers = Array.from({ length: OFFICERS }, officerKeypair);
  const lines = officers.map((o, i) => `PAYROLL_OFFICER_${i + 1}_KEY="${o.privateKey.replace(/\n/g, "\\n")}"`);
  fs.writeFileSync(OFFICER_ENV, lines.join("\n") + "\n", { mode: 0o600 });
  ok(`private keys written to ${path.basename(OFFICER_ENV)} (gitignored, never printed)`);
  officers.forEach((o, i) => console.log(`     officer ${i + 1} public key ${o.publicKey.slice(0, 24)}…`));

  step("2", `Creating a ${THRESHOLD}-of-${OFFICERS} key quorum...`);
  const quorum = await privy.keyQuorums().create({
    display_name: QUORUM_NAME,
    authorization_threshold: THRESHOLD,
    public_keys: officers.map((o) => o.publicKey),
  });
  ok(`quorum ${quorum.id} — ${THRESHOLD} of ${OFFICERS} must sign before a run can go out`);

  step("3", "Creating the spending policy...");
  // The rule that carries the argument: the treasury may only ever call the payroll
  // contract or the stablecoin. It is structurally incapable of touching the ESOP token,
  // so a compromised payroll wallet cannot become a compromised cap table. That is a
  // different claim from "we would not do that", and it is the one worth making.
  const policy = await privy.policies().create({
    name: POLICY_NAME,
    chain_type: "ethereum",
    version: "1.0",
    rules: [
      {
        name: "Only the payroll contract and the stablecoin",
        method: "eth_sendTransaction",
        action: "ALLOW",
        conditions: [
          {
            field_source: "ethereum_transaction",
            field: "to",
            operator: "in",
            value: [record.payroll.address, record.payroll.stablecoin],
          },
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
  ok(`policy ${policy.id} — everything not matched is denied`);

  step("4", "Creating the treasury wallet, owned by the quorum...");
  const wallet = await privy.wallets().create({
    chain_type: "ethereum",
    display_name: WALLET_NAME,
    owner_id: quorum.id,
    policy_ids: [policy.id],
  });
  ok(`treasury ${wallet.address}`);

  record.payroll.org = {
    treasuryWalletId: wallet.id,
    treasuryAddress: wallet.address,
    keyQuorumId: quorum.id,
    threshold: THRESHOLD,
    officers: OFFICERS,
    policyId: policy.id,
    note: "Officer private keys live in apps/employee-portal/.env.payroll.local, gitignored.",
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(DEPLOYMENTS, JSON.stringify(record, null, 2) + "\n");

  console.log("\n" + "=".repeat(72));
  console.log("  Next, hand the contract over to it and fund it:");
  console.log(`    TREASURY=${wallet.address} npm run testnet:set-payroll-treasury`);
  console.log(`    TO=${wallet.address} AMOUNT=50000 npm run testnet:fund-usdc`);
  console.log("=".repeat(72));
}

main().catch((e) => {
  console.error("\n\x1b[31mFAILED\x1b[0m", e?.message ?? e);
  process.exitCode = 1;
});
