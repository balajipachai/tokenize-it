import "server-only";
import {
  encodeAbiParameters,
  formatUnits,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import { hederaTestnet } from "./chain";
import { deployment, gasFor, publicClient, relayer } from "./contracts";
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

/** The two time fields the employee's signature covers but the server must not re-derive. */
export interface PledgeTiming {
  expirationTimestamp: bigint;
  deadline: bigint;
}

/** How far ahead a signing deadline may sit. Long enough to read a modal, short enough to matter. */
const MAX_DEADLINE = 2 * 60 * 60;

/**
 * Builds the EIP-712 payload the employee signs to pledge collateral.
 *
 * The requested loan amount is encoded into the hold's `data`, which sits inside the signed
 * struct. That is what makes relaying safe: the collateral, the escrow, the expiry and the
 * sum borrowed are all the employee's stated intent, so whoever submits it is carrying out
 * an instruction rather than making a decision.
 *
 * `timing` exists because this function runs twice per loan — once to produce the payload and
 * again when the signature comes back — and `Date.now()` differs between those two calls by
 * however long the employee spent reading the prompt. Re-deriving the timestamps built a
 * different struct than the one that was signed, so recovery yielded a junk address and the
 * token rejected the hold with `WrongSignature()`. On the second pass the caller echoes back
 * what was actually signed; the bounds below are what keep that echo from being a way to
 * smuggle in an arbitrary expiry.
 */
export async function buildPledge(
  wallet: Address,
  shares: number,
  amountUsdc: bigint,
  termDays: number,
  timing?: PledgeTiming,
) {
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

  const now = Math.floor(Date.now() / 1000);
  let expirationTimestamp: bigint;
  let deadline: bigint;

  if (timing) {
    // A minute of slack at the bottom: the hold must still outlive the loan the pool is about
    // to open against it, and the ceiling is the term the employee actually asked for.
    const floor = BigInt(now + 60);
    const ceiling = BigInt(now + termDays * DAY + 60);
    if (timing.expirationTimestamp < floor || timing.expirationTimestamp > ceiling) {
      throw new Error("That pledge's expiry is out of range. Start the loan again.");
    }
    if (timing.deadline <= BigInt(now) || timing.deadline > BigInt(now + MAX_DEADLINE)) {
      throw new Error("That signature has expired. Start the loan again.");
    }
    ({ expirationTimestamp, deadline } = timing);
  } else {
    expirationTimestamp = BigInt(now + termDays * DAY);
    deadline = BigInt(now + 3600);
  }

  const hold = {
    amount: BigInt(shares),
    expirationTimestamp,
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
      // ATS requires exactly `currentNonce + 1`; anything else reverts with WrongNonce.
      _protectedHold: { hold, deadline, nonce: nonce + 1n },
    },
  };
}

/**
 * Known custom errors, so a revert reads as a sentence rather than four bytes.
 *
 * `AccountHasNoRole` is the one worth naming: it means the relayer is missing the
 * partition's participant role, which is an operator onboarding gap rather than anything
 * the employee did wrong. Run `npm run testnet:grant-relayer` and it goes away.
 */
const REVERT_REASONS: Record<string, string> = {
  "0xa1180aad": "the relayer is not authorised on this partition — run 'npm run testnet:grant-relayer'",
  "0xf7b9be5c": "the hold carried no requested amount",
  // Interest accrues from the moment the loan opens, so the sum borrowed is always a little
  // less than the sum owed. Repaying needs that difference from somewhere else.
  "0xf4d678b8": "your stablecoin balance is short of what is owed, including accrued interest",
};

/**
 * Waits for a receipt and throws unless the transaction actually succeeded.
 *
 * `waitForTransactionReceipt` resolves for reverted transactions too — it only rejects if
 * the receipt never arrives. Awaiting it without reading `status` is how a failed borrow
 * came back to the portal as "Borrowed 500.00 USDC" while nothing had happened on chain.
 * Replaying the call at the mined block is what turns the bare selector into a reason.
 */
