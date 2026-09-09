"use client";

import { useCallback, useEffect, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { Borrow } from "./Borrow";

interface Tranche {
  index: number;
  amount: number;
  vestsAt: number;
  released: boolean;
  clawedBack: boolean;
  vested: boolean;
  txHash: string | null;
}

interface Compliance {
  kycGranted: boolean;
  allowlisted: boolean;
  credentialId: string | null;
  issuer: string | null;
  validTo: number | null;
}

interface Position {
  wallet: string;
  token: { address: string; name: string; symbol: string };
  hasGrant: boolean;
  grantId: number | null;
  grantCount: number;
  status: number;
  granted: number;
  vested: number;
  unvested: number;
  clawedBack: number;
  claimable: number;
  spendable: number;
  locked: number;
  nextVestAt: number | null;
  tranches: Tranche[];
  compliance: Compliance;
}

const HASHSCAN = "https://hashscan.io/testnet";
const shortHash = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;

function TxLink({ hash, label }: { hash: string; label?: string }) {
  return (
    <a className="txlink" href={`${HASHSCAN}/transaction/${hash}`} target="_blank" rel="noreferrer">
      {label ?? shortHash(hash)}
    </a>
  );
}

const fmt = (n: number) => n.toLocaleString("en-US");

function countdown(target: number): string {
  const secs = target - Math.floor(Date.now() / 1000);
  if (secs <= 0) return "now";
  const d = Math.floor(secs / 86400);
  if (d > 0) return `in ${d} day${d === 1 ? "" : "s"}`;
  const h = Math.floor(secs / 3600);
  if (h > 0) return `in ${h}h ${Math.floor((secs % 3600) / 60)}m`;
  const m = Math.floor(secs / 60);
  if (m > 0) return `in ${m}m ${secs % 60}s`;
  return `in ${secs}s`;
}

/**
 * A real four-year schedule has tranches a month apart, where a date is enough. A
 * compressed demo schedule has them minutes apart, where every row would otherwise
 * read as the same day. Pick the format from the spread rather than hardcoding one.
 */
function formatter(tranches: Tranche[]): (ts: number) => string {
  const spanDays =
    tranches.length > 1 ? (tranches[tranches.length - 1].vestsAt - tranches[0].vestsAt) / 86_400 : 365;
  const opts: Intl.DateTimeFormatOptions =
    spanDays < 2
      ? { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }
      : { day: "numeric", month: "short", year: "numeric" };
  return (ts) => new Date(ts * 1000).toLocaleString("en-US", opts);
}

export function Dashboard() {
  const { logout, getAccessToken, user } = usePrivy();
  const { wallets } = useWallets();
  const embedded = wallets.find((w) => w.walletClientType === "privy");

  const [position, setPosition] = useState<Position | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimHash, setClaimHash] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [walletPending, setWalletPending] = useState(false);
  const [, forceTick] = useState(0);

  const fetchPosition = useCallback(async (): Promise<Position | null> => {
    const token = await getAccessToken();
    const res = await fetch("/api/position", { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    if (body.code === "wallet_pending") {
      // First-ever login: Privy is still provisioning. Not an error -- keep waiting.
      setWalletPending(true);
      return null;
    }
    if (!res.ok) throw new Error(body.error ?? "Could not load your equity.");
    setWalletPending(false);
    return body as Position;
  }, [getAccessToken]);

  const load = useCallback(async () => {
    try {
      const next = await fetchPosition();
      if (next) setPosition(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your equity.");
    }
  }, [fetchPosition]);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), walletPending ? 2_000 : 15_000);
    // Separate, faster tick so the countdown stays live without re-reading the chain.
    const tick = setInterval(() => forceTick((n) => n + 1), 1_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load, walletPending]);

  async function claim() {
    setClaiming(true);
    setNotice(null);
    setError(null);
    setClaimHash(null);
    try {
      const token = await getAccessToken();
      const res = await fetch("/api/claim", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "The claim did not go through.");

      // The hash exists as soon as the transaction is submitted, so show it now —
      // the employee can watch it confirm on HashScan instead of waiting blind.
      const hash: string | null = body.hash ?? null;
      setClaimHash(hash);
      if (!hash) throw new Error("The claim did not go through.");

      // Ask the receipt how it ended rather than inferring from balances. A reverted
      // transaction never changes a balance, so the old approach could only ever time
      // out — the employee sat watching a spinner for 30 seconds to be told nothing.
      let settled: "pending" | "success" | "reverted" = "pending";
      for (let i = 0; i < 40 && settled === "pending"; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const res = await fetch(`/api/tx/${hash}`, { headers: { Authorization: `Bearer ${await getAccessToken()}` } });
        if (res.ok) settled = (await res.json()).status;
      }

      if (settled === "reverted") {
        throw new Error("The claim was rejected on-chain. Nothing was taken from your grant — see the transaction.");
      }
      if (settled === "pending") {
        setNotice("Submitted. It is taking longer than usual to confirm — follow the transaction above.");
        return;
      }

      const next = await fetchPosition();
      if (next) setPosition(next);
      setNotice("Claimed. Your vested options are now yours to hold, transfer or borrow against.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The claim did not go through.");
    } finally {
      setClaiming(false);
    }
  }

  if (walletPending) {
    return (
      <div className="center">
        <div className="card" style={{ textAlign: "center", maxWidth: 340 }}>
          <span className="spinner" />
          <p style={{ margin: "14px 0 4px", fontWeight: 550 }}>Setting up your wallet</p>
          <p className="muted">This takes a few seconds the first time you sign in.</p>
        </div>
      </div>
    );
  }

  if (!position && !error) {
    return (
      <div className="center">
        <span className="spinner" />
        <p className="muted" style={{ marginLeft: 10 }}>Loading your equity…</p>
      </div>
    );
  }

  const nextIndex = position?.tranches.findIndex((t) => !t.vested) ?? -1;
  const when = formatter(position?.tranches ?? []);

  return (
    <div className="shell">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <h1>My Equity</h1>
          <p className="muted">{user?.email?.address ?? user?.google?.email ?? "Signed in"}</p>
        </div>
        <button
          className="ghost"
          disabled={signingOut}
          onClick={() => {
            setSigningOut(true);
            void logout();
          }}
        >
          {signingOut ? (
            <>
              <span className="spinner small" /> Signing out…
            </>
          ) : (
            "Sign out"
          )}
        </button>
      </div>

      {claiming && (
        <div className="overlay" role="status" aria-live="polite">
          <div className="overlay-card">
            <span className="spinner big" />
            <p className="overlay-what">Claiming your vested options</p>
            <p className="muted">
              {claimHash ? "Confirming on Hedera…" : "Submitting…"}
              <br />
              Your employer pays the fee.
            </p>
            {claimHash && (
              <p className="muted" style={{ marginTop: 10 }}>
                <TxLink hash={claimHash} label="Follow the transaction" />
              </p>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="banner error">
          {error}
          {claimHash && (
            <>
              {" "}
              <TxLink hash={claimHash} label="View transaction" />
            </>
          )}
        </div>
      )}
      {notice && (
        <div className="banner ok">
          {notice}
          {claimHash && (
            <>
              {" "}
              <TxLink hash={claimHash} label="View transaction" />
            </>
          )}
        </div>
      )}

      {position && !position.hasGrant && (
        <div className="card">
          <h2>No grant yet</h2>
          <p className="muted">
            Your wallet is ready, but no options have been granted to it. Ask your issuer to grant to:
          </p>
          <p>
            <code>{position.wallet}</code>
          </p>
        </div>
      )}

      {position?.hasGrant && (
        <>
          <div className="card">
            <h2>Vested and yours</h2>
            <div className="headline">{fmt(position.vested)}</div>
            <p className="muted">
              of {fmt(position.granted)} granted &middot; {position.token.symbol}
              {position.status === 3 && " · grant terminated"}
            </p>
            <p className="muted" style={{ marginTop: 6 }}>
              Vesting happens on its own — each tranche becomes yours the moment its date
              passes, with nobody needing to do anything. Claiming is the separate step that
              moves vested options into your wallet so you can hold, transfer or borrow
              against them.
            </p>

            <div className="stats">
              <div className="stat">
                <div className="value">{fmt(position.unvested)}</div>
                <div className="label">Still vesting</div>
              </div>
              {position.clawedBack > 0 && (
                <div className="stat" title="Forfeited when your grant ended, and returned to the company pool">
                  <div className="value">{fmt(position.clawedBack)}</div>
                  <div className="label">Forfeited</div>
                </div>
              )}
              <div
                className="stat"
                title="Claimed and unlocked — free to hold, transfer or borrow against"
              >
                <div className="value">{fmt(position.spendable)}</div>
                <div className="label">
                  In your wallet{position.grantCount > 1 && ` · ${position.grantCount} grants`}
                </div>
              </div>
              <div className="stat">
                <div className="value">
                  {position.nextVestAt ? countdown(position.nextVestAt) : position.status === 3 ? "—" : "fully vested"}
                </div>
                <div className="label">Next vest</div>
              </div>
            </div>

            {position.claimable > 0 && (
              <div style={{ marginTop: 20 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <button onClick={() => void claim()} disabled={claiming}>
                    {claiming ? (
                      <>
                        <span className="spinner small" /> Claiming…
                      </>
                    ) : (
                      `Claim ${position.claimable} vested tranche${position.claimable === 1 ? "" : "s"}`
                    )}
                  </button>
                  {claimHash ? (
                    <span className="muted">
                      transaction <TxLink hash={claimHash} />
                      {claiming && " · confirming…"}
                    </span>
                  ) : (
                    claiming && <span className="muted">submitting to Hedera…</span>
                  )}
                </div>
                <p className="muted" style={{ marginTop: 8 }}>
                  Your employer pays the network fee. You never need HBAR.
                </p>
              </div>
            )}
          </div>

          <div className="card">
            <h2>Vesting schedule</h2>
            <ul className="timeline">
              {position.tranches.map((t) => (
                <li className="tranche" key={t.index}>
                  <span
                    className={`dot ${t.clawedBack ? "" : t.vested ? "vested" : t.index === nextIndex ? "next" : ""}`}
                  />
                  <span className={t.clawedBack ? "muted" : undefined}>
                    {when(t.vestsAt)}
                    {t.index === 0 && " · cliff"}
                    {t.clawedBack && " · forfeited"}
                    {t.vested && !t.released && !t.clawedBack && " · ready to claim"}
                  </span>
                  <span className="tx">{t.txHash ? <TxLink hash={t.txHash} /> : null}</span>
                  <span className="amount">{fmt(t.amount)}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {position?.hasGrant && <Borrow wallet={position.wallet} onChanged={() => void load()} />}

      {position && (
        <div className="card">
          <h2>Compliance</h2>
          <ul className="timeline">
            <li className="tranche two">
              <span className={`dot ${position.compliance.kycGranted ? "vested" : ""}`} />
              <span>
                KYC {position.compliance.kycGranted ? "verified" : "not granted"}
                {position.compliance.kycGranted &&
                  (position.compliance.validTo
                    ? ` · valid to ${new Date(position.compliance.validTo * 1000).toISOString().slice(0, 10)}`
                    : " · no expiry")}
              </span>
            </li>
            <li className="tranche two">
              <span className={`dot ${position.compliance.allowlisted ? "vested" : ""}`} />
              <span>{position.compliance.allowlisted ? "On the issuer allowlist" : "Not allowlisted"}</span>
            </li>
          </ul>
          {position.compliance.credentialId && (
            <p className="muted" style={{ marginTop: 12 }}>
              Credential <code>{position.compliance.credentialId}</code>
              <br />
              Attested by{" "}
              <a
                className="txlink"
                href={`${HASHSCAN}/account/${position.compliance.issuer}`}
                target="_blank"
                rel="noreferrer"
              >
                {position.compliance.issuer}
              </a>
            </p>
          )}
          <p className="muted" style={{ marginTop: 10 }}>
            The token itself enforces this — a transfer to an address without both checks reverts on
            chain, and revoking the issuer invalidates every credential it signed.
          </p>
        </div>
      )}

      <p className="muted">
        Wallet <code>{embedded?.address ?? position?.wallet}</code>
        <br />
        Token <code>{position?.token.address}</code>
      </p>
    </div>
  );
}
