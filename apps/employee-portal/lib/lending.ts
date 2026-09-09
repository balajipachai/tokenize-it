import "server-only";
import { encodeAbiParameters, formatUnits, type Address, type Hex } from "viem";
import { hederaTestnet } from "./chain";
import { deployment, publicClient, relayer } from "./contracts";
import { erc20Abi, poolAbi, protectedHoldAbi, tokenAbi } from "./abi";

const DAY = 24 * 60 * 60;

export interface LendingConfig {
  pool: Address;
  stable: Address;
  navUsd: string;
  navBasis: string;
}

export function lending(): LendingConfig {
  const d = deployment() as unknown as {
    lending?: {
      pool: { address: Address };
      stablecoin: { address: Address };
      navOracle: { navUsd: string; basis: string };
    };
  };
  if (!d.lending) throw new Error("No lending stack deployed. Run 'npm run testnet:deploy-lending'.");
  return {
    pool: d.lending.pool.address,
    stable: d.lending.stablecoin.address,
    navUsd: d.lending.navOracle.navUsd,
    navBasis: d.lending.navOracle.basis,
  };
}

export interface LoanView {
  loanId: number;
  principal: string;
  debt: string;
  ltvPct: number;
  maturity: number;
  status: number;
  collateral: number;
}

export interface BorrowingView {
  pool: Address;
  /** Shares free to pledge — claimed, unlocked and not already held. */
  pledgeable: number;
  sharePriceUsd: string;
  /** What those shares are worth, in stablecoin units. */
  collateralValue: string;
  maxLtvPct: number;
  aprPct: number;
  /** Most that could be borrowed against everything pledgeable. */
  borrowable: string;
  poolLiquidity: string;
  stableBalance: string;
  minTermDays: number;
  loans: LoanView[];
}

const fmt = (v: bigint) => formatUnits(v, 6);