async function confirm(hash: Hex, step: string): Promise<Hex> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === "success") return hash;

  let reason = "";
  try {
    const tx = await publicClient.getTransaction({ hash });
    await publicClient.call({
      account: tx.from,
      to: tx.to,
      data: tx.input,
      value: tx.value,
      blockNumber: receipt.blockNumber,
    });
  } catch (e) {
    const data = String((e as { cause?: { data?: string } })?.cause?.data ?? "");
    const selector = data.slice(0, 10);
    reason = REVERT_REASONS[selector] ?? (selector.length === 10 ? `revert ${selector}` : "");
  }

  throw new Error(`${step} failed on chain${reason ? `: ${reason}` : ""} (tx ${hash})`);
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

  // Recover before relaying. The token checks the same thing and reverts with
  // `WrongSignature()`, but that costs a real Hedera transaction to learn, and the bare
  // selector says nothing about which address actually signed. Doing it here turns a paid
  // failure into a free one and names the mismatch.
  const signer = await recoverTypedDataAddress({
    domain: pledge.domain,
    types: pledge.types,
    primaryType: pledge.primaryType,
    message: pledge.message,
    signature,
  } as never);
  if (signer.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error(
      `That signature came from ${signer}, but the shares belong to ${wallet}. ` +
        `The token only accepts a hold signed by the owner.`,
    );
  }

  // ONE transaction. The pool places the signed hold and opens the loan against it in the
  // same call, so there is no in-between state to be stranded in: either the borrower has
  // collateral and a loan, or they have neither and can simply try again.
  //
  // This replaces a two-transaction flow whose failure mode was real rather than theoretical
  // — a hold landed, `borrowFor` reverted, and an employee's shares sat immobilised against
  // a loan that did not exist until someone recovered it by hand.
  //
  // It also removes the need to work out the new hold's id at all: the pool receives it as a
  // return value from the token rather than anyone parsing it back out of a receipt.
  const args = [d.esopToken.partition, wallet, pledge.message._protectedHold, signature] as const;
  const tx = await w.writeContract({
    address: l.pool,
    abi: poolAbi,
    functionName: "pledgeAndBorrow",
    args: args as never,
    // Estimated, then tripled — see `gasFor`. The floor is measured: the hold leg ran ~470k
    // and the loan leg ~360k when these were two transactions, so ~830k of real work.
    gas: await gasFor(
      () =>
        publicClient.estimateContractGas({
          address: l.pool,
          abi: poolAbi,
          functionName: "pledgeAndBorrow",
          args: args as never,
          account: w.account,
        }),
      1_000_000n,
    ),
    ...overrides,
  });
  await confirm(tx, "Pledging your shares and opening the loan");
  return { holdTx: tx, borrowTx: tx };
}

/**
 * The permit payload the employee signs so the pool may pull their repayment.
 *
 * `deadline` is echoed back on the second pass for the same reason as the pledge: this runs
 * once to build the payload and once to verify the signature, and a re-derived deadline would
 * not match what was signed. The debt itself moves too — interest accrues every second — which
 * is why the caller pins `value` rather than recomputing it from a fresh `debtOf`.
 */
export async function buildRepayPermit(wallet: Address, value: bigint, deadline?: bigint) {
  const l = lending();
  const [name, nonce] = await Promise.all([
    publicClient.readContract({ address: l.stable, abi: erc20Abi, functionName: "name" }),
    publicClient.readContract({ address: l.stable, abi: erc20Abi, functionName: "nonces", args: [wallet] }),
  ]);

  const now = Math.floor(Date.now() / 1000);
  if (deadline !== undefined && (deadline <= BigInt(now) || deadline > BigInt(now + MAX_DEADLINE))) {
    throw new Error("That signature has expired. Try the repayment again.");
  }

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
      deadline: deadline ?? BigInt(now + 3600),
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
    gas: await gasFor(
      () =>
        publicClient.estimateContractGas({
          address: l.stable,
          abi: erc20Abi,
          functionName: "permit",
          args: [wallet, l.pool, permitMessage.value, permitMessage.deadline, v, r, s],
          account: w.account,
        }),
      250_000n,
    ),
    ...overrides,
  });
  await confirm(permitTx, "Approving the repayment");

  const repayTx = await w.writeContract({
    address: l.pool,
    abi: poolAbi,
    functionName: "repayAllFor",
    args: [BigInt(loanId)],
    // Repaying releases the hold, which loops inside the diamond — exactly the shape the
    // estimator under-counts, so the floor matters as much as the estimate here.
    gas: await gasFor(
      () =>
        publicClient.estimateContractGas({
          address: l.pool,
          abi: poolAbi,
          functionName: "repayAllFor",
          args: [BigInt(loanId)],
          account: w.account,
        }),
      800_000n,
    ),
    ...overrides,
  });
  await confirm(repayTx, "Repaying the loan");
  return { permitTx, repayTx };
}
