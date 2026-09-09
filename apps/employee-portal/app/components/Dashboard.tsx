"use client";

import { useCallback, useEffect, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";

interface Tranche {
  index: number;
  amount: number;
  vestsAt: number;
  released: boolean;
  clawedBack: boolean;
  vested: boolean;
}

interface Position {
  wallet: string;
  token: { address: string; name: string; symbol: string };
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
  tranches: Tranche[];
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
  const [, forceTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const token = await getAccessToken();
      const res = await fetch("/api/position", { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not load your equity.");
      setPosition(body);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your equity.");
    }
  }, [getAccessToken]);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 15_000);
    // Separate, faster tick so the countdown stays live without re-reading the chain.
    const tick = setInterval(() => forceTick((n) => n + 1), 1_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  async function claim() {
    setClaiming(true);
    setNotice(null);
    setError(null);
    try {
      const token = await getAccessToken();
      const res = await fetch("/api/claim", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "The claim did not go through.");
      setPosition(body.position);
      setNotice("Claimed. Your vested options are now yours to hold, transfer or borrow against.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The claim did not go through.");
    } finally {
      setClaiming(false);
    }
  }

  if (!position && !error) {
    return (
      <div className="center">
        <p className="muted">Loading your equity…</p>
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
        <button className="ghost" onClick={() => void logout()}>
          Sign out
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner ok">{notice}</div>}

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

            <div className="stats">
              <div className="stat">
                <div className="value">{fmt(position.unvested)}</div>
                <div className="label">Still vesting</div>
              </div>
              <div className="stat">
                <div className="value">{fmt(position.spendable)}</div>
                <div className="label">In your wallet</div>
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
                <button onClick={() => void claim()} disabled={claiming}>
                  {claiming ? "Claiming…" : `Claim ${position.claimable} vested tranche${position.claimable === 1 ? "" : "s"}`}
                </button>
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
                  <span className="amount">{fmt(t.amount)}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      <p className="muted">
        Wallet <code>{embedded?.address ?? position?.wallet}</code>
        <br />
        Token <code>{position?.token.address}</code>
      </p>
    </div>
  );
}
