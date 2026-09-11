"use client";

import { useCallback, useEffect, useState } from "react";
import { usePrivy, useSignTypedData } from "@privy-io/react-auth";

interface Loan {
  loanId: number;
  principal: string;
  debt: string;
  ltvPct: number;
  maturity: number;
  status: number;
}

interface Borrowing {
  pool: string;
  pledgeable: number;
  sharePriceUsd: string;
  collateralValue: string;
  maxLtvPct: number;
  aprPct: number;
  borrowable: string;
  poolLiquidity: string;
  stableBalance: string;
  minTermDays: number;
  loans: Loan[];
}

const HASHSCAN = "https://hashscan.io/testnet";
const money = (v: string) => Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Debt figures keep their full precision. Interest accrues every second, so a loan of 500
 * is owed back as 500.000166 — and rounding that to cents advertises a smaller number than
 * the pool actually pulls, which is how someone ends up short by a fraction of a cent and
 * cannot work out why their repayment failed.
 */
const owedAmount = (v: string) =>
  Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const shortHash = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;

export function Borrow({
  wallet,
  onChanged,
  suspended = false,
}: {
  wallet: string;
  onChanged: () => void;
  suspended?: boolean;
}) {
  const { getAccessToken } = usePrivy();
  const { signTypedData } = useSignTypedData();

  const [state, setState] = useState<Borrowing | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; tx?: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const token = await getAccessToken();
      const res = await fetch("/api/borrow", { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json();
      if (res.ok) setState(body);
    } catch {
      /* the panel simply stays hidden if the pool is unreachable */
    }
  }, [getAccessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Signs whatever payload the server asks for, then sends it back to be relayed. */
  async function signAndRelay(url: string, prepare: object, extract: (b: any) => any, label: string) {
    setError(null);
    setNotice(null);
    try {
      const token = await getAccessToken();
      const head = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

      const prep = await fetch(url, { method: "POST", headers: head, body: JSON.stringify(prepare) });
      const prepBody = await prep.json();
      if (!prep.ok) throw new Error(prepBody.error ?? "Could not prepare that.");

      // Deliberately no overlay yet. Privy's signature prompt is a modal in this same page,
      // and covering it hides the very thing we are waiting for — the request just sits
      // there looking hung, with nothing to click.
      // Pin the signer. Once an account has more than one wallet linked, Privy signs with
      // whichever it considers current, which is not necessarily the one holding the shares
      // — and the token only accepts a hold signed by the owner, so the wrong wallet costs
      // a reverted transaction. `wallet` is the address the server resolved for this user.
      const payload = extract(prepBody);
      const { signature } = await signTypedData(
        {
          domain: payload.domain,
          types: payload.types,
          primaryType: payload.primaryType,
          message: payload.message,
        },
        { address: wallet },
      );

      // Signed. From here it is all relayer work, so the overlay is safe and useful.
      setBusy(label);

      // Echo the exact message back. The server builds this payload twice — once to hand it
      // over and once to verify — and anything it re-derives from the clock or from accruing
      // interest would differ by the seconds spent signing, invalidating the signature.
      const send = await fetch(url, {
        method: "POST",
        headers: head,
        body: JSON.stringify({ ...prepare, signature, signed: payload.message }),
      });
      const sendBody = await send.json();
      if (!send.ok) throw new Error(sendBody.error ?? "That did not go through.");

      setState(sendBody.borrowing);
      onChanged();
      return sendBody;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function borrow() {
    if (!state) return;
    // Pledge everything free: the loan is capped by LTV, not by how much is locked up, so
    // pledging less would only lower the ceiling for no benefit.
    const body = await signAndRelay(
      "/api/borrow",
      { shares: state.pledgeable, amount, termDays: 30 },
      (b) => b.pledge,
      "Pledging your shares",
    );
    if (body) {
      setAmount("");
      setNotice({ text: `Borrowed ${money(amount)} USDC. Your shares stayed in your wallet.`, tx: body.borrowTx });
    }
  }

  async function repay(loanId: number) {
    const body = await signAndRelay("/api/repay", { loanId }, (b) => b.permit, "Repaying");
    if (body) setNotice({ text: "Repaid. Your collateral has been released.", tx: body.repayTx });
  }

  if (!state) return null;

  const open = state.loans.filter((l) => l.status === 1);
  // Suspension is checked here and not only on the chain. A pledge places a hold through
  // the token's compliance stack, and a suspended holder is off the allowlist, so the call
  // reverts -- which would reach the employee as a button that looked ready, did nothing,
  // and said nothing. Repayment stays available: closing a loan should never be blocked.
  const canBorrow = state.pledgeable > 0 && open.length === 0 && !suspended;
  const requested = Number(amount || "0");
  const ceiling = Number(state.borrowable);
  const overCeiling = requested > ceiling;

  return (
    <div className="card">
      <h2>Borrow against your vested equity</h2>

      {busy && (
        <div className="overlay" role="status" aria-live="polite">
          <div className="overlay-card">
            <span className="spinner big" />
            <p className="overlay-what">{busy}</p>
            <p className="muted">
              Submitting to Hedera. Nothing is sold, and you pay no network fee.
            </p>
          </div>
        </div>
      )}

      {error && <div className="banner error">{error}</div>}
      {notice && (
        <div className="banner ok">
          {notice.text}
          {notice.tx && (
            <>
              {" "}
              <a className="txlink" href={`${HASHSCAN}/transaction/${notice.tx}`} target="_blank" rel="noreferrer">
                View transaction
              </a>
            </>
          )}
        </div>
      )}

      {open.length > 0 ? (
        open.map((loan) => (
          <div key={loan.loanId}>
            <div className="stats">
              <div className="stat">
                <div className="value">{owedAmount(loan.debt)}</div>
                <div className="label">Owed (USDC)</div>
              </div>
              <div className="stat">
                <div className="value">{loan.ltvPct.toFixed(1)}%</div>
                <div className="label">Loan to value</div>
              </div>
              <div className="stat">
                <div className="value">{new Date(loan.maturity * 1000).toLocaleDateString("en-US")}</div>
                <div className="label">Due</div>
              </div>
            </div>
            <p className="muted" style={{ marginTop: 12 }}>
              Your {state.pledgeable === 0 ? "shares are" : "pledged shares are"} still yours — held as
              collateral in your own wallet, not transferred to anyone. Repay and they are free again.
              Interest accrues every second, so you owe a little more than you borrowed.
            </p>
            {Number(state.stableBalance) < Number(loan.debt) && (
              <div className="banner error" style={{ marginTop: 12 }}>
                You hold {money(state.stableBalance)} USDC but owe {owedAmount(loan.debt)}. Top up by{" "}
                {owedAmount(String(Number(loan.debt) - Number(state.stableBalance)))} USDC to close this loan.
              </div>
            )}
            <div style={{ marginTop: 14 }}>
              <button disabled={!!busy} onClick={() => void repay(loan.loanId)}>
                Repay {owedAmount(loan.debt)} USDC
              </button>
            </div>
          </div>
        ))
      ) : (
        <>
          <div className="stats">
            <div className="stat">
              <div className="value">{state.pledgeable.toLocaleString("en-US")}</div>
              <div className="label">Shares you could pledge</div>
            </div>
            <div className="stat">
              <div className="value">{money(state.collateralValue)}</div>
              <div className="label">Worth (USDC)</div>
            </div>
            <div className="stat">
              <div className="value">{money(state.borrowable)}</div>
              <div className="label">You could borrow</div>
            </div>
          </div>

          <p className="muted" style={{ marginTop: 12 }}>
            At ${state.sharePriceUsd} a share and a {state.maxLtvPct}% limit, {state.aprPct}% a year. Your shares
            are never sold or transferred — they stay in your wallet, marked as collateral, and come back
            when you repay.
          </p>

          {canBorrow ? (
            <div className="row" style={{ marginTop: 14, alignItems: "center" }}>
              <label className="inline">
                Amount (USDC)
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder={money(state.borrowable)}
                  inputMode="decimal"
                />
              </label>
              <button disabled={!!busy || !requested || overCeiling} onClick={() => void borrow()}>
                Borrow
              </button>
              {overCeiling && <span className="muted">Above your {money(state.borrowable)} limit.</span>}
            </div>
          ) : (
            <p className="muted" style={{ marginTop: 12 }}>
              {suspended
                ? "Borrowing is paused while your account is suspended — a pledge moves your shares into a hold, and the issuer has transfers paused. Your options are untouched."
                : state.pledgeable === 0
                  ? "Claim some vested options first — only claimed shares can be pledged."
                  : "You already have a loan open."}
            </p>
          )}
        </>
      )}

      <p className="muted small" style={{ marginTop: 14 }}>
        Pool holds {money(state.poolLiquidity)} USDC · your balance {money(state.stableBalance)} USDC ·{" "}
        <a className="txlink" href={`${HASHSCAN}/contract/${state.pool}`} target="_blank" rel="noreferrer">
          {shortHash(state.pool)}
        </a>
      </p>
    </div>
  );
}
