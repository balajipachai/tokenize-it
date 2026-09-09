import "server-only";
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "./chain";
import { controllerAbi, controllerEvents, tokenAbi } from "./abi";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

interface Deployment {
  esopToken: { address: Address; name: string; symbol: string; partition: `0x${string}` };
  esopVestingController?: { address: Address; creationTxHash?: `0x${string}` | null };
}

let cached: Deployment | null = null;

/** Reads addresses from the repo's deployment record rather than duplicating them in env. */
export function deployment(): Deployment {
  if (cached) return cached;
  const file = path.resolve(process.cwd(), "../../deployments/hedera-testnet.json");
  if (!fs.existsSync(file)) {
    throw new Error(`No deployment record at ${file}. Run 'npm run testnet:deploy-controller' from the repo root.`);
  }
  cached = JSON.parse(fs.readFileSync(file, "utf8")) as Deployment;
  if (!cached.esopVestingController) {
    throw new Error("Deployment record has no controller. Run 'npm run testnet:deploy-controller'.");
  }
  return cached;
}

export const publicClient = createPublicClient({ chain: hederaTestnet, transport: http() });

/** Hedera's ceiling for a single transaction. */
const MAX_TX_GAS = 15_000_000n;

/**
 * A gas limit from `eth_estimateGas`, tripled.
 *
 * Two measured facts set this, and the second is the one that makes it safe:
 *
 *  1. Hedera's estimator UNDER-counts. It came back 11% low on a bare ERC-20 mint
 *     (35,869 estimated against 40,503 actually used) and roughly half on anything that
 *     loops into the ATS diamond — 523k for a release that needs ~1.05M, which is how a
 *     claim once died at 99.99% of its limit with an empty revert reason. Passing an
 *     estimate through untouched is a way to run out of gas.
 *
 *  2. Over-offering is FREE. Charged fee tracks gas USED, not the limit offered. Measured
 *     directly: the same mint, offered 120,000 and then 900,000, cost 0.03710687 HBAR both
 *     times. (This corrects a belief held through much of this project's history — that
 *     Hedera bills most of the offered limit — which had been used to argue AGAINST
 *     generous limits. It is wrong, and it made every gas decision here more anxious than
 *     it needed to be.)
 *
 * So: estimate to stay adaptive, triple it to survive the undercount, and pay nothing for
 * the headroom. `floor` covers the case where estimation itself fails.
 */
export async function gasFor(
  estimate: () => Promise<bigint>,
  floor: bigint,
): Promise<bigint> {
  let limit: bigint;
  try {
    limit = (await estimate()) * 3n;
  } catch {
    // A failed estimate usually means the call would revert, and the real error is far more
    // useful coming from the chain than from here. Send it with the floor and let it speak.
    limit = floor;
  }
  if (limit < floor) limit = floor;
  return limit > MAX_TX_GAS ? MAX_TX_GAS : limit;
}

/**
 * The relayer. It pays for every transaction the portal makes, which is what lets an
 * employee hold equity on an unactivated Hedera account and never touch HBAR.
 *
 * Its authority is deliberately narrow: it can trigger `releaseVested`, which is
 * permissionless on-chain anyway, so a compromised relayer can waste gas but cannot
 * move anybody's equity. Anything that pledges or transfers an employee's tokens must
 * be authorised by that employee's own EIP-712 signature (Phase 4).
 */
export function relayer() {
  const account = privateKeyToAccount(requireEnv("RELAYER_PRIVATE_KEY") as `0x${string}`);
  return createWalletClient({ account, chain: hederaTestnet, transport: http() });
}

export interface TrancheView {
  index: number;
  amount: number;
  vestsAt: number;
  released: boolean;
  clawedBack: boolean;
  vested: boolean;
  /** Transaction that released this tranche, once it has been claimed. */
  txHash: string | null;
}

export interface ComplianceView {
  kycGranted: boolean;
  allowlisted: boolean;
  credentialId: string | null;
  issuer: string | null;
  validTo: number | null;
}

export interface PositionView {
  wallet: Address;
  token: { address: Address; name: string; symbol: string };
  controller: Address;
  hasGrant: boolean;
  grantId: number | null;
  /** How many grants this wallet holds. The balance spans all of them; the rest is the latest. */
  grantCount: number;
  status: number;
  granted: number;
  vested: number;
  unvested: number;
  /** Forfeited on termination. Derived, so it works against older deployments too. */
  clawedBack: number;
  claimable: number;
  spendable: number;
  locked: number;
  nextVestAt: number | null;
  tranches: TrancheView[];
  compliance: ComplianceView;
}

