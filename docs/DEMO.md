# tokenize-it — 4-minute demo

A shot list, not a summary. Timings are cumulative and total **3:55**, leaving five seconds of
air. Everything below runs against live Hedera testnet; nothing is mocked.

The single idea the video has to land: **an employee can borrow against equity they have
already earned, without selling it and without leaving the compliance perimeter.** Every shot
either sets that up or proves it.

---

## Before you record

```bash
npm run portal:dev            # :3000  employee
npm run console:dev           # :3001  issuer  (connect the HR wallet once, before recording)
node services/indexer/index.mjs
```

State to have ready, so nothing is waiting on a timer mid-take:

- Employee `0xd8AE…7D51` signed in at :3000, with **claimable tranches** and **no open loan**.
  If there is nothing to claim, seed one: `EMPLOYEE=0xd8AE… DEMO_CLIFF_SECONDS=60 npm run testnet:grant`
- HR wallet connected at :3001, **Equity** tab selected.
- Treasury holding USDC: `node -e` check, or top up with `TO=0x51845f… AMOUNT=50000 npm run testnet:fund-usdc`
- A second browser profile is worth it — MetaMask on the console, Privy on the portal, no
  account switching on camera.

Two things that will bite on a take: Hedera confirmations run 3–6 seconds, so pause rather
than narrate into dead air; and the borrow panel reads stale for a moment after a
transaction, so reload before pointing at a number.

---

## 0:00 – 0:22 · The problem

**Screen:** the employee portal, signed in, vesting timeline visible.

> "Employee stock options are the most widely held private-market asset on earth, and the
> worst served. Your grant is a PDF. Your vesting schedule is a spreadsheet someone else
> maintains. And the equity you have already earned is worth nothing to you until an exit
> that may never come."

Do not click anything yet. Let the timeline sit there.

## 0:22 – 0:52 · Vesting that runs itself

**Screen:** scroll the vesting timeline; point at a green tranche, then the grey ones.

> "This employee signed in with an email. No wallet, no seed phrase, no HBAR — they have
> never paid a network fee. Each tranche becomes theirs the moment its date passes; nobody
> has to approve it, because vesting is a lock expiry on chain, not a decision."

**Click "Claim".** While it confirms:

> "Claiming is the separate step that moves vested options into their wallet. Their employer
> pays the fee."

Land on the transaction link appearing.

## 0:52 – 1:38 · Borrow — the part nobody else does

**Screen:** scroll to *Borrow against your vested equity*.

> "Now the interesting part. They have earned equity. They cannot sell it. But they can
> borrow against it."

Type an amount well under the limit. **Click Borrow**, sign the Privy prompt.

> "One signature. No gas. And watch what does *not* happen —"

**Cut to a terminal** with this ready to run — take this shot *while the loan is open*, or
the held figure reads zero and the point evaporates:

```bash
npm run demo:proof
```

> "The lending pool holds zero shares. The collateral never left the employee's wallet — it
> is held in place by an ERC-1400 hold, which means the issuer keeps clawback and freeze
> authority over it the entire time. The pool never needs to be trusted with custody,
> because it never has any."

## 1:38 – 2:00 · Repay

**Screen:** back to the portal.

> "Interest accrues per second, so they owe slightly more than they borrowed —"

Point at the button: **Repay 750.000148 USDC**.

> "— which the button says exactly, rather than rounding it to something friendlier."

**Click Repay**, sign, then reload and point at the restored balance.

> "Collateral released. Shares back. Nothing was ever sold."

## 2:00 – 2:38 · The issuer, and the employee's recourse

**Screen:** console at :3001, **Equity** tab.

> "Same data from the issuer's side. Granted, vested, unvested, clawed back — and the
> arithmetic reconciles on every row."

Point at a terminated employee showing clawed back in red.

> "A bad leaver forfeits unvested options. But an issuer who does that unfairly hits a
> dispute window: clawback is refused until it closes, and if the employee contests, it is
> refused until an arbiter rules. The arbiter has to be a multisig — the contract rejects a
> single key. And whoever terminated cannot judge their own decision."

> "We ran that on testnet. An overturned ruling put the grant back."

## 2:38 – 3:15 · Payroll, and why the loan is repayable

**Screen:** console, **Payroll** tab.

> "One hole remained: interest has to be paid from somewhere. So payroll, in stablecoin,
> from a treasury nobody controls alone."

Enter two salaries, **Draft run**.

> "The treasury is a Privy wallet owned by a two-of-two key quorum."

**Click "Approve as officer 1"** — point at the button now reading *Needs 1 more approval*.

> "One approval is not enough, and the contract never sees the difference — Privy refuses to
> sign at all."

**Click officer 2**, then **Pay**.

> "And a policy means that wallet is structurally incapable of sending to the equity token.
> A compromised payroll wallet cannot become a compromised cap table. We tested that by
> trying it, with a full quorum. Denied."

## 3:15 – 3:40 · It is real

**Screen:** HashScan, the contract list.

> "Six contracts on Hedera testnet, all verified exact-match against this repository. A
> hundred and fifty-three tests. Liquidation, disputes, arbitration and payroll all driven
> against the live chain, not a fork."

## 3:40 – 3:55 · Close

**Screen:** back to the employee portal, the borrow panel.

> "Vesting-restricted equity, tokenized properly — with compliance the issuer keeps,
> recourse the employee keeps, and liquidity neither of them had before."

---

## What to cut if a take runs long

In this order, because each removes the least:

1. The claim in 0:22–0:52 — narrate over an already-claimed balance instead.
2. Repay (1:38–2:00) — borrowing is the surprising half; repayment is expected.
3. The verification shot at 3:15 — put the addresses in the description instead.

**Never cut** the pool-holds-nothing terminal shot or the single-approval refusal. Those are
the two moments that are hard to disbelieve, and every other claim in the video rests on the
audience taking something on trust that these two show directly.
