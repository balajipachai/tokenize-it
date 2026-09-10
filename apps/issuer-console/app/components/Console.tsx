"use client";

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { isAddress } from "viem";
import { connect, publicClient, watchWallet } from "@/lib/wallet";
import { controllerAbi, tokenAbi } from "@/lib/abi";
import {
  buildSchedule,
  chainNow,
  clawbackGrant,
  issueGrant,
  listEmployees,
  onboard,
  readHolder,
  setFrozen,
  terminateGrant,
  type Deployment,
  type Holder,
} from "@/lib/esop";

const HASHSCAN = "https://hashscan.io/testnet";

/**
 * Why a clawback cannot run yet, or null when it can.
 *
 * The contract refuses during the dispute window and refuses again while a dispute is
 * unresolved. Before this the button looked ready, did nothing, and said nothing — the click
 * simply never became a transaction. Saying which of the two is blocking, and for how long,
 * is the difference between a broken button and a working safeguard.
 */
function clawbackBlockedReason(h: Holder): string | null {
  if (h.dispute === 1) return "Contested — an arbiter must rule first";
  const left = h.disputeDeadline - Math.floor(Date.now() / 1000);
  if (left > 0) {
    const m = Math.floor(left / 60);
    const s = left % 60;
    return `Dispute window open — ${m > 0 ? `${m}m ` : ""}${s}s left`;
  }
  return null;
}
const fmt = (n: number) => n.toLocaleString("en-US");
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

type Busy = { what: string; detail?: string } | null;

