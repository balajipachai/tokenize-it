# Tokenize-It — Implementation Plan

**Tokenized ESOPs with real lifecycle management, on Hedera via Asset Tokenization Studio.**

This plan is derived from `Implementations.md` and from reading the actual
[Asset Tokenization Studio](https://github.com/hashgraph/asset-tokenization-studio) source
(`packages/ats/contracts`, `packages/ats/sdk` v8.0.0, `apps/ats/web`). Findings marked
**[verified]** were confirmed against that source; items marked **[verify]** still need a
testnet spike.

---

## 1. The thesis

Employee stock options are the most widely held private-market asset on earth and the worst
served. A grant is a PDF. Vesting is a spreadsheet. Nobody can see their position, nobody can
borrow against it, and the entire lifecycle — cliff, vest, leave, claw back — is a manual
back-office process reconciled by email.

That is exactly the "parallel paper process" the brief calls out, and it is a better fit for
tokenized collateral than treasuries are, because with ESOPs the paper process is *all there is*.

We tokenize ESOPs as an ERC-3643/ERC-1400 security on Hedera using ATS, run the full lifecycle
on-chain, and then do the thing that is impossible today: **let an employee borrow against their
vested equity without selling it and without leaving the compliance perimeter.**

The judging criterion is "real asset classes and real lifecycle management ... over a token with
a name on it." Section 3 is our answer to that.

---

## 2. What ATS already gives us (and what we must build)

This is the most important section of the plan. ATS is much larger than it first appears — it is
a Diamond (EIP-2535) with ~100 facets. Most of the ESOP lifecycle is *already implemented*. Our
job is orchestration, not reimplementation.

### 2.1 Already in the box — **[verified]**

| Capability | ATS facet / function |
|---|---|
| Equity token issuance | `Factory.deployEquity(EquityData)` — voting/dividend/liquidation rights, nominal value, max supply |
| Partitions (grant tranches/classes) | `partitions`, `protectedPartition`, `*ByPartition` variants |
| KYC gating | `kyc` facet: `grantKyc(account, vcId, validFrom, validTo, issuer)`, `revokeKyc`, `KycStatus` |
| Verifiable-credential issuers + revocation | `ssiManagement`: `addIssuer`, `setRevocationRegistryAddress`, `IRevocationList` |
| Allow/deny list | `controlList`, `externalControlListManagement` |
| **Time-locks (our vesting primitive)** | `lock`: `lock(amount, holder, expirationTimestamp) → lockId`, `release(lockId, holder)`, `updateLockExpiration`, `getLocksIdFor`, `getLockFor` |
| **Atomic grant + lock** | `transferAndLockByPartition(partition, to, amount, data, expirationTimestamp)` |
| **Unconditional early unlock (clawback step 1)** | `lock.forceReleaseByPartition(partition, lockId, holder)` — skips the expiry guard, gated on `LOCKER_ROLE` or `CONTROLLER_ROLE` |
| **Forced transfer / burn (clawback step 2)** | `controllerByPartition`: `controllerTransferByPartition`, `controllerRedeemByPartition` |
| Partial + full freeze | `freeze`: `freezePartialTokens`, `unfreezePartialTokens`, `setAddressFrozen`, `getFrozenTokens` |
| **Escrowed holds (our collateral primitive)** | `holdByPartition`: `createHoldByPartition`, `executeHoldByPartition`, `releaseHoldByPartition`, `reclaimHoldByPartition`. `Hold {amount, expirationTimestamp, escrow, to, data}` — **only `escrow` may execute** |
| Signature-authorized holds | `protectedHoldByPartition` (EIP-712, `ProtectedHold {hold, deadline, nonce}`) |
| Lost-wallet recovery | `recovery` facet |
| Dividends, corporate actions, voting | `dividend`, `corporateActions`, `voting`, `erc20Votes` |
| Stock splits | `adjustBalances`, `balanceTrackerAdjusted` |
| Cap-table snapshots | `snapshot`, `snapshotsByPartition`, `securityHoldersAtSnapshot` |
| Reg D / Reg S metadata | `constants/regulation.sol` |
| Role model | 30+ roles incl. `_ISSUER_ROLE`, `_CONTROLLER_ROLE`, `_LOCKER_ROLE`, `_KYC_ROLE`, `_FREEZE_MANAGER_ROLE`, `_SSI_MANAGER_ROLE` |
| TypeScript SDK | `@hashgraph/asset-tokenization-sdk@8.0.0` — mirrors every facet as a port (`security/lock`, `security/hold`, `security/freeze`, `security/identity`, …) |
| Issuer web console | `apps/ats/web` — Create Equity, Mint, Freeze, Force Transfer, Force Redeem, Locker |
| **Pre-deployed testnet infra** | Resolver `0.0.9212226`, Factory `0.0.9213391`, equity config id `0x…01` — **we do not need to deploy the Diamond** |

### 2.2 What ATS does *not* have — our build surface

1. **No vesting concept.** ATS has locks; it has no notion of a grant, a schedule, a cliff, or a
   leaver policy. We build that.
2. **No employee-facing UI.** `apps/ats/web` is an issuer/admin console. There is no portal where
   a person sees their own grant. We build that.
3. **No lending.** Holds exist as a primitive but nothing consumes them as collateral. We build that.
4. **No valuation.** No NAV, no price oracle. We build that (Chainlink + issuer NAV feed).
5. **No consumer-grade onboarding.** Auth is MetaMask / WalletConnect. Employees will not do that.
   We replace it with Privy.

**Leverage ratio: roughly 80% integration, 20% novel contract code.** That is the right shape for
this brief, which explicitly favours using and extending ATS over rebuilding it.

---

## 3. ESOP lifecycle → ATS primitive mapping

This is the deliverable the brief asks for. Every row is a real lifecycle event backed by a real
ATS call — not a token with a name on it.

| # | Lifecycle event | Implementation |
|---|---|---|
| 1 | Board authorises an option pool | `deployEquity` — see §3.1 for the exact flags and why each one matters |
| 2 | Employee joins, completes KYC | Backend VC issuer → `grantKyc(employee, vcId, validFrom, validTo, issuer)`; issuer registered via `ssiManagement.addIssuer` |
| 3 | Grant issued with a 4-year / 1-year-cliff schedule | `ESOPVestingController` calls `transferAndLockByPartition` **once per tranche** — 1 cliff lock + 36 monthly locks, each with its own `expirationTimestamp` |
| 4 | Cliff reached | First lock expires; `release(lockId, holder)` becomes callable by anyone |
| 5 | Monthly vest | Same, per tranche. Auto-triggered (see §7); manual "Claim" button as fallback |
| 6 | Employee views position | Portal reads `getLocksIdFor` / `getLockFor` + `balanceOfByPartition` → granted / vested / unvested / locked-as-collateral |
| 7 | **Borrow against vested equity** | `createHoldByPartition` with `escrow = ESOPLendingPool` → pool disburses stablecoin (see §6) |
| 8 | Repay | `releaseHoldByPartition` returns collateral to free balance |
| 9 | Default / LTV breach | `executeHoldByPartition` moves collateral to the pool — **the only address that can do this is the escrow** |
| 10 | Employee resigns pre-cliff (bad leaver) | `forceReleaseByPartition` on every unvested lock, then `controllerRedeemByPartition` to burn |
| 11 | Employee resigns post-cliff (good leaver) | Unvested clawed back as in #10. What happens to the **vested** portion depends on what the token represents — see §3.2, which is a genuine modelling decision, not a detail |
| 12 | Disciplinary suspension | `setAddressFrozen(employee, true)` — reversible, no burn |
| 13 | Partial freeze (e.g. disputed tranche) | `freezePartialTokens(employee, amount)` |
| 14 | Lost login | `recovery` facet re-points the holding to a new Privy wallet |
| 15 | Company pays a dividend | `dividend` + `corporateActions` facets |
| 16 | Stock split | `adjustBalances` |
| 17 | Cap table as of a date | `snapshot` + `securityHoldersAtSnapshot` |

### 3.1 Deployment flags — what each one buys, and why they are irreversible

These are passed in `SecurityData` to `deployEquity`. **Nearly all of them are one-time
initialisers** — `initializeControlList`, for example, is guarded by `onlyFacetNotRegistered` and
reverts on a second call. Getting them wrong means redeploying the token and re-issuing every
grant. **[verified]**

| Flag | Set to | What it does | What breaks if wrong |
|---|---|---|---|
| `isControllable` | **`true`** | Enables ERC-1644 `controllerTransferByPartition` / `controllerRedeemByPartition` — forced transfer and forced burn by an address holding `_CONTROLLER_ROLE`. | **The single most important flag for us. `false` makes clawback impossible**, which kills lifecycle events #10, #11 and liquidation. There is no way to add it later. |
| `internalKycActivated` | **`true`** | Turns on ATS's built-in KYC registry, so `grantKyc` is required before an address can hold or receive. The alternative is delegating to `externalKycLists`. | `false` means anyone can hold the ESOP token — no employee gating, and the compliance story collapses. |
| `isWhiteList` | **`true`** | Sets the control list to **allowlist** mode. **[verified]** the check is `isWhiteList == list.contains(account)`, so `true` = only listed addresses may hold; `false` = the list is a *blocklist* and everyone else is allowed. | `false` inverts the security model from "only employees" to "everyone except those we banned" — badly wrong for a private cap table. |
| `isMultiPartition` | **`true`** | Enables ERC-1410 partitions, so tokens can be segregated into classes (`ESOP-2026-A`, `ESOP-2026-B`, exercised vs unexercised). | `false` collapses everything into one default partition. Survivable for a demo, but you lose per-cohort terms and the partition-scoped roles. |
| `arePartitionsProtected` | **`true`** | Enables the **protected-partition meta-transaction path** — `protectedTransferFromByPartition`, `protectedCreateHoldByPartition`, `protectedRedeemFromByPartition`, each authorised by an employee's off-chain EIP-712 signature and submitted by a relayer. | **`false` kills the gasless design in §6.** Employees would need HBAR and a real Hedera account to do anything. |
| `clearingActive` | **`false`** | Clearing adds a two-phase settlement workflow. | **[verified]** every `protected*` function requires *"clearing must be disabled"*. `true` disables our meta-transaction path. |
| `erc20VotesActivated` | `true` | Vote delegation, for the governance stretch goal. | Nothing critical. Cheap to enable now. |
| `maxSupply` | pool size | Hard cap on total supply — the board-authorised option pool. | `0` means unlimited, which is not a real option pool. |
| `compliance` / `identityRegistry` | ERC-3643 modules | Address `0` disables them; supply real ones for the full T-REX path. | Start with `0` + internal KYC; wire the registry in Phase 5 if time allows. |

### 3.2 What does one token actually represent? (You were right to push on "vested retained")

The original draft said *"good leaver: vested retained"*. **That is wrong for options and right for
shares**, and the plan cannot stay ambiguous about which one we are issuing.

In a real ESOP, a **vested option is not owned equity** — it is a *right to buy* at a strike price.
On termination it enters a **post-termination exercise period (PTEP)**, classically 90 days. If the
employee does not pay the strike within that window, the vested option is **forfeited**, not kept.
Most leavers cannot afford the strike plus the tax bill, which is exactly why so many people walk
away from options they had genuinely earned.

Three models:

| Model | Token = | Vesting means | Good leaver keeps vested? | Collateral story |
|---|---|---|---|---|
| **A. Option** | Right to buy at strike | Right becomes exercisable | **No** — only if exercised within PTEP | Weak: an unexercised option is a poor collateral asset |
| **B. Share** | Actual share, post-exercise | n/a (vesting is off-token) | Yes | Strong, but vesting isn't modelled on-chain — defeats the point |
| **C. Vesting-restricted share unit (RSU-like)** | Share subject to forfeiture until vested | Forfeiture right lapses | **Yes** | Strong — it is real equity the moment it vests |

**Recommendation: Model C, with Model A as an optional exercise layer.**

Rationale:
- It is the only model where "borrow against your vested equity" is honest. You cannot sensibly
  lend against an unexercised option — the lender's collateral is a contract that expires if the
  borrower doesn't fund the strike.
- It removes the strike price, the exercise cash requirement, and the PTEP forfeiture cliff — which
  is a *product* argument, not just a simplification. RSUs replaced options at most large private
  companies for exactly these reasons.
- ATS's lock semantics map onto it exactly: locked = unvested and forfeitable via
  `forceReleaseByPartition` + `controllerRedeemByPartition`; unlocked = vested and yours.
- Model A is still reachable later: add `strikePrice` to `Grant`, an `exercise()` that takes payment
  and moves tokens from an `UNEXERCISED` partition to an `EXERCISED` one, and a PTEP lock on
  termination. The partition machinery is already there. It is a Phase 6+ feature.

**Say this explicitly in the pitch.** "We tokenize vesting-restricted equity, not options, because
options are a right to buy and you cannot borrow against a right to buy" is a stronger answer than
hand-waving, and a judge who knows comp will ask.

If you *do* want Model A for realism, the corrected row #11 becomes: on termination, vested-but-
unexercised tokens get a **new lock with `expirationTimestamp = terminationDate + 90 days`** as a
visible countdown, and a scheduled `forceRelease` + `controllerRedeem` at expiry if unexercised.
That is a genuinely nice demo — a forfeiture clock ticking on-chain — but it is more moving parts.

### 3.3 The key design decision: mint-and-lock the whole grant up front

Two options existed:

- **(A) Mint the full grant to the employee immediately, each tranche locked until its vest date.**
- (B) Hold unvested tokens in treasury and transfer on each vest date.

**We choose (A).** Rationale:

- It mirrors how ESOPs actually work — the grant *is* real on the day it is signed; vesting governs
  when it becomes yours to keep, not when it exists.
- The employee can see their entire grant on day one. That is the product.
- Vesting becomes **trustless**: once `expirationTimestamp` passes, release is permissionless. No
  keeper is required for correctness, only for convenience.
- Clawback is still fully available — this was the risk with (A), and it is **[verified]** to work:
  `forceReleaseByPartition` explicitly *"skips the `LockExpirationNotReached` guard"* and is gated on
  `LOCKER_ROLE`/`CONTROLLER_ROLE`, so the issuer can unlock unvested tranches and then
  `controllerRedeemByPartition` them.
- Option (B) needs a trusted, always-on keeper for the *happy* path, which is strictly worse.

**Consequence:** collateral eligibility is **vested (unlocked, unfrozen) balance only.** Unvested
tokens are clawback-able and therefore not valid collateral. This is a feature, not a limitation —
it is the correct credit decision and it is a strong talking point.

---

## 4. Architecture

```
┌────────────────────────────────────┬─────────────────────────────────┐
│  apps/employee-portal (Next.js)    │  apps/issuer-console            │
│  · Privy email/Google login        │  (fork of apps/ats/web)         │
│  · READS ONLY (Mirror Node / viem) │  · MetaMask / WalletConnect —   │
│  · Signs EIP-712 to borrow         │    HR staff are real signers    │
│  · Never sends a tx, never has gas │  · Uses ATS SDK directly        │
└──────────────┬─────────────────────┴───────────────┬─────────────────┘
       Privy access token + EIP-712 signature        │  ATS SDK v8
               ▼                                     │
┌──────────────────────────────────────────────────┐ │
│  services/api  (Next API routes or NestJS)       │ │
│  · verifyAccessToken → resolve wallet from Privy │ │
│    directory (NEVER from the client)             │ │
│  · Relayer wallet — pays ALL gas                 │ │
│  · protectedCreateHoldByPartition(sig) for borrow│ │
│  · VC/KYC issuer → grantKyc                      │ │
│  · Vest keeper (fallback for HIP-1215 rolls)     │ │
│  · Mirror Node indexer → Postgres → cap table    │ │
└──────────────┬───────────────────────────────────┘ │
               │  Hashio JSON-RPC (testnet.hashio.io/api, chainId 296)
               ▼                                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│  OUR CONTRACTS                     │  ATS (pre-deployed on testnet)  │
│  · ESOPVestingController.sol       │  · Resolver   0.0.9212226       │
│  · ESOPLendingPool.sol             │  · Factory    0.0.9213391       │
│  · EsopNavOracle.sol               │  · ESOP token Diamond (ours,    │
│  · MockUSDC.sol (testnet)          │    via deployEquity)            │
│                                    │                                 │
│  CHAINLINK (Hedera testnet)        │  HEDERA SYSTEM                  │
│  · HBAR/USD 0x59bC…2B4a            │  · HSS 0x16b (scheduleCall)     │
│  · USDC/USD 0xb632…B6B5            │  · Mirror Node                  │
└──────────────────────────────────────────────────────────────────────┘
```

### 4.1 Repository layout

```
tokenize-it/
├─ contracts/                  # Foundry
│  ├─ src/
│  │  ├─ ESOPVestingController.sol
│  │  ├─ ESOPLendingPool.sol
│  │  ├─ EsopNavOracle.sol
│  │  ├─ interfaces/IAtsSecurity.sol      # trimmed ATS interface we call
│  │  └─ mocks/MockUSDC.sol
│  ├─ test/
│  └─ script/Deploy.s.sol
├─ apps/
│  ├─ employee-portal/         # new — Next.js + Privy (mirrors loyalty-card layout)
│  └─ issuer-console/          # fork of ATS apps/ats/web (Vite + Chakra)
├─ services/api/               # relayer + KYC + keeper (Next API routes, or NestJS if it grows)
├─ packages/
│  ├─ sdk-ext/                 # ESOP-domain wrapper over the ATS SDK
│  └─ shared/                  # types, ABIs, addresses
└─ docs/
```

> **Note on ATS source:** vendor it as a git submodule or install `@hashgraph/asset-tokenization-sdk`
> from npm. Do **not** fork the whole monorepo — we only need the SDK plus the issuer web app,
> and the ATS build is heavy.

---

## 5. Contracts to build

### 5.1 `ESOPVestingController.sol`

Owns the grant abstraction. Holds `ISSUER_ROLE` + `LOCKER_ROLE` + `CONTROLLER_ROLE` on the ESOP token.

```solidity
struct Grant {
    address employee;
    bytes32 partition;
    uint256 totalAmount;
    uint64  grantDate;
    uint64  cliffDate;
    uint64  vestingEnd;
    uint32  trancheCount;
    GrantStatus status;      // Active | Terminated | FullyVested | Revoked
    uint256[] lockIds;       // parallel to tranche index
    uint64[]  trancheDates;
}

createGrant(...)            // → N × transferAndLockByPartition
releaseVested(grantId)      // → release() for every expired lock
terminate(grantId, LeaverType, uint64 effectiveDate)
                            // → forceReleaseByPartition + controllerRedeemByPartition
                            //   on unvested tranches only
vestedOf(grantId) view
unvestedOf(grantId) view
```

Design notes:
- Cliff = tranche 0 with `expirationTimestamp = cliffDate` and amount = cliff fraction.
- Store `lockIds` so termination is O(unvested tranches), not a scan.
- `terminate` must be idempotent and must **never** touch already-released tranches.
- Emit rich events — the indexer and the demo both read them.
- **[verify]** gas cost of 37 `transferAndLockByPartition` calls in one transaction on Hedera.
  If it exceeds the contract-call gas ceiling, batch tranche creation across 2–3 transactions or
  reduce the demo grant to a 1-year monthly schedule.

### 5.2 `ESOPLendingPool.sol`

The heart of the "tokenized collateral" story. **The pool is the `escrow` on an ATS hold.**

```solidity
borrow(bytes32 partition, uint256 collateralAmount, uint256 borrowAmount)
  // employee has already called createHoldByPartition with escrow=address(this)
  // pool verifies via getHoldForByPartition: escrow==this, to==this,
  //   amount>=collateralAmount, expirationTimestamp >= now + minTerm
  // pool computes collateralValueUsd via EsopNavOracle
  // require(borrowAmount * 1e18 / collateralValueUsd <= maxLtv)
  // transfer MockUSDC to employee

repay(uint256 loanId)                  // → releaseHoldByPartition
liquidate(uint256 loanId)              // → executeHoldByPartition, if LTV breached or overdue
healthFactor(uint256 loanId) view
```

Why the hold model is the right call, and worth saying out loud in the pitch:

- **Collateral never leaves the employee's balance.** No custody transfer, no wrapper token, no
  rehypothecation. The tokens stay in the employee's address, marked as held.
- **The compliance perimeter is preserved.** The pool never needs to be KYC'd as a holder to take
  collateral; it only needs to be the escrow. Transfers only occur on liquidation, and that
  transfer still runs the full ATS compliance stack.
- **The issuer keeps control.** Freeze and clawback still work, so the company is never exposed to
  a lending protocol having captured its cap table.
- This is a genuinely novel use of ERC-1400 holds and it is the strongest technical differentiator
  in the project.

**[verify] — highest-priority spike (day 1):** confirm an ATS hold can be created over a *vested,
unlocked* balance, and that `executeHoldByPartition` to a non-KYC'd pool address either succeeds or
tells us we must KYC the pool. Do this before anything else; the whole lending design rests on it.

#### Why not integrate Aave / Compound / Morpho?

This is the right question to ask, and there are three independent reasons — any one of which
would be sufficient.

1. **They are not deployed on Hedera.** Aave, Compound and Morpho have no Hedera market. There is
   nothing to integrate against. Building on Hedera is a hard requirement of this brief, so this
   alone settles it.

2. **Permissioned collateral is structurally incompatible with permissionless money markets.**
   Every ERC-3643/ERC-1400 transfer runs the compliance stack — KYC status, allowlist, freeze,
   partition rules. In Aave's V3 core, collateral is *transferred to the pool* on supply and then
   *transferred to an arbitrary liquidator* on liquidation. Both legs would revert unless the pool
   **and every possible liquidator** were KYC'd and allowlisted by the issuer in advance. You
   cannot allowlist an open set. This is the well-known reason RWA lending happens in bespoke
   venues rather than the main pools.

3. **Our asset is worse collateral than anything those pools accept.** No secondary market, no
   liquid exit, valuation from a periodic appraisal rather than a live order book. A generic money
   market's liquidation engine assumes it can dump collateral on a DEX. Ours cannot. The risk
   engine has to be purpose-built regardless of the venue.

**We are not avoiding the ecosystem — we are building the pattern it converged on.**
[Aave Horizon](https://aave.com/docs/aave-v3/horizon) is a licensed, separate instance of Aave
built for exactly this: *supply permissioned tokenized RWAs as collateral, borrow permissionless
stablecoins*, with issuers controlling the allowlist. That is a precise description of what
`ESOPLendingPool` does. Our version goes one step further — because ATS gives us ERC-1400 holds,
the collateral **never transfers at all** until liquidation, so we avoid the custody leg that
forces Horizon to be a separate deployment in the first place.

Worth saying on stage: *"This is the Aave Horizon model, implemented natively on ATS holds, on
Hedera."* It positions the work against a real institutional design rather than looking like we
reinvented lending because we hadn't heard of Aave.

**Roadmap, honestly stated:** the v2 integration target is Aave Horizon or a Morpho curated market
with a permissioned liquidator set — *if and when* either deploys on Hedera. Until then, a bespoke
pool is not a shortcut, it is the only correct answer.

### 5.3 `EsopPriceRouter.sol` — pricing listed *and* unlisted issuers

The earlier draft assumed every issuer is private. That is wrong: a listed company's shares have a
live public market price, and tokenized restricted stock at a listed company is arguably the
*bigger* market. The oracle must handle both, and the way to do that is to make the price **source**
a per-token configuration rather than an architectural assumption.

`EsopPriceRouter` maps `securityToken → PriceSource`, where every source implements
`AggregatorV3Interface`. `ESOPLendingPool` only ever calls `latestRoundData()` and never knows
which mode it is in.

| Mode | Issuer type | Source | Risk parameters |
|---|---|---|---|
| `ISSUER_NAV` | Private / unlisted | `EsopNavOracle` — issuer or valuation agent pushes the 409A price (§5.3.1) | Very conservative: LTV ≤ 20–25%, no auto-liquidation, cure period in days, valuation may be 12 months stale |
| `CHAINLINK_FEED` | Listed, feed exists | A Chainlink equity/index Data Feed, read directly | Market-grade: LTV 40–50%, live liquidation, staleness in minutes |
| `CHAINLINK_FUNCTIONS` | Listed, no feed for that ticker | Chainlink Functions or Data Streams pulling from a market-data provider, written into a local aggregator | Between the two; add a manual circuit breaker |

Why this matters beyond correctness: **the two cases have opposite risk profiles.** A listed share
is volatile but liquid, so you can lend more against it and liquidate quickly. An unlisted share is
stable-looking but illiquid and priced from a stale appraisal, so you must lend far less and cannot
realistically liquidate at all — the honest recovery mechanism is issuer buyback or offset against
future vesting, not a fire sale. Encoding that as a per-mode risk parameter set is the single most
"real finance" thing in this project.

Trading-halt / delisting handling belongs here too: a halted ticker means a stale feed, which the
staleness guard already turns into "no new borrowing", which is the correct behaviour.

#### 5.3.1 `EsopNavOracle.sol` (the `ISSUER_NAV` source)

- Implements `AggregatorV3Interface`, so it is drop-in swappable for a real feed later.
- Role-gated writer (issuer or independent valuation agent), **max deviation per update** as a
  circuit breaker against a fat-fingered or malicious NAV, and an explicit `validUntil`.
- Publishes the valuation date, not just the price — a 409A is a point-in-time appraisal and the
  UI should show its age honestly.

> **What is a 409A?** US IRS **Section 409A** requires a private company to obtain an independent
> appraisal of its common stock's fair market value before granting equity — typically annually or
> after any material event (a funding round, a big acquisition). It sets the strike price, and
> complying gives the company a *safe harbour* against the IRS later claiming options were issued
> below fair value, which triggers punitive tax on the employee. In practice the 409A is **the
> closest thing a private company has to a NAV**, which is why we use it.
> Equivalents elsewhere: UK — an HMRC-agreed valuation for EMI options; India — a merchant banker /
> registered valuer report under Rule 11UA and the FEMA pricing guidelines. The contract should
> store a `valuationBasis` string so the same code serves any of them.

#### 5.3.2 Chainlink feeds — **[VERIFIED LIVE, 2026-09-08]**

Called directly against `https://testnet.hashio.io/api` (chainId `0x128` = 296):

| Feed | Address | `latestRoundData()` | Age at check |
|---|---|---|---|
| HBAR/USD | `0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a` | `$0.079932` (8 dp) | **19 min** |
| ETH/USD | `0xb9d461e0b962aF219866aDfA7DD19C52bB9871b9` | `$2,475.61` (8 dp) | **58 min** |
| USDC/USD | `0xb632a7e7e02d76c0Ce99d9C62c7a2d1B5F92B6B5` | `$1.000057` (8 dp) | **~18 h** |

All three answer, all 8 decimals. **Operational finding worth acting on:** USDC/USD was ~18 hours
stale at the time of checking — normal heartbeat behaviour for a stablecoin feed, but a naive
`require(block.timestamp - updatedAt < 1 hours)` would brick the pool. **Configure the staleness
threshold per feed** from each feed's published heartbeat, never one global constant. This is a
classic Chainlink integration bug and we found it before writing a line of the contract.

Also available on Hedera: Chainlink **Proof of Reserve**, a candidate for attesting the lending
pool's stablecoin backing as a stretch goal.

### 5.4 `MockUSDC.sol`

Plain ERC-20, 6 decimals, faucet-mintable. Testnet only. Keep it boring.

---

## 6. Privy integration — the "web2 feel" requirement

**Revised.** The earlier draft had the employee's embedded wallet signing and paying for its own
transactions, which forced an HBAR-funding relayer and a `debug`-mode hack into the ATS SDK. You
are right that neither is necessary. The pattern in
`lh-road-to-devcon-III/loyalty-card-that-cant-be-copied` is better and we should reuse it directly.

### 6.1 The pattern to copy

In the loyalty-card app the embedded wallet is an **identity**, not a transaction sender:

- `app/providers.tsx` — `PrivyProvider` with `loginMethods: ["email", "google"]` and
  `embeddedWallets.ethereum.createOnLogin: "users-without-wallets"`. A wallet appears on first
  login with no "create wallet" step.
- `lib/privyServer.ts` — the server verifies the Privy access token (`verifyAccessToken`) and then
  resolves the user's embedded wallet address **from Privy's user directory**, never from anything
  the client sent. That distinction is the whole security model and it carries over unchanged.
- `lib/contract.ts` — all writes go through a **backend wallet**
  (`privateKeyToAccount(BACKEND_WALLET_PRIVATE_KEY)`), gated on that verified identity.

Net effect: **the user never signs a transaction, never holds gas, and never sees a wallet.** That
is exactly the "web2 feel without the hassle of seed phrases" the brief asks for.

### 6.2 Why this dissolves the hollow-account problem

Hedera has no "an address exists because you say it does" — a Privy embedded wallet is an ECDSA
secp256k1 key whose EVM address is a **hollow account** until it receives HBAR (HIP-32 / HIP-542),
and until then it cannot pay gas.

But under this pattern the employee's address only ever needs to **receive** tokens. An ATS balance
is a mapping inside the Diamond, so crediting a hollow address is ordinary EVM bookkeeping. The
account only has to be materialised on Hedera if the employee themselves sends a transaction — and
they never do.

So the HBAR-funding relayer moves from **mandatory** (risk #2, "High — total demo failure") to
**optional polish**. That is the single biggest risk reduction in this revision. Keep a funding
path behind a flag for the case where an employee wants to export to a self-custodied wallet, but
it is off the critical path.

### 6.3 The one place the employee must actually authorise something

Backend-signs-everything is right for *reads*, *grants*, and *vesting* — those are issuer actions,
and the employee consenting to receive equity is handled off-chain by the grant agreement.

**Borrowing is different.** Pledging your own vested equity as collateral must be authorised by
you, not by your employer's backend. Doing that with a backend key would be indefensible, and a
judge should catch it.

ATS solves this natively — **[verified]** — with **protected partitions**, which are a built-in
meta-transaction system:

```solidity
protectedCreateHoldByPartition(
    bytes32 partition,
    address from,
    IHoldTypes.ProtectedHold memory protectedHold,  // { Hold, deadline, nonce }
    bytes calldata signature                        // EIP-712, signed by `from`
) external returns (bool success_, uint256 holdId_);
```

Siblings exist for transfer and redeem (`protectedTransferFromByPartition`,
`protectedRedeemFromByPartition`, plus protected clearing variants).

The flow:

1. Employee moves the borrow slider and clicks **Borrow**.
2. Privy prompts for a **signature only** — free, instant, no gas, no HBAR, no Hedera account.
3. Frontend posts the signature to `services/api`.
4. Backend verifies the Privy access token, confirms the signer matches the directory address, and
   submits `protectedCreateHoldByPartition` **paying the gas itself**.
5. `ESOPLendingPool` sees a valid hold with itself as escrow and disburses.

Requirements this imposes (already reflected in §3.1): `arePartitionsProtected = true`,
`clearingActive = false`, and the relayer holds the partition-scoped
`_PROTECTED_PARTITIONS_PARTICIPANT_ROLE`. Replay protection is the `deadline` + per-holder `nonce`
inside `ProtectedHold`.

**This is the cryptographic heart of the pitch:** the employee's consent to pledge their equity is
signed by a key only they control, while the company pays every gas fee and the employee never
learns what gas is.

### 6.4 Consequences for the ATS SDK

- **No `debug`-mode workaround, no `setSignerOrProvider` juggling, no SDK fork.** The backend is a
  normal ATS SDK consumer with a normal operator key — the configuration ATS is designed for.
- The employee portal does **reads** only, straight from the Mirror Node or a viem public client.
  Faster than routing reads through the SDK, and it keeps the frontend bundle small.
- `@privy-io/react-auth` v3 in the portal, `@privy-io/node` in `services/api`, matching the
  loyalty-card versions.
- The **issuer console** is the opposite case: HR/finance staff are real signers with real wallets
  and real accountability. Keep MetaMask/WalletConnect there and use the ATS SDK's standard path.
  Two apps, two auth models, on purpose.

### 6.5 Chain config

viem ships `hederaTestnet` (chainId **296**) — **[verified]** `eth_chainId` returns `0x128`. Pass it
to `defaultChain` and `supportedChains`, exactly as the loyalty-card app does with `baseSepolia`. No
`defineChain` needed.

### 6.6 Security rules — non-negotiable

1. **Never trust a client-supplied address.** Resolve it from Privy's directory via the verified
   token, exactly as `getEmbeddedWalletAddress` does.
2. **The backend key is issuer-authority, not user-authority.** It may issue, vest and claw back. It
   must *never* be able to pledge or move an employee's vested tokens without their signature —
   that is what §6.3 is for.
3. **Rate-limit and idempotency-key the relayer.** It pays for gas; treat it as a spending endpoint.
4. Key handling: `BACKEND_WALLET_PRIVATE_KEY` in env for the hackathon, KMS for anything real. ATS
   already ships custodial adapters (Dfns, Fireblocks, AWS KMS) — worth one slide as the production
   answer.

---

## 7. Scheduled transactions — automating vesting

The brief asks for scheduled transactions for vesting and maturity settlement. Three tiers, and we
should build them in this order:

1. **Correctness tier (build first, always ships).** The ATS lock's `expirationTimestamp` is the
   source of truth. After it passes, `release()` is permissionless. Even with zero automation,
   vesting is correct and the employee can always self-claim. Ship this first; everything else is
   convenience.

2. **Hedera-native tier (the differentiator) — [VERIFIED AVAILABLE, 2026-09-08].** The **Hedera
   Schedule Service system contract at `0x16b`** exposes `scheduleCall` (HIP-1215, consensus node
   v0.68+), which lets a contract schedule an arbitrary future contract call and pay for it.
   `ESOPVestingController` schedules its own `releaseVested(grantId)` at each tranche date, at grant
   time. **No keeper, no cron, no trusted party — the vest happens on Hedera's own clock.**

   Verified directly against testnet:
   - Mirror node reports `hapi_version` **0.76.3**, comfortably past the v0.68 requirement.
   - `cast call 0x…016b "hasScheduleCapacity(uint256,uint256)(bool)" <now+3600> 100000` → **`true`**.

   > Note for whoever runs this next: `eth_getCode` on `0x16b` returns `0x`, which looks like "not
   > deployed" but is not. Hedera system contracts have no EVM bytecode — they are implemented
   > natively in the node. (For comparison, HTS at `0x167` returns the single byte `0xfe`.) Probe
   > them by **calling** a view function, never by checking for code.

   **Constraint that shapes the design:** HIP-423 caps scheduled-transaction expiry at **62 days**,
   so a 4-year vesting schedule cannot be scheduled up front. Schedule the *next* tranche on each
   release, rolling forward — and make the keeper in tier 3 responsible for re-arming if a roll ever
   fails, so a single missed schedule cannot silently stall a grant for four years.

3. **Fallback tier.** A cron in `services/api` that calls `releaseVested` for due grants. Trivial,
   and it guarantees the demo works if tier 2 is unavailable. Build it; keep it switchable by env flag.

Note: ATS also has its own internal "scheduled tasks" facets (`scheduledBalanceAdjustment`,
`scheduledCrossOrderedTask`). These are **lazily triggered on next interaction**, not wall-clock
timers, and the repo ships a `SCHEDULED_TASKS_ISSUES.md` documenting current test failures in that
subsystem. **Do not build vesting on ATS scheduled tasks.** Use locks.

---

## 8. Frontend

### 8.1 Employee portal (new — this is what wins the demo)

The judges have seen a hundred admin dashboards. They have not seen an employee open what feels
like a Robinhood screen and discover their options are worth something and are borrowable.

Next.js (matching the loyalty-card app, so the Privy server helpers port over as-is). Reads come
straight from the Mirror Node; the only thing the employee's key ever does is sign the borrow
authorisation.

- **Login:** Privy, email or Google. No seed phrase, no wallet prompt, no HBAR.
- **My Equity:** total granted, vested, unvested, value at current NAV, next vest date + countdown.
- **Vesting timeline:** visual, one node per tranche, past/next/future — this is the screenshot.
- **Claim:** one button when something is vested (or "auto-vested ✓" when tier 2 is live).
- **Borrow:** slider for amount, live LTV and health factor, "you keep your shares" made explicit.
- **Loan status:** outstanding, health factor, repay button.
- **Documents:** grant agreement via the ATS `documentation` facet.

### 8.2 Issuer console (fork `apps/ats/web`)

It is React 18 + Chakra + `io-bricks-ui` + Zustand + react-hook-form, and it already has Create
Equity, Mint, Freeze, Force Transfer, Force Redeem, and Locker views. Add:

- **Grant issuance** — employee, amount, schedule template (4y/1y-cliff monthly, 3y/6m-cliff, custom).
- **Employee register** — KYC status, grant status, vested %, collateral status.
- **Leaver workflow** — the demo's dramatic moment: pick employee, pick good/bad leaver + effective
  date, preview exactly what will be clawed back, execute, watch the cap table change.
- **Cap table** — fully diluted vs vested, via `snapshot`.
- **Pool dashboard** — authorised / granted / vested / available.

Keep their `.env` conventions (`REACT_APP_RPC_RESOLVER`, `REACT_APP_RPC_FACTORY`, …); it saves
real time.

---

## 9. Phased delivery

Ordered so that **something demoable exists after every phase.** If time runs out, you cut from the
bottom, not the middle.

### Phase 0 — De-risk (before any feature code) — 2 of 4 already green

**On "how can we verify these before development is finished?"** — that is the point of a spike: a
throwaway script that answers one question in minutes, *because* it is not production code. Waiting
until the build is done to discover that holds don't work would be the expensive version. Two of
the four are already closed, without writing any project code:

| # | Question | Status | How it was / will be answered |
|---|---|---|---|
| 3 | Do the Chainlink feeds on Hedera testnet answer? | ✅ **GREEN** | Raw `eth_call` of `latestRoundData()` (selector `0xfeaf968c`) against Hashio. All three feeds live, 8 dp. Found the USDC staleness gotcha as a bonus. See §5.3.2 |
| 4 | Is HIP-1215 `scheduleCall` available? | ✅ **GREEN** | `hasScheduleCapacity(...)` → `true`; `hapi_version` 0.76.3. See §7 |
| 1 | Can a hold be executed to a non-KYC'd pool? | 🔴 **OPEN — do first** | Deploy an ESOP token via the existing testnet factory, mint to a test address, `createHoldByPartition` with a third-party escrow, then have the escrow call `executeHoldByPartition`. ~2 hours with the SDK. *Gates §5.2, the core novelty* |
| 2 | Does the Privy → protected-hold path work end to end? | 🟡 **NARROWED** | Reduced by §6 from "does the SDK accept a Privy signer" to "does an EIP-712 signature from a Privy embedded wallet validate in `protectedCreateHoldByPartition`". Sign a `ProtectedHold` payload client-side, submit from a backend key, assert the hold exists. ~3 hours |

Spike #1 is the only one that can still force a redesign. Do it on day one, before anything else.

### Phase 1 — Token + lifecycle skeleton
Deploy an ESOP equity via the existing testnet factory. Grant KYC to two test employees. Manually
exercise `transferAndLockByPartition`, `release`, `forceReleaseByPartition`,
`controllerRedeemByPartition`, `freeze` via the SDK in a script.
**Demoable:** a real security token with real compliance, driven from the terminal.

### Phase 2 — `ESOPVestingController` + Foundry tests
Grant creation, tranche locks, cliff, release, good/bad-leaver termination. Full test coverage of
the leaver matrix — this is the contract most likely to have an off-by-one, and clawback bugs are
the ones that would actually matter in production.
**Demoable:** the entire vesting lifecycle, on-chain, via tests.

### Phase 3 — Employee portal + Privy
Login, backend relayer + token verification (lift `privyServer.ts` from the loyalty-card app almost
verbatim), My Equity, vesting timeline, manual claim.
**Demoable:** the emotional core of the pitch. If everything after this fails, you still have a
strong submission.

### Phase 4 — Lending
`EsopNavOracle`, `ESOPLendingPool`, Chainlink feeds, borrow/repay/liquidate, portal borrow UI.
**Demoable:** the differentiator — borrow against vested equity without selling it.

### Phase 5 — Issuer console
Grant issuance UI, employee register, leaver workflow, cap table.
**Demoable:** the end-to-end enterprise story, both sides of the table.

### Phase 6 — Automation + polish
HSS `scheduleCall` auto-vesting (with keeper fallback), Mirror Node indexer, dividends, seeded demo
data, recorded fallback video.

**Cut line:** Phases 0–4 are the submission. Phase 5 makes it enterprise-credible. Phase 6 is
upside. If you are behind, cut Phase 6 first and the cap table from Phase 5 second.

---

## 10. Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Hold cannot be executed to a non-KYC'd pool | **High** — breaks §5.2 | Phase 0 spike #1, day one. Fallback: KYC the pool address as an institutional holder, or route liquidation through the issuer as controller |
| 2 | ~~Privy hollow accounts un-activated~~ | ~~High~~ → **Low** | **Retired by §6.** Employees never send transactions, so their accounts never need activating. Only the backend relayer needs HBAR — one account to fund and monitor |
| 3 | ~~Chainlink feeds stale or absent~~ | ~~Medium~~ → **Closed** | Verified live (§5.3.2). Residual: use **per-feed** staleness thresholds — USDC/USD was 18 h old at check time and a global 1 h guard would brick the pool |
| 4 | ~~HIP-1215 unavailable~~ | ~~Low~~ → **Closed** | Verified live (§7). Residual: the 62-day expiry cap forces rolling re-arm; the keeper must detect a failed roll |
| 5 | 37 tranche locks exceed the gas ceiling | Medium | Batch across transactions, or use a 12-tranche demo schedule |
| 6 | ATS SDK v8 API drift vs docs | Medium | The vendored source is ground truth — read `packages/ats/sdk/src/port/in`, not the docs |
| 7 | Hashio rate limits under demo load | Medium | Own relay endpoint or a paid provider; cache reads through the Mirror Node, not RPC |
| 8 | **Relayer key compromise or drain** | **High** *(new)* | The relayer pays all gas and holds issuer authority. Rate-limit per user, idempotency keys, cap per-tx gas, alert on balance drop, keep it off the issuer's admin key |
| 9 | Option-vs-share ambiguity surfaces in Q&A | Medium *(new)* | §3.2. Pick Model C, state it in one sentence on stage, have the Model A migration path ready as the answer to "but real ESOPs have a strike price" |
| 10 | Scope | **High** | The cut line in §9 is the mitigation. Honour it |

---

## 11. Demo script (5 minutes)

1. **Issuer (30s):** ESOP pool live on Hedera, ERC-3643 compliant, 1M options authorised.
2. **Grant (45s):** Grant 10,000 options to Priya, 4-year monthly, 1-year cliff. Show the 37 locks
   land on-chain.
3. **Employee (60s):** Priya logs in with *her work email*. No wallet, no seed phrase, no HBAR. She
   sees her grant, her timeline, her next vest.
4. **Vest (45s):** Fast-forward past the cliff. Tokens vest **automatically** — scheduled on Hedera
   itself, no server, no cron.
5. **Borrow (75s):** Priya borrows $5,000 against vested equity. She approves with a **signature,
   not a transaction** — the company pays the gas, but only *her* key can pledge *her* equity.
   **She still holds her shares** — show the balance, show the hold. Company still controls the
   cap table.
6. **Leaver (60s):** Priya resigns at month 30. Issuer runs the leaver workflow: vested retained,
   unvested clawed back on-chain in one transaction. Cap table updates live.
7. **Close (15s):** "Every one of those was an ATS primitive. The paper process is gone."

Record this. Demo-day networks fail.

---

## 12. Open decisions

Worth settling before Phase 1:

1. **Option, share, or restricted unit?** — §3.2. Recommendation: **Model C (vesting-restricted
   share unit)**. This is the highest-leverage decision in the document; settle it before Phase 2,
   because it determines the leaver semantics the whole controller is built around.
2. **Partition strategy** — one partition per grant, per employee, per grant-year, or a single
   partition? Recommendation: **one partition per grant class** (e.g. `ESOP-2026-A`), with grants
   distinguished by `grantId` in the controller. Simplest thing that still supports differentiated
   terms per cohort. Note partitions also carry the protected-partition role, so the relayer needs
   the role per class.
3. **Does the pool need KYC?** Falls out of Phase 0 spike #1.
4. **Listed or unlisted issuer for the demo?** — §5.3. Recommendation: **demo the unlisted path**
   (it is the harder, more differentiated case) but have `CHAINLINK_FEED` mode wired and mention it,
   since it proves the router is real rather than aspirational.
5. **Stablecoin** — `MockUSDC` (ERC-20, simple) vs an HTS token (more Hedera-native, more
   integration surface). Recommendation: **MockUSDC**; spend the complexity budget on lending logic.
6. **Whose 409A?** For the demo, the issuer writes NAV. Say clearly on stage that production would
   use an independent valuation agent behind the same interface — and that the router already
   supports swapping them without touching the pool.
7. **Does the employee ever need self-custody?** Privy supports wallet export. If we claim "your
   equity, your keys", we should support export — which reintroduces HBAR funding for that path
   only. Recommendation: **mention as roadmap**, keep the funding code behind a flag.

---

## 13. References

- [Asset Tokenization Studio](https://github.com/hashgraph/asset-tokenization-studio) — contracts, SDK, web app
- [`@hashgraph/asset-tokenization-sdk`](https://www.npmjs.com/package/@hashgraph/asset-tokenization-sdk) v8.0.0
- [ATS documentation](https://docs.hedera.com/solutions/tokenization/ats)
- [Hedera Schedule Service system contract (`0x16b`)](https://docs.hedera.com/evm/hedera-services/system-contracts/schedule-service)
- [HIP-1215: Generalized Scheduled Contract Calls](https://hips.hedera.com/hip/hip-1215)
- [HIP-423: Long-Term Scheduled Transactions](https://hedera.com/blog/introducing-hip-423-long-term-scheduled-transactions)
- [Hedera auto account creation (HIP-32 / HIP-542)](https://docs.hedera.com/learn/core-concepts/accounts/auto-account-creation)
- [Chainlink oracles on Hedera](https://docs.hedera.com/hedera/open-source-solutions/oracle-networks/chainlink-oracles)
- [Chainlink price feeds on Hedera — tutorial + testnet addresses](https://github.com/hedera-dev/tutorial-js-chainlink-price-feeds)
- [Privy — configuring EVM networks](https://docs.privy.io/guide/react/configuration/networks/evm)
- [scaffold-hbar](https://github.com/hedera-dev/scaffold-hbar)
- [Aave Horizon — permissioned RWA collateral, permissionless stablecoin borrow](https://aave.com/docs/aave-v3/horizon) — the institutional precedent for §5.2
- [ERC-3643 on Hedera](https://docs.hedera.com/evm/tokens/erc3643)
- **Internal:** `lh-road-to-devcon-III/loyalty-card-that-cant-be-copied` — `app/providers.tsx`, `lib/privyServer.ts`, `lib/contract.ts`. The Privy + backend-relayer pattern in §6 is lifted from here
