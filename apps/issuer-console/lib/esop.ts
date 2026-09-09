"use client";

import type { Address } from "viem";
import { hederaTestnet } from "./chain";
import { publicClient, walletClient } from "./wallet";
import { controllerAbi, tokenAbi } from "./abi";

export interface Deployment {
  esopToken: { address: Address; name: string; symbol: string; partition: `0x${string}` };
  esopVestingController: { address: Address; admin: Address };
  grants?: { grantId: number; employee: Address }[];
  demoGrant?: { grantId: number; employee: Address };
}

export const GrantStatus = ["None", "Funding", "Active", "Terminated"] as const;
export const LeaverType = ["None", "Good", "Bad"] as const;

export interface Holder {
  address: Address;
  kycGranted: boolean;
  allowlisted: boolean;
  credentialId: string | null;
  validTo: number | null;
  spendable: number;
  locked: number;
  grantId: number | null;
  status: number;
  granted: number;
  vested: number;
  unvested: number;
}

export interface Schedule {
  amounts: bigint[];
  dates: bigint[];
}

/**
 * Turns HR's inputs into tranches. The cliff is a single tranche at the cliff date;
 * the remainder is split evenly across the rest of the term, with any rounding
 * remainder folded into the final tranche so the tranches always sum to the total.
 */
export function buildSchedule(
  total: number,
  cliffPercent: number,
  cliffSeconds: number,
  trancheCount: number,
  trancheSeconds: number,
  from = Math.floor(Date.now() / 1000),
): Schedule {
  const cliffAmount = Math.floor((total * cliffPercent) / 100);
  const rest = total - cliffAmount;
  const per = Math.floor(rest / trancheCount);
  const remainder = rest - per * trancheCount;

  const amounts: bigint[] = [BigInt(cliffAmount)];
  const dates: bigint[] = [BigInt(from + cliffSeconds)];
  for (let i = 1; i <= trancheCount; i++) {
    // The last tranche absorbs the rounding remainder rather than dropping it.
    amounts.push(BigInt(i === trancheCount ? per + remainder : per));
    dates.push(BigInt(from + cliffSeconds + i * trancheSeconds));
  }
  return { amounts, dates };
}

export async function readHolder(d: Deployment, address: Address): Promise<Holder> {
  const token = d.esopToken.address;
  const controller = d.esopVestingController.address;
  const partition = d.esopToken.partition;

  const [kyc, allowlisted, spendable, locked, grantIds] = await Promise.all([
    publicClient.readContract({ address: token, abi: tokenAbi, functionName: "getKycFor", args: [address] }),
    publicClient.readContract({ address: token, abi: tokenAbi, functionName: "isInControlList", args: [address] }),
    publicClient.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "balanceOfByPartition",
      args: [partition, address],
    }),
    publicClient.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "getLockedAmountForByPartition",
      args: [partition, address],
    }),
    publicClient.readContract({ address: controller, abi: controllerAbi, functionName: "grantsOf", args: [address] }),
  ]);

  const base = {
    address,
    kycGranted: Number(kyc.status) === 1,
    allowlisted,
    credentialId: kyc.vcId || null,
    validTo: kyc.validTo > 0n ? Number(kyc.validTo) : null,
    spendable: Number(spendable),
    locked: Number(locked),
  };

  if (grantIds.length === 0) {
    return { ...base, grantId: null, status: 0, granted: 0, vested: 0, unvested: 0 };
  }

  const grantId = grantIds[grantIds.length - 1];
  const [grant, vested, unvested] = await Promise.all([
    publicClient.readContract({ address: controller, abi: controllerAbi, functionName: "getGrant", args: [grantId] }),
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
  ]);

  return {
    ...base,
    grantId: Number(grantId),
    status: grant.status,
    granted: Number(grant.totalAmount),
    vested: Number(vested),
    unvested: Number(unvested),
  };
}

/**
 * Hedera rejects raw transactions whose gas price is below the network minimum, and
 * MetaMask — which does not know this chain well — sometimes offers less. That surfaces
 * as an opaque "RPC endpoint returned HTTP client error" at eth_sendRawTransaction,
 * which reads like a contract revert but is not one.
 *
 * So price every write from the network rather than leaving it to the wallet. The gas
 * LIMIT is still estimated rather than hardcoded: Hedera charges most of the offered
 * limit even when unused, so an over-generous constant is a real cost, not free safety.
 */