export function Console() {
  const [account, setAccount] = useState<Address | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [d, setD] = useState<Deployment | null>(null);
  const [holders, setHolders] = useState<Holder[]>([]);
  const [pool, setPool] = useState<{ supply: number; max: number; treasury: number } | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Grant form
  const [employee, setEmployee] = useState("");
  const [total, setTotal] = useState("4800");
  const [cliffPct, setCliffPct] = useState("25");
  const [cliffMins, setCliffMins] = useState("2");
  const [trancheCount, setTrancheCount] = useState("12");
  const [trancheMins, setTrancheMins] = useState("10");

  // Leaving date, per grant. Defaults to today; HR routinely back-dates to the real
  // last working day, which forfeits everything that would have vested after it.
  const [leaveDate, setLeaveDate] = useState<Record<number, string>>({});

  useEffect(() => watchWallet(() => window.location.reload()), []);

  useEffect(() => {
    fetch("/api/deployment")
      .then((r) => r.json())
      .then((body) => (body.error ? setError(body.error) : setD(body)))
      .catch(() => setError("Could not read the deployment record."));
  }, []);

  const refresh = useCallback(async () => {
    // Gate on the connection, not just the render: without this the cap table still
    // arrives over the wire and sits in the network tab for anyone looking.
    if (!d || !account) return;
    // Read the roster from the controller, not from deployments/hedera-testnet.json. That
    // file is only written by the setup scripts, so sourcing it here meant this console
    // could not see the employees it had just onboarded itself.
    const known = await listEmployees(d);
    const [rows, supply, max, treasury] = await Promise.all([
      Promise.all(known.map((a) => readHolder(d, a))),
      publicClient.readContract({ address: d.esopToken.address, abi: tokenAbi, functionName: "totalSupply" }),
      publicClient.readContract({ address: d.esopToken.address, abi: tokenAbi, functionName: "getMaxSupply" }),
      publicClient.readContract({
        address: d.esopToken.address,
        abi: tokenAbi,
        functionName: "balanceOfByPartition",
        args: [d.esopToken.partition, d.esopVestingController.address],
      }),
    ]);
    setHolders(rows);
    setPool({ supply: Number(supply), max: Number(max), treasury: Number(treasury) });
  }, [d, account]);

  useEffect(() => {
    // Surfacing this matters: a silent failure here renders an empty console that
    // looks like "no employees yet" rather than "the reads broke".
    refresh().catch((e) => setError(e instanceof Error ? e.message.split("\n")[0] : "Could not read chain state."));
  }, [refresh]);

  useEffect(() => {
    if (!account) {
      setHolders([]);
      setPool(null);
      setIsAdmin(null);
    }
  }, [account]);

  async function doConnect() {
    try {
      const a = await connect();
      setAccount(a);
      if (d) {
        setIsAdmin(
          await publicClient.readContract({
            address: d.esopVestingController.address,
            abi: controllerAbi,
            functionName: "isGrantAdmin",
            args: [a],
          }),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect.");
    }
  }

  async function run(what: string, fn: () => Promise<string | void>) {
    setBusy({ what });
    setError(null);
    setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
      await refresh();
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      // Wallet rejections are a normal outcome, not a failure worth shouting about.
      setError(/User rejected|denied/i.test(raw) ? "Signature rejected in your wallet." : raw.split("\n")[0]);
    } finally {
      setBusy(null);
    }
  }

  if (error && !d) {
    return (
      <div className="center">
        <div className="card">
          <h2>Not ready</h2>
          <p className="muted">{error}</p>
        </div>
      </div>
    );
  }
  if (!d) {
    return (
      <div className="center">
        <span className="spinner" />
      </div>
    );
  }

  const grantValid = isAddress(employee) && Number(total) > 0 && Number(trancheCount) > 0;

  return (
    <div className="shell">
      <header>
        <div>
          <h1>Issuer console</h1>
          <p className="muted">
            {d.esopToken.name} · {d.esopToken.symbol} ·{" "}
            <a className="link" href={`${HASHSCAN}/contract/${d.esopToken.address}`} target="_blank" rel="noreferrer">
              {short(d.esopToken.address)}
            </a>
          </p>
        </div>
        {account ? (
          <div style={{ textAlign: "right" }}>
            <code>{short(account)}</code>
            <div className={`muted ${isAdmin === false ? "warn" : ""}`}>
              {isAdmin === null ? "…" : isAdmin ? "grant admin" : "not a grant admin — writes will revert"}
            </div>
          </div>
        ) : (
          <button onClick={() => void doConnect()}>Connect wallet</button>
        )}
      </header>

      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner ok">{notice}</div>}
      {busy && (
        <div className="overlay" role="status" aria-live="polite">
          <div className="overlay-card">
            <span className="spinner big" />
            <p className="overlay-what">{busy.what}</p>
            <p className="muted">{busy.detail ?? "Confirm in your wallet, then wait for Hedera."}</p>
          </div>
        </div>
      )}

      {!account && (
        <div className="card">
          <h2>Connect to continue</h2>
          <p className="muted">
            The cap table — who holds what, and what has vested — stays hidden until a wallet is
            connected. Note this is housekeeping rather than confidentiality: the same data is
            public on-chain to anyone who reads the token contract. It keeps a shared screen or a
            passing glance from showing everyone&rsquo;s equity.
          </p>
          <div className="row">
            <button onClick={() => void doConnect()}>Connect wallet</button>
          </div>
        </div>
      )}

      {account && pool && (
        <div className="card">
          <h2>Option pool</h2>
          <div className="stats">
            <div className="stat">
              <div className="value">{fmt(pool.max)}</div>
              <div className="label">Authorised</div>
            </div>
            <div className="stat">
              <div className="value">{fmt(pool.supply)}</div>
              <div className="label">Issued</div>
            </div>
            <div className="stat">
              <div className="value">{fmt(pool.treasury)}</div>
              <div className="label">Unallocated</div>
            </div>
            <div className="stat">
              <div className="value">{fmt(holders.reduce((a, h) => a + h.granted, 0))}</div>
              <div className="label">Granted to staff</div>
            </div>
          </div>
        </div>
      )}

      {account && (
      <div className="card">
        <h2>Issue a grant</h2>
        <div className="grid">
          <label>
            Employee wallet
            <input value={employee} onChange={(e) => setEmployee(e.target.value)} placeholder="0x…" />
          </label>
          <label>
            Options
            <input value={total} onChange={(e) => setTotal(e.target.value)} inputMode="numeric" />
          </label>
          <label>
            Cliff %
            <input value={cliffPct} onChange={(e) => setCliffPct(e.target.value)} inputMode="numeric" />
          </label>
          <label>
            Cliff after (min)
            <input value={cliffMins} onChange={(e) => setCliffMins(e.target.value)} inputMode="numeric" />
          </label>
          <label>
            Tranches
            <input value={trancheCount} onChange={(e) => setTrancheCount(e.target.value)} inputMode="numeric" />
          </label>
          <label>
            Every (min)
            <input value={trancheMins} onChange={(e) => setTrancheMins(e.target.value)} inputMode="numeric" />
          </label>
        </div>
        <p className="muted">
          Periods are in minutes so a cliff lands inside a demo. A real grant would be 12 months and 36 monthly
          tranches — the contract does not care which.
        </p>
        <div className="row">
          <button
            disabled={!account || !grantValid || !!busy}
            onClick={() =>
              void run("Onboarding employee", async () => {
                await onboard(d, account!, employee as Address, `did:hedera:testnet:${account}#kyc-${Date.now()}`);
                return "Employee onboarded — KYC attested and allowlisted.";
              })
            }
          >
            1 · Onboard (KYC + allowlist)
          </button>
          <button
            disabled={!account || !grantValid || !!busy}
            onClick={() =>
              void run("Issuing grant", async () => {
                const schedule = buildSchedule(
                  Number(total),
                  Number(cliffPct),
                  Number(cliffMins) * 60,
                  Number(trancheCount),
                  Number(trancheMins) * 60,
                );
                const id = await issueGrant(d, account!, employee as Address, schedule, (f, t) =>
                  setBusy({ what: "Issuing grant", detail: `funded ${f}/${t} tranches` }),
                );
                // Clear the form so the next grant starts blank rather than looking
                // like it is about to re-issue the one that just succeeded.
                setEmployee("");
                setTotal("4800");
                setCliffPct("25");
                setCliffMins("2");
                setTrancheCount("12");
                setTrancheMins("10");
                return `Grant #${id} issued and fully funded.`;
              })
            }
          >
            2 · Issue grant
          </button>
        </div>
      </div>
      )}

      {account && (
      <div className="card">
        <h2>Employees</h2>
        {holders.length === 0 && <p className="muted">No grants issued yet.</p>}
        {holders.map((h) => (
          <div className="holder" key={h.address}>
            <div className="holder-head">
              <a className="link" href={`${HASHSCAN}/account/${h.address}`} target="_blank" rel="noreferrer">
                {short(h.address)}
              </a>
              <span className={`pill ${h.status === 3 ? "bad" : h.status === 2 ? "good" : ""}`}>
                {h.grantId ? `grant #${h.grantId} · ${["none", "funding", "active", "terminated"][h.status]}` : "no grant"}
              </span>
              <span className={`pill ${h.kycGranted ? "good" : "bad"}`}>{h.kycGranted ? "KYC" : "no KYC"}</span>
              <span className={`pill ${h.allowlisted ? "good" : "bad"}`}>
                {h.allowlisted ? "allowlisted" : "frozen / not listed"}
              </span>
            </div>
            <div className="stats five">
              <div className="stat">
                <div className="value">{fmt(h.granted)}</div>
                <div className="label">Granted</div>
              </div>
              <div className="stat" title="Vested on this grant, whether or not it has been claimed yet">
                <div className="value">{fmt(h.vested)}</div>
                <div className="label">Vested</div>
              </div>
              <div className="stat">
                <div className="value">{fmt(h.unvested)}</div>
                <div className="label">Unvested</div>
              </div>
              <div
                className={`stat ${h.clawedBack > 0 ? "forfeited" : ""}`}
                title="Forfeited on termination and returned to the option pool"
              >
                <div className="value">{fmt(h.clawedBack)}</div>
                <div className="label">Clawed back</div>
              </div>
              <div className="stat" title="Released and unlocked, across every grant this person holds">
                <div className="value">{fmt(h.spendable)}</div>
                <div className="label">Claimed &amp; free</div>
              </div>
            </div>

            {h.grantId !== null && (
              <p className="muted small reconcile">
                {fmt(h.vested)} vested + {fmt(h.unvested)} unvested + {fmt(h.clawedBack)} clawed back ={" "}
                {fmt(h.granted)} granted
              </p>
            )}

            {h.grantId !== null && (
              <div className="row">
                {h.status !== 3 ? (
                  <>
                    <label className="inline">
                      Last working day
                      <input
                        type="date"
                        value={leaveDate[h.grantId!] ?? new Date().toISOString().slice(0, 10)}
                        min={h.grantDate ? new Date(h.grantDate * 1000).toISOString().slice(0, 10) : undefined}
                        max={new Date().toISOString().slice(0, 10)}
                        onChange={(e) => setLeaveDate((m) => ({ ...m, [h.grantId!]: e.target.value }))}
                      />
                    </label>
                    {([1, 2] as const).map((kind) => (
                      <button
                        key={kind}
                        className="danger"
                        disabled={!account || !!busy}
                        onClick={() =>
                          void run("Terminating grant", async () => {
                            const picked = leaveDate[h.grantId!];
                            // A date with no time means midnight; "today" would then be in
                            // the past by hours, which is fine. Only "today" needs chain time.
                            const at = picked
                              ? Math.floor(new Date(`${picked}T00:00:00`).getTime() / 1000)
                              : await chainNow();
                            await terminateGrant(d, account!, h.grantId!, kind, at);
                            return kind === 1
                              ? `Grant #${h.grantId} terminated as a good leaver. ${fmt(
                                  h.vested,
                                )} vested retained, ${fmt(h.unvested)} unvested now forfeitable.`
                              : `Grant #${h.grantId} terminated as a bad leaver.`;
                          })
                        }
                      >
                        {kind === 1 ? "Good leaver" : "Bad leaver"}
                      </button>
                    ))}
                    <button
                      className="ghost"
                      disabled={!account || !!busy}
                      onClick={() =>
                        void run(h.allowlisted ? "Suspending" : "Reinstating", async () => {
                          await setFrozen(d, account!, h.address, h.allowlisted);
                          return h.allowlisted ? "Suspended — transfers blocked." : "Reinstated.";
                        })
                      }
                    >
                      {h.allowlisted ? "Suspend" : "Reinstate"}
                    </button>
                  </>
                ) : (
                  <button
                    className="danger"
                    disabled={!account || !!busy || h.unvested === 0 || clawbackBlockedReason(h) !== null}
                    title={clawbackBlockedReason(h) ?? undefined}
                    onClick={() =>
                      void run("Clawing back unvested options", async () => {
                        await clawbackGrant(d, account!, h.grantId!);
                        return `Clawed back ${fmt(h.unvested)} unvested options from grant #${h.grantId} — returned to the option pool and available to re-grant.`;
                      })
                    }
                  >
                    {h.unvested === 0
                      ? "Nothing left to claw back"
                      : (clawbackBlockedReason(h) ?? `Claw back ${fmt(h.unvested)} unvested`)}
                  </button>
                )}
              </div>
            )}

            {h.credentialId && (
              <p className="muted small">
                Credential <code>{h.credentialId}</code>
                {h.kycGranted && (h.validTo ? ` · valid to ${new Date(h.validTo * 1000).toISOString().slice(0, 10)}` : " · no expiry")}
              </p>
            )}
          </div>
        ))}
      </div>
      )}

      <p className="muted">
        Every action here is signed by <strong>your</strong> wallet, not a shared server key — terminations record the
        deciding address on-chain, so that attribution has to mean something.
      </p>
    </div>
  );
}
