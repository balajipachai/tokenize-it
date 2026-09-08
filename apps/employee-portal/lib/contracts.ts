import "server-only";
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "./chain";
import { controllerAbi, tokenAbi } from "./abi";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

interface Deployment {
  esopToken: { address: Address; name: string; symbol: string; partition: `0x${string}` };
  esopVestingController?: { address: Address };
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
}

export interface PositionView {
  wallet: Address;
  token: { address: Address; name: string; symbol: string };
  controller: Address;
  hasGrant: boolean;
  grantId: number | null;
  status: number;
  granted: number;
  vested: number;
  unvested: number;
  claimable: number;
  spendable: number;
  locked: number;
  nextVestAt: number | null;
  tranches: TrancheView[];
}

export async function readPosition(wallet: Address): Promise<PositionView> {
  const d = deployment();
  const controller = d.esopVestingController!.address;

  const base = {
    wallet,
    token: { address: d.esopToken.address, name: d.esopToken.name, symbol: d.esopToken.symbol },
    controller,
  };

  const [grantIds, spendable, locked] = await Promise.all([
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
  ]);

  if (grantIds.length === 0) {
    return {
      ...base,
      hasGrant: false,
      grantId: null,
      status: 0,
      granted: 0,
      vested: 0,
      unvested: 0,
      claimable: 0,
      spendable: Number(spendable),
      locked: Number(locked),
      nextVestAt: null,
      tranches: [],
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

  const now = Math.floor(Date.now() / 1000);
  return {
    ...base,
    hasGrant: true,
    grantId: Number(grantId),
    status: grant.status,
    granted: Number(grant.totalAmount),
    vested: Number(vested),
    unvested: Number(unvested),
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
    })),
  };
}

export async function relayClaim(grantId: number): Promise<`0x${string}`> {
  const d = deployment();
  const wallet = relayer();
  const hash = await wallet.writeContract({
    address: d.esopVestingController!.address,
    abi: controllerAbi,
    functionName: "releaseVested",
    args: [BigInt(grantId), 20],
    chain: hederaTestnet,
    account: wallet.account,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
