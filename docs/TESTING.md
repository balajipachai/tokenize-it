# End-to-end manual test

Everything below runs against **live Hedera testnet**. Nothing is mocked, and nothing here
passes because a fixture said so.

Work through it in order — later sections depend on state earlier ones create. Each step lists
what to do, **what proves it worked**, and what a failure means, because "it looked fine" is
how three separate bugs survived in this project until something was diffed against the chain.

Tick as you go. Estimated time: **45–60 minutes**, most of it waiting for vesting timers.

---

## 0 · Preconditions

```bash
npm run setup:ats        # once, if vendor/ats is missing — takes a few minutes
npm run test:ats         # expect: 153 passing
```

- [ ] **153 passing.** Fewer means something is broken locally before testnet is involved.

Environment:

- [ ] `.env` has `HEDERA_TESTNET_PRIVATE_KEY_0` (the operator)
- [ ] `apps/web/.env.local` has the Privy app id, app secret and relayer key
- [ ] `apps/web/.env.payroll.local` exists (officer keys) — if missing, re-run
      `node apps/web/scripts/setup-payroll-org.mjs`, which creates a **new**
      quorum and treasury and needs `set-payroll-treasury` afterwards

Live addresses (all Sourcify `exact_match`):

| | |
|---|---|
| ESOP token | `0x17E651D659704A47932ff7Ffd6032860E468cE58` |
| ESOPVestingController | `0xbCd6318cF45f470B845eBfb292a05212150ce065` |
| ESOPLendingPool | `0x1c1885A672c39EEA505E75B83508D78574f7Ae2C` |
| EsopNavOracle | `0x0C101f1439B2356C2E7b1844FB039b7BB8885511` |
| MockUSDC | `0x7f22F51119D41CA4D8Cc36b0b48cf01c644407F9` |
| PayrollDisburser | `0x23608aC73e238F95a378233318E526EE6059e013` |
| Payroll treasury (Privy) | `0x51845f648259F061200AF477901316548cB7150A` |
| Arbiter (multisig stand-in) | `0xCcc28333F1f992dF0075c756B61CBbdD4C766cde` |
| Relayer | `0x534D3B33113cF1435d63969059F593bb12e04069` |

Balances that must be non-zero, or later steps stall:

```bash
npm run proof:no-custody     # also prints the employee's position
```

- [ ] Relayer holds HBAR (pays every employee fee)
- [ ] Treasury holds HBAR **and** USDC

---

## 1 · Issue a grant (issuer console)

```bash
npm run dev     # http://localhost:3000/issuer
HR=0xYourMetaMaskAddress npm run testnet:grant-roles   # once per HR wallet
```

- [ ] Before connecting, the cap table is **hidden**. This is housekeeping, not
      confidentiality — the same data is public on chain — but a shared screen should not
      show everyone's equity.
- [ ] Connect MetaMask as HR. The header shows the address and **grant admin**.
- [ ] The **Equity** and **Payroll** tabs both appear.

On the Equity tab, paste a fresh address into *Employee wallet*, then:

- [ ] **1 · Onboard** → approve in MetaMask. Banner: *Employee onboarded — KYC attested and allowlisted.*
- [ ] **2 · Issue grant** → approve. Banner names the grant id, and *Unallocated* drops by the granted amount.
- [ ] **The form clears itself.** If it keeps the values, that is the bug that makes someone grant twice.
- [ ] The new employee appears in the list. If they do not, the roster is being read from the
      deployments file instead of the chain — the bug fixed in `c14fe55`.

Reconciliation, on every row:

- [ ] `vested + unvested + clawed back = granted`, printed under the figures.

## 2 · Claim (employee portal)

```bash
npm run dev     # http://localhost:3000
```

- [ ] Sign in with an email. A wallet is created — **no seed phrase, no extension, no HBAR**.
      For what that wallet actually is, first-login edge cases, and the KYC question a judge
      will ask, see [TESTING-PHASE-3.md](./TESTING-PHASE-3.md).
- [ ] The dashboard shows granted / vested / still vesting and a tranche timeline.
- [ ] If nothing is claimable yet, wait for the cliff, or seed a fast grant:
      `EMPLOYEE=0x… DEMO_CLIFF_SECONDS=60 DEMO_TRANCHE_SECONDS=60 npm run testnet:grant`
- [ ] Click **Claim**. A full-page spinner appears; a HashScan link appears **while it is still
      confirming**, not after.
- [ ] Each claimed tranche shows its transaction hash.
- [ ] *In your wallet* increases by the claimed amount.

Check the fee was not paid by the employee:

- [ ] Their HBAR balance is still **zero**. The relayer paid.

## 3 · Borrow — the claim everything rests on

- [ ] Scroll to **Borrow against your vested equity**. It shows shares pledgeable, USDC value
      and a borrowable ceiling. The value carries a live Chainlink peg adjustment, so it is
      rarely a round number.
- [ ] Enter an amount **below** the ceiling and click **Borrow**.
- [ ] The Privy signature prompt appears and is **not covered** by the page overlay. The
      overlay should only appear after signing.
- [ ] Read the payload: amount, escrow and destination are all the pool; chain id 296.
- [ ] Sign. One transaction — not two.

**Now the shot that matters**, while the loan is open:

```bash
npm run proof:no-custody
```

- [ ] **The lending pool holds 0 ESOP shares.**
- [ ] The employee holds the pledged amount **as collateral, in their own wallet**.

If the pool holds shares, custody has leaked and the central claim is false.

## 4 · Repay