/** Block the controller was created in, so log queries have a bounded range. */
let deployBlock: bigint | null = null;
async function controllerDeployBlock(): Promise<bigint> {
  if (deployBlock !== null) return deployBlock;
  const hash = deployment().esopVestingController!.creationTxHash;
  if (hash) {
    try {
      deployBlock = (await publicClient.getTransactionReceipt({ hash })).blockNumber;
      return deployBlock;
    } catch {
      /* fall through to the bounded window below */
    }
  }
  // Hashio rejects unbounded eth_getLogs ranges, so never pass "earliest".
  const head = await publicClient.getBlockNumber();
  deployBlock = head > 100_000n ? head - 100_000n : 0n;
  return deployBlock;
}

/**
 * Maps tranche index to the transaction that released it, by reading TrancheVested
 * logs. Best-effort: if the RPC refuses the range the schedule simply renders without
 * links rather than the whole page failing.
 */
async function vestTxByTranche(
  controller: Address,
  grantId: bigint,
  wallet: Address,
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    const logs = await publicClient.getLogs({
      address: controller,
      event: controllerEvents[0],
      args: { grantId, employee: wallet },
      fromBlock: await controllerDeployBlock(),
      toBlock: "latest",
    });
    for (const log of logs) {
      const index = Number(log.args.trancheIndex);
      if (!Number.isNaN(index)) map.set(index, log.transactionHash);
    }
  } catch (err) {
    console.warn("Could not read TrancheVested logs; schedule will render without links.", err);
  }
  return map;
}

/**
 * Largest instant a JS Date can represent, in seconds. A KYC `validTo` is a uint256, and
 * ATS conventionally uses MAX_UINT256 to mean "no expiry" — converting that to a Date
 * yields Invalid Date, and toISOString() then throws and takes the page down. Anything
 * beyond this is reported as "no expiry" rather than a date, which is also what it means.
 */
const MAX_JS_DATE_SECONDS = 8_640_000_000_000n;

async function readCompliance(token: Address, wallet: Address): Promise<ComplianceView> {
  const [kyc, allowlisted] = await Promise.all([
    publicClient.readContract({ address: token, abi: tokenAbi, functionName: "getKycFor", args: [wallet] }),
    publicClient.readContract({ address: token, abi: tokenAbi, functionName: "isInControlList", args: [wallet] }),
  ]);
  const granted = Number(kyc.status) === 1;
  return {
    kycGranted: granted,
    allowlisted,
    credentialId: granted && kyc.vcId ? kyc.vcId : null,
    issuer: granted ? kyc.issuer : null,
    validTo: granted && kyc.validTo > 0n && kyc.validTo <= MAX_JS_DATE_SECONDS ? Number(kyc.validTo) : null,
  };
}

