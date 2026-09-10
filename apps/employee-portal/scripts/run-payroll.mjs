/**
 * Runs payroll from the quorum-owned Privy treasury.
 *
 * This is where the controls stop being configuration and start being load-bearing. Two
 * officers sign the API request with their P-256 keys; Privy's enclave verifies the 2-of-2
 * before it will sign anything with the treasury's own key; the policy independently checks
 * the transaction is going somewhere the treasury is allowed to touch; and the contract
 * checks the recipients are allowlisted employees. Four gates, then one Hedera transaction.
 *
 *   node scripts/run-payroll.mjs
 *   SALARY=4000 node scripts/run-payroll.mjs
 *   OFFICERS_SIGNING=1 node scripts/run-payroll.mjs   # prove the quorum actually bites
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrivyClient, generateAuthorizationSignature } from "@privy-io/node";
import { createPublicClient, http, encodeFunctionData, parseUnits, formatUnits } from "viem";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORTAL = path.resolve(HERE, "..");
const DEPLOYMENTS = path.resolve(PORTAL, "../../deployments/hedera-testnet.json");
const CAIP2 = "eip155:296";

for (const f of [".env.local", ".env.payroll.local"]) {
  const p = path.join(PORTAL, f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    // Strip BOTH quote styles. Leaving a trailing apostrophe on the app id produces a flat
    // "Invalid Privy app ID" from the API, which reads like a credentials problem rather
    // than a parsing one and sent this looking in the wrong place.
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").replace(/\\n/g, "\n");
  }
}

const step = (n, m) => console.log(`\n\x1b[36m[${n}]\x1b[0m ${m}`);
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);

/** Privy wants base64 PKCS8 with no PEM armour; the setup script stored PEM. */
const toBase64Pkcs8 = (pem) =>
  pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");

const erc20 = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];
const payrollAbi = [
  { type: "function", name: "fundRun", stateMutability: "nonpayable", inputs: [{ type: "address[]" }, { type: "uint256[]" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "accrued", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];

async function main() {
  const rec = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
  const org = rec.payroll?.org;
  if (!org) throw new Error("No Privy payroll org recorded. Run setup-payroll-org.mjs first.");

  const keys = [process.env.PAYROLL_OFFICER_1_KEY, process.env.PAYROLL_OFFICER_2_KEY]
    .filter(Boolean)
    .map(toBase64Pkcs8);
  const signing = Number(process.env.OFFICERS_SIGNING ?? keys.length);
  const usingKeys = keys.slice(0, signing);

  const privy = new PrivyClient({
    appId: process.env.NEXT_PUBLIC_PRIVY_APP_ID,
    appSecret: process.env.PRIVY_APP_SECRET,
  });
  const chain = createPublicClient({ transport: http("https://testnet.hashio.io/api") });

  const employee = rec.grants[0].employee;
  const salary = parseUnits(process.env.SALARY ?? "4000", 6);
  const gasPrice = (await chain.getGasPrice()) * 2n;

  console.log("=".repeat(72));
  console.log("  tokenize-it -- payroll, approved by a key quorum");
  console.log("=".repeat(72));
  console.log(`  treasury  ${org.treasuryAddress}`);
  console.log(`  quorum    ${org.keyQuorumId}  (${org.threshold} of ${org.officers})`);
  console.log(`  policy    ${org.policyId}`);
  console.log(`  signing with ${usingKeys.length} officer key(s)`);

  /** Sign the request with each officer key, then send it. */
  async function send(label, to, data) {
    const body = {
      method: "eth_sendTransaction",
      caip2: CAIP2,
      params: { transaction: { to, data, chain_id: 296, gas_price: `0x${gasPrice.toString(16)}`, gas_limit: "0x2DC6C0", value: "0x0" } },
    };
    // Each officer signs the SAME canonical request payload. Privy verifies the threshold
    // against the quorum before its enclave will touch the treasury key, so a run carrying
    // one signature is refused no matter what the request says.
    const input = {
      version: 1,
      method: "POST",
      url: `https://api.privy.io/v1/wallets/${org.treasuryWalletId}/rpc`,
      body,
      headers: { "privy-app-id": process.env.NEXT_PUBLIC_PRIVY_APP_ID },
    };
    const sig = usingKeys
      .map((authorizationPrivateKey) => generateAuthorizationSignature({ authorizationPrivateKey, input }))
      .join(",");
    console.log(`  ${label}: ${sig.split(",").length} signature(s) attached`);
    const res = await privy.wallets()._rpc(org.treasuryWalletId, { ...body, "privy-authorization-signature": sig });
    const hash = res?.data?.hash ?? res?.data?.transaction_hash ?? JSON.stringify(res).slice(0, 80);
    console.log(`  -> ${hash}`);
    await chain.waitForTransactionReceipt({ hash });
    return hash;
  }

  step("1", "Approving the payroll contract to draw the run...");
  await send(
    "approve",
    rec.payroll.stablecoin,
    encodeFunctionData({ abi: erc20, functionName: "approve", args: [rec.payroll.address, salary] }),
  );
  ok("allowed by the policy — the stablecoin is one of the two addresses it permits");

  step("2", `Running payroll: ${formatUnits(salary, 6)} USDC to ${employee}`);
  const before = await chain.readContract({ address: rec.payroll.address, abi: payrollAbi, functionName: "accrued", args: [employee] });
  await send(
    "fundRun",
    rec.payroll.address,
    encodeFunctionData({ abi: payrollAbi, functionName: "fundRun", args: [[employee], [salary]] }),
  );
  const after = await chain.readContract({ address: rec.payroll.address, abi: payrollAbi, functionName: "accrued", args: [employee] });
  console.log(`  -> accrued ${formatUnits(before, 6)} -> ${formatUnits(after, 6)} USDC`);
  if (after - before !== salary) throw new Error("Accrued amount did not match the run.");

  console.log("\n" + "=".repeat(72));
  console.log("  A payroll run took four gates and one Hedera transaction.");
  console.log("=".repeat(72));
}

main().catch((e) => {
  console.error("\n\x1b[31mFAILED\x1b[0m", String(e?.message ?? e).slice(0, 400));
  process.exitCode = 1;
});
