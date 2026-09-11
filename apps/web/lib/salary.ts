import "server-only";
import fs from "node:fs";
import path from "node:path";
import { formatUnits, type Address } from "viem";
import { hederaTestnet } from "./chain";
import { payrollAbi, erc20Abi, controllerAbi } from "./abi";
import { deployment, publicClient, relayer, gasFor } from "./contracts";

/**
 * The employee's side of payroll.
 *
 * Salary is accrued, not pushed: `fundRun` credits an employee and pulls the cash into the
 * contract, and the money only reaches them when someone calls `withdraw`. That someone
 * cannot be the employee — they hold a wallet that has never paid a network fee — so the
 * relayer delivers it. `withdrawFor` sends only ever to the employee, so the relayer
 * chooses WHEN a person is paid and never whether, how much, or to whom.
 *
 * Until this existed the accrual had no way out of the contract at all: the issuer console
 * could run payroll and the portal had nowhere to show it, which made a funded run look
 * from the employee's side exactly like nothing having happened.
 */

interface PayrollRecord {
  payroll?: { address: Address; stablecoin: Address };
}

function payrollRecord(): { payroll: Address; stable: Address } | null {
  const file = path.resolve(process.cwd(), "../../deployments/hedera-testnet.json");
  if (!fs.existsSync(file)) return null;
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as PayrollRecord;
  if (!record.payroll?.address || !record.payroll?.stablecoin) return null;
  return { payroll: record.payroll.address, stable: record.payroll.stablecoin };
}

export interface SalaryView {
  /** Present at all only when a payroll contract is deployed. */
  configured: boolean;
  payroll: Address | null;
  stablecoin: Address | null;
  /** Earned and waiting to be collected, as a decimal string. */
  accrued: string;
  /** Everything ever earned, collected or not. A payslip history, not a balance. */
  lifetimeEarned: string;
  /** Stablecoin actually in the employee's wallet right now. */
  walletBalance: string;
}

const money = (v: bigint) => formatUnits(v, 6);

export async function readSalary(wallet: Address): Promise<SalaryView> {
  const record = payrollRecord();
  const empty: SalaryView = {
    configured: false,
    payroll: null,
    stablecoin: null,
    accrued: "0",
    lifetimeEarned: "0",
    walletBalance: "0",
  };
  if (!record) return empty;

  try {
    const [accrued, lifetime, balance] = await Promise.all([
      publicClient.readContract({
        address: record.payroll,
        abi: payrollAbi,
        functionName: "accrued",
        args: [wallet],
      }),
      publicClient.readContract({
        address: record.payroll,
        abi: payrollAbi,
        functionName: "lifetimeEarned",
        args: [wallet],
      }),
      publicClient.readContract({
        address: record.stable,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet],
      }),
    ]);
    return {
      configured: true,
      payroll: record.payroll,
      stablecoin: record.stable,
      accrued: money(accrued),
      lifetimeEarned: money(lifetime),
      walletBalance: money(balance),
    };
  } catch (err) {
    // A payroll contract recorded but not reachable (wrong network, superseded address)
    // should hide the salary card, never take the whole dashboard down with it.
    console.warn("Could not read payroll state; hiding the salary card.", err);
    return empty;
  }
}

/**
 * Delivers the employee's accrued salary to them, paid for by the relayer.
 *
 * The employee address comes from the verified session, never from the request body —
 * `withdrawFor` is gated to relayers and the admin, so a client-supplied address would let
 * anyone trigger anyone else's payout. Harmless in effect, since the money still goes to
 * its owner, but it is not the caller's decision to make.
 */
export async function deliverSalary(employee: Address): Promise<`0x${string}`> {
  const record = payrollRecord();
  if (!record) throw new Error("No payroll contract is deployed.");

  const wallet = relayer();
  const gas = await gasFor(
    () =>
      publicClient.estimateContractGas({
        address: record.payroll,
        abi: payrollAbi,
        functionName: "withdrawFor",
        args: [employee],
        account: wallet.account,
      }),
    // Floor well clear of the estimate. `withdrawFor` estimated 73,491 on this contract and
    // then ran out of gas having used 73,367 -- Hedera's estimator is not a bound, and it
    // charges gas used rather than offered, so headroom here is free.
    400_000n,
  );

  const gasPrice = await publicClient.getGasPrice();
  return wallet.writeContract({
    address: record.payroll,
    abi: payrollAbi,
    functionName: "withdrawFor",
    args: [employee],
    chain: hederaTestnet,
    account: wallet.account,
    gas,
    gasPrice: (gasPrice * 120n) / 100n,
  });
}

/** Raises an appeal against a termination, relayed so the employee needs no gas. */
export async function raiseDispute(grantId: number): Promise<`0x${string}`> {
  const d = deployment();
  const wallet = relayer();
  const gasPrice = await publicClient.getGasPrice();
  return wallet.writeContract({
    address: d.esopVestingController!.address,
    abi: controllerAbi,
    functionName: "raiseDispute",
    args: [BigInt(grantId)],
    chain: hederaTestnet,
    account: wallet.account,
    gas: 400_000n,
    gasPrice: (gasPrice * 120n) / 100n,
  });
}