export async function readBorrowing(wallet: Address): Promise<BorrowingView> {
  const d = deployment();
  const l = lending();

  const [free, maxLtvBps, apr, minTerm, liquidity, stableBalance, loanIds] = await Promise.all([
    publicClient.readContract({
      address: d.esopToken.address,
      abi: tokenAbi,
      functionName: "balanceOfByPartition",
      args: [d.esopToken.partition, wallet],
    }),
    publicClient.readContract({ address: l.pool, abi: poolAbi, functionName: "maxLtvBps" }),
    publicClient.readContract({ address: l.pool, abi: poolAbi, functionName: "aprBps" }),
    publicClient.readContract({ address: l.pool, abi: poolAbi, functionName: "minTerm" }),
    publicClient.readContract({ address: l.pool, abi: poolAbi, functionName: "available" }),
    publicClient.readContract({ address: l.stable, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
    publicClient.readContract({ address: l.pool, abi: poolAbi, functionName: "loansOf", args: [wallet] }),
  ]);

  const value =
    free > 0n
      ? await publicClient.readContract({
          address: l.pool,
          abi: poolAbi,
          functionName: "collateralValue",
          args: [free],
        })
      : 0n;

  const loans: LoanView[] = [];
  for (const id of loanIds) {
    const [loan, debt, ltv] = await Promise.all([
      publicClient.readContract({ address: l.pool, abi: poolAbi, functionName: "getLoan", args: [id] }),
      publicClient.readContract({ address: l.pool, abi: poolAbi, functionName: "debtOf", args: [id] }),
      publicClient.readContract({ address: l.pool, abi: poolAbi, functionName: "ltvOf", args: [id] }),
    ]);
    loans.push({
      loanId: Number(id),
      principal: fmt(loan.principal),
      debt: fmt(debt),
      ltvPct: Number(ltv) / 100,
      maturity: Number(loan.maturity),
      status: loan.status,
      collateral: 0,
    });
  }

  return {
    pool: l.pool,
    pledgeable: Number(free),
    sharePriceUsd: l.navUsd,
    collateralValue: fmt(value),
    maxLtvPct: Number(maxLtvBps) / 100,
    aprPct: Number(apr) / 100,
    borrowable: fmt((value * BigInt(maxLtvBps)) / 10_000n),
    poolLiquidity: fmt(liquidity),
    stableBalance: fmt(stableBalance),
    minTermDays: Number(minTerm) / DAY,
    loans,
  };
}

/**
 * Builds the EIP-712 payload the employee signs to pledge collateral.
 *
 * The requested loan amount is encoded into the hold's `data`, which sits inside the signed
 * struct. That is what makes relaying safe: the collateral, the escrow, the expiry and the
 * sum borrowed are all the employee's stated intent, so whoever submits it is carrying out
 * an instruction rather than making a decision.
 */
export async function buildPledge(wallet: Address, shares: number, amountUsdc: bigint, termDays: number) {
  const d = deployment();
  const l = lending();

  const [version, nonce] = await Promise.all([
    publicClient.readContract({ address: d.esopToken.address, abi: protectedHoldAbi, functionName: "getConfigInfo" }),
    publicClient.readContract({
      address: d.esopToken.address,
      abi: protectedHoldAbi,
      functionName: "nonces",
      args: [wallet],
    }),
  ]);

  const hold = {
    amount: BigInt(shares),
    expirationTimestamp: BigInt(Math.floor(Date.now() / 1000) + termDays * DAY),
    escrow: l.pool,
    to: l.pool,
    data: encodeAbiParameters([{ type: "uint256" }], [amountUsdc]) as Hex,
  };

  return {
    domain: {
      name: d.esopToken.name,
      // The ATS CONFIG version, not "1" — hardcoding the conventional value produces
      // signatures that fail with no useful error.
      version: String(version[2]),
      chainId: hederaTestnet.id,
      verifyingContract: d.esopToken.address,
    },
    types: {
      Hold: [
        { name: "amount", type: "uint256" },
        { name: "expirationTimestamp", type: "uint256" },
        { name: "escrow", type: "address" },
        { name: "to", type: "address" },
        { name: "data", type: "bytes" },
      ],
      ProtectedHold: [
        { name: "hold", type: "Hold" },
        { name: "deadline", type: "uint256" },
        { name: "nonce", type: "uint256" },
      ],
      protectedCreateHoldByPartition: [
        { name: "_partition", type: "bytes32" },
        { name: "_from", type: "address" },
        { name: "_protectedHold", type: "ProtectedHold" },
      ],
    },
    primaryType: "protectedCreateHoldByPartition",
    message: {
      _partition: d.esopToken.partition,
      _from: wallet,
      _protectedHold: { hold, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), nonce: nonce + 1n },
    },
  };
}

/** Submits the pledge and opens the loan. The relayer pays; the employee only signed. */
export async function relayBorrow(
  wallet: Address,
  pledge: Awaited<ReturnType<typeof buildPledge>>,
  signature: Hex,
): Promise<{ holdTx: Hex; borrowTx: Hex }> {
  const d = deployment();
  const l = lending();
  const w = relayer();
  const gasPrice = await publicClient.getGasPrice();
  const overrides = { chain: hederaTestnet, account: w.account, gasPrice: (gasPrice * 120n) / 100n };

  const protectedOn = await publicClient.readContract({
    address: d.esopToken.address,
    abi: protectedHoldAbi,
    functionName: "arePartitionsProtected",
  });

  // A token with unprotected partitions has no protected* entry point, so fall back to the
  // direct call. The employee's signature is then unused rather than unsafe — the hold is
  // still over their own balance and still names the pool as escrow.
  const holdTx = protectedOn
    ? await w.writeContract({
        address: d.esopToken.address,
        abi: protectedHoldAbi,
        functionName: "protectedCreateHoldByPartition",
        args: [d.esopToken.partition, wallet, pledge.message._protectedHold as never, signature],
        gas: 900_000n,
        ...overrides,
      })
    : await w.writeContract({
        address: d.esopToken.address,
        abi: protectedHoldAbi,
        functionName: "createHoldByPartition",
        args: [d.esopToken.partition, pledge.message._protectedHold.hold as never],
        gas: 900_000n,
        ...overrides,
      });
  await publicClient.waitForTransactionReceipt({ hash: holdTx });

  const holdId = await publicClient.readContract({
    address: d.esopToken.address,
    abi: protectedHoldAbi,
    functionName: "getHoldCountForByPartition",
    args: [d.esopToken.partition, wallet],
  });

  const borrowTx = await w.writeContract({
    address: l.pool,
    abi: poolAbi,
    functionName: "borrowFor",
    args: [d.esopToken.partition, wallet, holdId],
    gas: 900_000n,
    ...overrides,
  });
  await publicClient.waitForTransactionReceipt({ hash: borrowTx });
  return { holdTx, borrowTx };
}

/** The permit payload the employee signs so the pool may pull their repayment. */
export async function buildRepayPermit(wallet: Address, value: bigint) {
  const l = lending();
  const [name, nonce] = await Promise.all([
    publicClient.readContract({ address: l.stable, abi: erc20Abi, functionName: "name" }),
    publicClient.readContract({ address: l.stable, abi: erc20Abi, functionName: "nonces", args: [wallet] }),
  ]);
  return {
    domain: { name, version: "1", chainId: hederaTestnet.id, verifyingContract: l.stable },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: {
      owner: wallet,
      spender: l.pool,
      value,
      nonce,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    },
  };
}

export async function relayRepay(
  wallet: Address,
  loanId: number,
  permitMessage: Awaited<ReturnType<typeof buildRepayPermit>>["message"],
  signature: Hex,
): Promise<{ permitTx: Hex; repayTx: Hex }> {
  const l = lending();
  const w = relayer();
  const gasPrice = await publicClient.getGasPrice();
  const overrides = { chain: hederaTestnet, account: w.account, gasPrice: (gasPrice * 120n) / 100n };

  const r = `0x${signature.slice(2, 66)}` as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  const v = parseInt(signature.slice(130, 132), 16);

  const permitTx = await w.writeContract({
    address: l.stable,
    abi: erc20Abi,
    functionName: "permit",
    args: [wallet, l.pool, permitMessage.value, permitMessage.deadline, v, r, s],
    gas: 300_000n,
    ...overrides,
  });
  await publicClient.waitForTransactionReceipt({ hash: permitTx });

  const repayTx = await w.writeContract({
    address: l.pool,
    abi: poolAbi,
    functionName: "repayAllFor",
    args: [BigInt(loanId)],
    gas: 900_000n,
    ...overrides,
  });
  await publicClient.waitForTransactionReceipt({ hash: repayTx });
  return { permitTx, repayTx };
}