- [ ] The repay button shows the debt at **full precision** (e.g. `750.000148`), not rounded to
      cents. Rounding advertises less than the pool pulls, and the repayment fails short by a
      fraction of a cent with nothing on screen to explain it.
- [ ] If the balance cannot cover the debt, a warning says by how much. Top up:
      `TO=0x… AMOUNT=25 npm run testnet:fund-usdc`
- [ ] Click **Repay**, sign once.
- [ ] Reload. Collateral is back as free shares; the pool's liquidity is restored plus interest.

## 5 · Leavers, disputes and arbitration

The scripted pass covers the whole matrix and asserts the guards, not just the happy path:

```bash
npm run testnet:dispute-walkthrough     # ~8 minutes, mostly vesting and dispute-window waits
```

- [ ] Clawback **refused** during the dispute window.
- [ ] Dispute raised on the employee's behalf — they never pay gas to contest.
- [ ] Clawback **refused again** while contested.
- [ ] The operator **cannot** rule on its own termination.
- [ ] Arbiter overturns → grant **reinstated**, unvested restored.
- [ ] Good leaver → the in-progress tranche is accelerated; nothing forfeited.
- [ ] Bad leaver, undisputed → window closes, unvested forfeited, and the controller's pool
      **increases** by that amount. Forfeited options return to the pool; they are not burned.

Then the same thing by hand, in the console:

- [ ] Set *Last working day*, click **Bad leaver**, approve. Status becomes terminated.
- [ ] The clawback button is **disabled** and says *Dispute window open — Nm Ns left*. If it
      looks clickable and silently does nothing, that is the bug fixed in `c14fe55`.
- [ ] Wait out the window, reload, click **Claw back N unvested**, approve.
- [ ] Clawed back shows in red; the reconciliation line still balances.

## 6 · Liquidation

```bash
npm run testnet:liquidation-walkthrough
```

Borrows against the operator's treasury, not an employee, so your demo position survives.

- [ ] A **healthy** loan is refused (`Healthy`).
- [ ] After the markdown, seizure takes only enough to cover the debt and **releases the
      surplus**. A liquidated borrower keeps the remainder, and it never leaves their wallet.
- [ ] The oracle refuses a markdown larger than its deviation cap — that is why it takes two
      rounds, and why one fat-fingered price cannot reprice every loan at once.
- [ ] NAV is restored to $2.00 at the end. Confirm it, because a stuck markdown quietly
      shrinks everyone's borrowing power.

## 7 · Payroll

- [ ] Console → **Payroll** tab. It shows treasury balance, owed to staff, and *2 of 2*.
- [ ] Enter amounts for one or two employees. The button totals them.
- [ ] **Draft run** → the run appears as *awaiting approval*.
- [ ] **Approve as officer 1.** The submit button reads **Needs 1 more approval** and is disabled.
- [ ] **Approve as officer 2.** It becomes **Pay N USDC**.
- [ ] Pay. Treasury falls, owed to staff rises, per-employee figures update.
- [ ] The salary inputs **clear**. If they keep their values, that is how someone pays twice.

Prove the controls rather than trusting them:

```bash
OFFICERS_SIGNING=1 SALARY=100 node apps/web/scripts/run-payroll.mjs
```

- [ ] Fails with **401** — *number of signatures does not match the wallet's authorization
      threshold*. One officer is not enough, and the contract never even sees the attempt.

- [ ] Employee collects: in the portal their USDC balance rises without them signing or paying
      anything. Salary can now service the interest on their loan — which is the whole reason
      payroll exists here.

## 8 · Automation, dividends, indexer

```bash
npm run testnet:vesting-keeper          # one pass; WATCH=60 to keep going
```

- [ ] Releases every due tranche across all grants, and **skips** a terminated/clawed-back
      grant rather than crashing the pass.
- [ ] Vesting is correct without it. Switch it off and an employee can still claim — that is
      the property being protected, and it is why the keeper is allowed to be a script.

```bash
npm run testnet:dividend-walkthrough           # ~90s, waits for the record date
```

- [ ] Declares through ATS's own facet, snapshots holders at the record date, and prints each
      holder's entitlement. A transfer after the record date changes nothing.

```bash
node services/indexer/index.mjs
```

- [ ] Ingests the controller's events and reports grants/employees/events.
- [ ] Re-run it: it resumes rather than reindexing, and reports `+0 new events`.
- [ ] Spot-check one grant against the chain. An indexer that is fast and wrong is worse than
      one that is slow and right — two bugs here were invisible until exactly that diff.

---

## When something fails

Failure modes seen repeatedly in this project, and what they actually mean:

| Symptom | Almost always |
|---|---|
| Empty revert data, ~99% of the gas limit consumed | **Out of gas**, not a rejection. Hedera's estimator is unreliable in both directions; raise the limit. Headroom is free — Hedera charges on gas *used*. |
| `"RPC endpoint returned HTTP client error"` | Not a revert. Hedera rejects transactions priced below the network minimum — price from `eth_gasPrice`. |
| `EffectiveDateBeforeGrant` on terminate | A wall-clock timestamp taken before the grant existed. Clamp to `[grantDate, chainNow]`. |
| `WrongExpirationTimestamp` from ATS | A lock date that has already passed by the time the transaction mined. Compute the schedule at send time, with headroom. |
| `AccountHasNoRole(addr, 0xbe5b0edc…)` | The caller lacks the partition participant role — `npm run testnet:grant-relayer`. |
| A UI figure disagreeing with the chain | Usually a stale read taken before the transaction settled. **Reload before believing it.** |

If a contract's behaviour disagrees with this document, trust the chain and tell us — every
correction in `IMPLEMENTATION_PLAN.md` started exactly that way.
