"use client";

import { useCallback, useEffect, useState } from "react";
import { walletClient } from "@/lib/wallet";
import { payrollSignInMessage } from "@/lib/payrollMessage";
import type { Address } from "viem";

const HASHSCAN = "https://hashscan.io/testnet";
const money = (v: string) => Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

interface Pending {
  id: string;
  recipients: string[];
  amounts: string[];
  total: string;
  approvals: number[];
}

interface State {
  payrollAddress: string;
  treasury: string;
  threshold: number;
  officers: number;
  quorumId: string;
  policyId: string;
  treasuryBalance: string;
  totalAccrued: string;
  pending: Pending | null;
  earnings: { address: string; accrued: string; lifetime: string }[];
  error?: string;
}

export function Payroll({ employees, account }: { employees: Address[]; account: Address }) {
  const [state, setState] = useState<State | null>(null);
  const [salaries, setSalaries] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; tx?: string } | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/payroll?employees=${employees.join(",")}`);
      const body = await res.json();
      // Signed out covers two cases: no session at all, and a session opened by a DIFFERENT
      // wallet. MetaMask can switch accounts under the page, and acting on someone else's
      // session while your own address is the one on screen would be confusing at best.
      if (res.status === 401 || (res.ok && body.signedInAs?.toLowerCase() !== account.toLowerCase())) {
        setNeedsSignIn(true);
        setState(null);
        return;
      }
      setNeedsSignIn(false);
      if (res.ok) setState(body);
      else setState({ ...(body as State), error: body.error });
    } catch {
      /* payroll simply does not render if it is not configured */
    }
  }, [employees, account]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: string, extra: object, label: string) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/payroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const body = await res.json();
      if (res.status === 401) {
        setNeedsSignIn(true);
        setState(null);
        throw new Error("Your payroll session expired. Sign in again.");
      }
      if (!res.ok) throw new Error(body.error ?? "That did not work.");
      await load();
      return body;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  /**
   * One signature, no transaction. The server recovers the address from it, checks the
   * controller's `isGrantAdmin`, and sets an hour-long session cookie. The check that
   * matters happens there; this only asks the wallet to prove whose it is.
   */
  async function signIn() {
    setSigningIn(true);
    setError(null);
    try {
      const issuedAt = new Date().toISOString();
      const message = payrollSignInMessage(window.location.host, account, issuedAt);
      const signature = await walletClient(account).signMessage({ account, message });
      const res = await fetch("/api/payroll/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: account, issuedAt, signature }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Sign-in failed.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0] : "Sign-in failed.");
    } finally {
      setSigningIn(false);
    }
  }

  if (needsSignIn) {
    return (
      <div className="card">
        <h2>Payroll</h2>
        <p className="muted">
          Payroll moves the treasury&apos;s money, so it is open to grant admins only — and that is
          checked on the server, not just on this screen. Sign a message with this wallet to prove
          it is yours. It sends no transaction and costs nothing.
        </p>
        {error && (
          <div className="banner error" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}
        <div style={{ marginTop: 14 }}>
          <button disabled={signingIn} onClick={() => void signIn()}>
            {signingIn ? "Waiting for your wallet…" : "Sign in to payroll"}
          </button>
        </div>
      </div>
    );
  }

  if (!state) return null;
  if (state.error) {
    return (
      <div className="card">
        <h2>Payroll</h2>
        <p className="muted">{state.error}</p>
      </div>
    );
  }

  const drafted = Object.entries(salaries).filter(([, v]) => Number(v) > 0);
  const draftTotal = drafted.reduce((s, [, v]) => s + Number(v), 0);
  const p = state.pending;
  const approvalsLeft = p ? state.threshold - p.approvals.length : state.threshold;

  return (
    <div className="card">
      <h2>Payroll</h2>

      {busy && (
        <div className="overlay" role="status" aria-live="polite">
          <div className="overlay-card">
            <span className="spinner big" />
            <p className="overlay-what">{busy}</p>
            <p className="muted">Confirm nothing — the quorum has already authorised this.</p>
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

      <div className="stats">
        <div className="stat">
          <div className="value">{money(state.treasuryBalance)}</div>
          <div className="label">Treasury (USDC)</div>
        </div>
        <div className="stat">
          <div className="value">{money(state.totalAccrued)}</div>
          <div className="label">Owed to staff</div>
        </div>
        <div className="stat">
          <div className="value">
            {state.threshold} of {state.officers}
          </div>
          <div className="label">Approvals required</div>
        </div>
      </div>

      <p className="muted" style={{ marginTop: 12 }}>
        The treasury is a Privy wallet owned by a key quorum — it cannot sign a run until{" "}
        {state.threshold} officers approve, and a policy stops it sending anywhere except this
        payroll contract and the stablecoin. It is structurally unable to touch the ESOP token.
      </p>

      {!p ? (
        <>
          <table className="payroll-table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Owed now</th>
                <th>Earned to date</th>
                <th>This run (USDC)</th>
              </tr>
            </thead>
            <tbody>
              {state.earnings.map((e) => (
                <tr key={e.address}>
                  <td>
                    <a className="txlink" href={`${HASHSCAN}/account/${e.address}`} target="_blank" rel="noreferrer">
                      {short(e.address)}
                    </a>
                  </td>
                  <td>{money(e.accrued)}</td>
                  <td>{money(e.lifetime)}</td>
                  <td>
                    <input
                      value={salaries[e.address] ?? ""}
                      onChange={(ev) => setSalaries({ ...salaries, [e.address]: ev.target.value })}
                      placeholder="0"
                      inputMode="decimal"
                      style={{ width: 110 }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="row" style={{ marginTop: 14, alignItems: "center" }}>
            <button
              disabled={!!busy || drafted.length === 0}
              onClick={() =>
                void act(
                  "draft",
                  { recipients: drafted.map(([a]) => a), amounts: drafted.map(([, v]) => v) },
                  "Drafting the run",
                )
              }
            >
              Draft run{draftTotal > 0 ? ` · ${money(String(draftTotal))} USDC` : ""}
            </button>
            {drafted.length > 0 && (
              <span className="muted">
                {drafted.length} {drafted.length === 1 ? "employee" : "employees"}
              </span>
            )}
          </div>
        </>
      ) : (
        <>
          <div style={{ marginTop: 14 }}>
            <p style={{ fontWeight: 550 }}>
              Run of {money(p.total)} USDC to {p.recipients.length}{" "}
              {p.recipients.length === 1 ? "employee" : "employees"} — awaiting approval
            </p>
            <table className="payroll-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Amount (USDC)</th>
                </tr>
              </thead>
              <tbody>
                {p.recipients.map((r, i) => (
                  <tr key={r}>
                    <td>
                      <a className="txlink" href={`${HASHSCAN}/account/${r}`} target="_blank" rel="noreferrer">
                        {short(r)}
                      </a>
                    </td>
                    <td>{money(p.amounts[i])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="row" style={{ marginTop: 14, alignItems: "center", flexWrap: "wrap" }}>
            {Array.from({ length: state.officers }, (_, i) => {
              const done = p.approvals.includes(i);
              return (
                <button
                  key={i}
                  className={done ? "" : "primary"}
                  disabled={!!busy || done}
                  onClick={() => void act("approve", { officer: i }, `Officer ${i + 1} approving`)}
                >
                  {done ? `Officer ${i + 1} approved` : `Approve as officer ${i + 1}`}
                </button>
              );
            })}
          </div>

          <div className="row" style={{ marginTop: 14, alignItems: "center" }}>
            <button
              className="primary"
              disabled={!!busy || approvalsLeft > 0}
              onClick={() =>
                void act("submit", {}, "Paying staff").then((body) => {
                  if (!body) return;
                  // Clear the drafted amounts. Leaving last month's numbers sitting in the
                  // form is how somebody pays a salary twice.
                  setSalaries({});
                  setNotice({ text: `Payroll ran. ${money(p.total)} USDC credited.`, tx: body.runTx });
                })
              }
            >
              {approvalsLeft > 0
                ? `Needs ${approvalsLeft} more approval${approvalsLeft === 1 ? "" : "s"}`
                : `Pay ${money(p.total)} USDC`}
            </button>
            <button disabled={!!busy} onClick={() => void act("discard", {}, "Discarding")}>
              Discard
            </button>
          </div>
        </>
      )}

      <p className="muted small" style={{ marginTop: 14 }}>
        Treasury{" "}
        <a className="txlink" href={`${HASHSCAN}/account/${state.treasury}`} target="_blank" rel="noreferrer">
          {short(state.treasury)}
        </a>{" "}
        · quorum <code>{state.quorumId}</code> · policy <code>{state.policyId}</code>
      </p>
    </div>
  );
}
