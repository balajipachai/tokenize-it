import "server-only";
import fs from "node:fs";
import path from "node:path";
import { PrivyClient, generateAuthorizationSignature } from "@privy-io/node";
import { createPublicClient, encodeFunctionData, http, parseUnits, formatUnits, type Address } from "viem";

/**
 * Server side of payroll.
 *
 * The officer keys live here rather than in the browser, which is the honest shape for a
 * demo but NOT what a real deployment looks like: each officer should hold their own key and
 * approve from their own client, so that no single machine can produce a full quorum. What
 * this preserves is the part worth demonstrating — approvals are counted, and a run cannot
 * go out until the threshold is met.
 */

const RPC = process.env.NEXT_PUBLIC_RPC_URL ?? "https://testnet.hashio.io/api";
const CAIP2 = "eip155:296";
const CHAIN_ID = 296;

export const publicClient = createPublicClient({ transport: http(RPC) });

const erc20Abi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const payrollAbi = [
  { type: "function", name: "fundRun", stateMutability: "nonpayable", inputs: [{ type: "address[]" }, { type: "uint256[]" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "accrued", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "lifetimeEarned", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalAccrued", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

interface Org {
  treasuryWalletId: string;
  treasuryAddress: Address;
  keyQuorumId: string;
  threshold: number;
  officers: number;
  policyId: string;
}

export interface Deployment {
  payroll: { address: Address; stablecoin: Address; org: Org };
}

export function deployment(): Deployment {
  const root = process.env.TOKENIZE_IT_ROOT ?? path.resolve(process.cwd(), "../..");
  const raw = fs.readFileSync(path.join(root, "deployments", "hedera-testnet.json"), "utf8");
  const record = JSON.parse(raw);
  if (!record.payroll?.org) throw new Error("No Privy payroll org recorded. Run setup-payroll-org.mjs.");
  return record;
}

/** Officer signing keys, as base64 PKCS8 with no PEM armour — the form Privy expects. */
function officerKeys(): string[] {
  const root = process.env.TOKENIZE_IT_ROOT ?? path.resolve(process.cwd(), "../..");
  const file = path.join(root, "apps", "web", ".env.payroll.local");
  if (!fs.existsSync(file)) return [];
  const keys: string[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^PAYROLL_OFFICER_\d+_KEY=(.*)$/);
    if (!m) continue;
    const pem = m[1].replace(/^["']|["']$/g, "").replace(/\\n/g, "\n");
    keys.push(pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, ""));
  }
  return keys;
}

export function officerCount(): number {
  return officerKeys().length;
}

/**
 * Privy credentials come from the portal's .env.local rather than a second copy here.
 *
 * One secret in one place: duplicating an app secret across two apps means two files to
 * rotate and one of them will be missed. The officer keys are read from the same directory
 * for the same reason.
 */
function loadPortalEnv(): void {
  if (process.env.PRIVY_APP_SECRET && process.env.NEXT_PUBLIC_PRIVY_APP_ID) return;
  const root = process.env.TOKENIZE_IT_ROOT ?? path.resolve(process.cwd(), "../..");
  const file = path.join(root, "apps", "web", ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    // Both quote styles: a stray apostrophe left on the app id reads back as
    // "Invalid Privy app ID", which looks like bad credentials rather than bad parsing.
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function privy(): PrivyClient {
  loadPortalEnv();
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) throw new Error("Privy credentials are not configured for the console.");
  return new PrivyClient({ appId, appSecret });
}

/**
 * A run awaiting approval. In memory on purpose: a pending run is a draft, and losing drafts
 * on restart is a smaller problem than persisting a half-approved payment instruction.
 */
export interface PendingRun {
  id: string;
  recipients: Address[];
  amounts: string[];
  total: string;
  approvals: number[];
  createdAt: number;
}

let pending: PendingRun | null = null;

export function getPending(): PendingRun | null {
  return pending;
}

export function draftRun(recipients: Address[], amounts: string[]): PendingRun {
  if (recipients.length === 0) throw new Error("Nobody to pay.");
  if (recipients.length !== amounts.length) throw new Error("Recipient and amount counts differ.");
  const total = amounts.reduce((sum, a) => sum + parseUnits(a, 6), 0n);
  if (total === 0n) throw new Error("A run must pay something.");
  pending = {
    id: `run-${Date.now()}`,
    recipients,
    amounts,
    total: formatUnits(total, 6),
    approvals: [],
    createdAt: Date.now(),
  };
  return pending;
}

export function approveRun(officerIndex: number): PendingRun {
  if (!pending) throw new Error("No run is waiting for approval.");
  if (officerIndex < 0 || officerIndex >= officerCount()) throw new Error("No such officer.");
  if (pending.approvals.includes(officerIndex)) throw new Error("That officer has already approved this run.");
  pending.approvals.push(officerIndex);
  return pending;
}

export function discardRun(): void {
  pending = null;
}

/** Signs one request with every officer who approved, and sends it. */
async function sendFromTreasury(to: Address, data: `0x${string}`): Promise<`0x${string}`> {
  const d = deployment();
  const org = d.payroll.org;
  const keys = officerKeys();
  const approving = (pending?.approvals ?? []).map((i) => keys[i]);

  const gasPrice = (await publicClient.getGasPrice()) * 2n;
  const body = {
    method: "eth_sendTransaction",
    caip2: CAIP2,
    params: {
      transaction: {
        to,
        data,
        chain_id: CHAIN_ID,
        gas_price: `0x${gasPrice.toString(16)}`,
        gas_limit: "0x2DC6C0",
        value: "0x0",
      },
    },
  };

  // Every approving officer signs the SAME canonical payload. Privy counts the signatures
  // against the quorum before its enclave will touch the treasury key, so submitting with
  // too few is refused there rather than here — the threshold is not ours to enforce.
  loadPortalEnv();
  const input = {
    version: 1 as const,
    method: "POST" as const,
    url: `https://api.privy.io/v1/wallets/${org.treasuryWalletId}/rpc`,
    body,
    headers: { "privy-app-id": process.env.NEXT_PUBLIC_PRIVY_APP_ID! },
  };
  const signature = approving
    .map((authorizationPrivateKey) => generateAuthorizationSignature({ authorizationPrivateKey, input }))
    .join(",");

  const res = (await privy()
    .wallets()
    ._rpc(org.treasuryWalletId, {
      ...body,
      "privy-authorization-signature": signature,
    } as never)) as {
    data?: { hash?: `0x${string}`; transaction_hash?: `0x${string}` };
  };
  const hash = res?.data?.hash ?? res?.data?.transaction_hash;
  if (!hash) throw new Error("Privy accepted the request but returned no transaction hash.");
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function submitRun(): Promise<{ approveTx: string; runTx: string }> {
  if (!pending) throw new Error("No run is waiting for approval.");
  const d = deployment();
  if (pending.approvals.length < d.payroll.org.threshold) {
    throw new Error(`Needs ${d.payroll.org.threshold} approvals, has ${pending.approvals.length}.`);
  }

  const total = pending.amounts.reduce((sum, a) => sum + parseUnits(a, 6), 0n);

  const approveTx = await sendFromTreasury(
    d.payroll.stablecoin,
    encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.payroll.address, total] }),
  );
  const runTx = await sendFromTreasury(
    d.payroll.address,
    encodeFunctionData({
      abi: payrollAbi,
      functionName: "fundRun",
      args: [pending.recipients, pending.amounts.map((a) => parseUnits(a, 6))],
    }),
  );

  pending = null;
  return { approveTx, runTx };
}

export interface PayrollState {
  payrollAddress: Address;
  stablecoin: Address;
  treasury: Address;
  threshold: number;
  officers: number;
  quorumId: string;
  policyId: string;
  treasuryBalance: string;
  totalAccrued: string;
  pending: PendingRun | null;
}

export async function readPayroll(): Promise<PayrollState> {
  const d = deployment();
  const org = d.payroll.org;
  const [balance, accrued] = await Promise.all([
    publicClient.readContract({ address: d.payroll.stablecoin, abi: erc20Abi, functionName: "balanceOf", args: [org.treasuryAddress] }),
    publicClient.readContract({ address: d.payroll.address, abi: payrollAbi, functionName: "totalAccrued" }),
  ]);
  return {
    payrollAddress: d.payroll.address,
    stablecoin: d.payroll.stablecoin,
    treasury: org.treasuryAddress,
    threshold: org.threshold,
    officers: officerCount() || org.officers,
    quorumId: org.keyQuorumId,
    policyId: org.policyId,
    treasuryBalance: formatUnits(balance, 6),
    totalAccrued: formatUnits(accrued, 6),
    pending,
  };
}

/** What each employee is owed and has ever earned. */
export async function readEarnings(employees: Address[]) {
  const d = deployment();
  return Promise.all(
    employees.map(async (address) => {
      const [accrued, lifetime] = await Promise.all([
        publicClient.readContract({ address: d.payroll.address, abi: payrollAbi, functionName: "accrued", args: [address] }),
        publicClient.readContract({ address: d.payroll.address, abi: payrollAbi, functionName: "lifetimeEarned", args: [address] }),
      ]);
      return { address, accrued: formatUnits(accrued, 6), lifetime: formatUnits(lifetime, 6) };
    }),
  );
}