export async function readPosition(wallet: Address): Promise<PositionView> {
  const d = deployment();
  const controller = d.esopVestingController!.address;

  const base = {
    wallet,
    token: { address: d.esopToken.address, name: d.esopToken.name, symbol: d.esopToken.symbol },
    controller,
  };

  const [grantIds, spendable, locked, compliance] = await Promise.all([
    publicClient.readContract({ address: controller, abi: controllerAbi, functionName: "grantsOf", args: [wallet] }),
    publicClient.readContract({
      address: d.esopToken.address,
      abi: tokenAbi,
      functionName: "balanceOfByPartition",
      args: [d.esopToken.partition, wallet],
    }),
    publicClient.readContract({
      address: d.esopToken.address,
      abi: tokenAbi,
      functionName: "getLockedAmountForByPartition",
      args: [d.esopToken.partition, wallet],
    }),
    readCompliance(d.esopToken.address, wallet),
  ]);

  if (grantIds.length === 0) {
    return {
      ...base,
      hasGrant: false,
      grantId: null,
      grantCount: 0,
      status: 0,
      granted: 0,
      vested: 0,
      unvested: 0,
      clawedBack: 0,
      claimable: 0,
      spendable: Number(spendable),
      locked: Number(locked),
      nextVestAt: null,
      tranches: [],
      compliance,
    };
  }

  // One grant per employee is the common case; show the most recent.
  const grantId = grantIds[grantIds.length - 1];

  const [grant, tranches, vested, unvested, nextVest, pending] = await Promise.all([
    publicClient.readContract({ address: controller, abi: controllerAbi, functionName: "getGrant", args: [grantId] }),
    publicClient.readContract({
      address: controller,
      abi: controllerAbi,
      functionName: "getTranches",
      args: [grantId],
    }),
    publicClient.readContract({
      address: controller,
      abi: controllerAbi,
      functionName: "vestedAmount",
      args: [grantId],
    }),
    publicClient.readContract({
      address: controller,
      abi: controllerAbi,
      functionName: "unvestedAmount",
      args: [grantId],
    }),
    publicClient.readContract({ address: controller, abi: controllerAbi, functionName: "nextVestAt", args: [grantId] }),
    publicClient.readContract({
      address: controller,
      abi: controllerAbi,
      functionName: "pendingTranches",
      args: [grantId],
    }),
  ]);

  const vestTx = await vestTxByTranche(controller, grantId, wallet);
  const now = Math.floor(Date.now() / 1000);
  return {
    ...base,
    hasGrant: true,
    grantId: Number(grantId),
    grantCount: grantIds.length,
    status: grant.status,
    granted: Number(grant.totalAmount),
    vested: Number(vested),
    unvested: Number(unvested),
    // Derived: vestedAmount and unvestedAmount both skip forfeited tranches, so the gap
    // to the total IS what was forfeited. Without it the employee's figures do not add up.
    clawedBack: Number(grant.totalAmount) - Number(vested) - Number(unvested),
    // `pendingTranches` counts tranches that have vested but not yet been released.
    claimable: Number(pending),
    spendable: Number(spendable),
    locked: Number(locked),
    nextVestAt: Number(nextVest) === 0 ? null : Number(nextVest),
    tranches: tranches.map((t, index) => ({
      index,
      amount: Number(t.amount),
      vestsAt: Number(t.vestsAt),
      released: t.released,
      clawedBack: t.clawedBack,
      vested: Number(t.vestsAt) <= now,
      txHash: vestTx.get(index) ?? null,
    })),
    compliance,
  };
}

/**
 * Gas for a release, sized from the work rather than from eth_estimateGas.
 *
 * Hedera's estimator under-counts loops that call into the ATS diamond — it returned
 * 523k for a release that needs ~1.05M, and the transaction died at 99.99% of its
 * limit with an empty revert reason. Our own measurement is the better number:
 * releaseVested(12) costs 1,049,811 gas, so ~88k per tranche, and 140k carries real
 * headroom.
 *
 * The headroom costs nothing: charged fee tracks gas USED, not the limit offered — the
 * same call offered 120k and 900k cost an identical 0.03710687 HBAR. An earlier version of
 * this comment claimed the opposite and used it to argue for tight limits; that was wrong.
 * See `gasFor` above, which is the general form of this and should be preferred for new
 * call sites. This one stays measurement-based because a per-tranche figure we measured
 * beats an estimate we know under-counts precisely this shape of work.
 */
function releaseGas(tranches: number): bigint {
  const limit = 250_000n + 140_000n * BigInt(Math.max(tranches, 1));
  return limit > 14_000_000n ? 14_000_000n : limit;
}

/**
 * Submits the release and returns as soon as the transaction has a hash, WITHOUT
 * waiting for the receipt. That is deliberate: it lets the UI show a working
 * HashScan link while the transaction is still confirming, instead of leaving the
 * employee staring at a spinner with nothing to look at. The caller polls
 * `txStatus` to find out how it ended.
 */
export async function submitClaim(grantId: number, tranches: number): Promise<`0x${string}`> {
  const d = deployment();
  const wallet = relayer();
  // Price from the network too: Hedera rejects raw transactions offered below its
  // minimum, which surfaces as an opaque HTTP error rather than a revert.
  const gasPrice = await publicClient.getGasPrice();
  return wallet.writeContract({
    address: d.esopVestingController!.address,
    abi: controllerAbi,
    functionName: "releaseVested",
    args: [BigInt(grantId), Math.max(tranches, 1)],
    chain: hederaTestnet,
    account: wallet.account,
    gas: releaseGas(tranches),
    gasPrice: (gasPrice * 120n) / 100n,
  });
}

/** Receipt-backed outcome, so a revert is reported rather than inferred from balances. */
export async function txStatus(hash: `0x${string}`): Promise<"pending" | "success" | "reverted"> {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    return receipt.status === "success" ? "success" : "reverted";
  } catch {
    return "pending";
  }
}