async function txOverrides(estimate: bigint) {
  const price = await publicClient.getGasPrice();
  return {
    gas: (estimate * 115n) / 100n,
    gasPrice: (price * 120n) / 100n,
  };
}

async function send(account: Address, hash: Promise<`0x${string}`>) {
  const tx = await hash;
  await publicClient.waitForTransactionReceipt({ hash: tx });
  return tx;
}

interface WriteArgs {
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
}

/** Estimates, prices, submits and waits — the path every issuer write takes. */
async function write(account: Address, call: WriteArgs): Promise<`0x${string}`> {
  const estimate = await publicClient.estimateContractGas({ ...call, account } as never);
  const overrides = await txOverrides(estimate);
  const w = walletClient(account);
  return send(
    account,
    w.writeContract({ ...call, ...overrides, account, chain: hederaTestnet } as never),
  );
}

export async function onboard(d: Deployment, account: Address, employee: Address, credentialRef: string) {
  const token = d.esopToken.address;

  // grantKyc reverts unless the attesting issuer is registered, so make sure the
  // signer is one before attesting as themselves.
  const registered = await publicClient.readContract({
    address: token,
    abi: tokenAbi,
    functionName: "isIssuer",
    args: [account],
  });
  if (!registered) {
    await write(account, { address: token, abi: tokenAbi, functionName: "addIssuer", args: [account] });
  }

  const kyc = await publicClient.readContract({
    address: token,
    abi: tokenAbi,
    functionName: "getKycFor",
    args: [employee],
  });
  if (Number(kyc.status) !== 1) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const validTo = now + 365n * 24n * 60n * 60n;
    await write(account, {
      address: token,
      abi: tokenAbi,
      functionName: "grantKyc",
      args: [employee, credentialRef, now, validTo, account],
    });
  }

  const listed = await publicClient.readContract({
    address: token,
    abi: tokenAbi,
    functionName: "isInControlList",
    args: [employee],
  });
  if (!listed) {
    await write(account, { address: token, abi: tokenAbi, functionName: "addToControlList", args: [employee] });
  }
}

export async function issueGrant(
  d: Deployment,
  account: Address,
  employee: Address,
  schedule: Schedule,
  onProgress: (funded: number, total: number) => void,
): Promise<number> {
  const controller = d.esopVestingController.address;

  const grantId = await publicClient.readContract({
    address: controller,
    abi: controllerAbi,
    functionName: "nextGrantId",
  });

  await write(account, {
    address: controller,
    abi: controllerAbi,
    functionName: "createGrant",
    args: [employee, d.esopToken.partition, schedule.amounts, schedule.dates],
  });

  // Measured on testnet: ~230k gas per tranche when batched, so ~40 fits comfortably
  // under Hedera's 15M ceiling. (A tranche costs ~425k as its OWN transaction — the
  // difference is the base fee and calldata amortising, and storage staying warm.)
  const total = schedule.amounts.length;
  for (;;) {
    await write(account, {
      address: controller,
      abi: controllerAbi,
      functionName: "fundTranches",
      args: [grantId, 40],
    });
    const g = await publicClient.readContract({
      address: controller,
      abi: controllerAbi,
      functionName: "getGrant",
      args: [grantId],
    });
    onProgress(Number(g.fundedTranches), total);
    if (g.status === 2) break;
  }
  return Number(grantId);
}

export async function terminateGrant(
  d: Deployment,
  account: Address,
  grantId: number,
  leaver: 1 | 2,
  effectiveAt: number,
) {
  await write(account, {
    address: d.esopVestingController.address,
    abi: controllerAbi,
    functionName: "terminate",
    args: [BigInt(grantId), leaver, BigInt(effectiveAt)],
  });
}

export async function clawbackGrant(d: Deployment, account: Address, grantId: number): Promise<number> {
  const controller = d.esopVestingController.address;
  let rounds = 0;
  for (;;) {
    await write(account, {
      address: controller,
      abi: controllerAbi,
      functionName: "clawback",
      args: [BigInt(grantId), 40],
    });
    rounds++;
    const left = await publicClient.readContract({
      address: controller,
      abi: controllerAbi,
      functionName: "unvestedAmount",
      args: [BigInt(grantId)],
    });
    if (left === 0n || rounds > 5) return rounds;
  }
}

export async function setFrozen(d: Deployment, account: Address, employee: Address, frozen: boolean) {
  await write(account, {
    address: d.esopToken.address,
    abi: tokenAbi,
    functionName: "setAddressFrozen",
    args: [employee, frozen],
  });
}
