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
| 9 | Default / LTV breach | `executeHoldByPartition` moves collateral to the pool — **the only address that can do this is the escrow**. Requires the pool to be KYC'd + allowlisted (§5.2 spike #1) |
| 10 | Employee resigns pre-cliff (bad leaver) | `forceReleaseByPartition` on every unvested lock, then `controllerTransferByPartition` back to the pool — forfeited options are re-grantable, so nothing is burned |
| 11 | Employee resigns post-cliff (good leaver) | Unvested clawed back as in #10. What happens to the **vested** portion depends on what the token represents — see §3.2, which is a genuine modelling decision, not a detail |
| 12 | Disciplinary suspension | `setAddressFrozen(employee, true)` — reversible, no burn. **Read the state back with `isInControlList`, not `isFrozen`** (Phase 1 finding 3) |
| 13 | ~~Partial freeze (disputed tranche)~~ | **Not available.** `freezePartialTokens` is `onlyWithoutMultiPartition` — see Phase 1 finding 2. Multi-partition tokens get all-or-nothing freeze only |
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

#### Spike #1 result — **GREEN, with two conditions** (run 2026-09-08, 10/10 passing)

Run as a Hardhat integration test against the real ATS contracts on a local EVM — the question is
contract logic, not Hedera behaviour, so it needed no testnet, no keys and no faucet.
Test: `test/contracts/integration/spike/esopCollateral.spike.test.ts`.

| # | Assertion | Result |
|---|---|---|
| A1 | `createHoldByPartition` with a **non-KYC'd, non-allowlisted** pool as escrow + destination | ✅ **succeeds** |
| A2 | `releaseHoldByPartition` — **the repay path** — with a non-KYC'd escrow | ✅ **succeeds** |
| A3 | `executeHoldByPartition` — **the liquidation path** — to a non-KYC'd pool | ❌ reverts `InvalidKycStatus` |
| A4 | Same, after `grantKyc(pool)` | ✅ succeeds |
| B2 | Liquidation to a pool that is KYC'd but **not allowlisted** (allowlist mode) | ❌ reverts |
| B3 | Liquidation to a pool that is **both KYC'd and allowlisted** | ✅ succeeds |
| A5 | Liquidation to a **KYC'd treasury** while the pool remains the escrow | ✅ succeeds |
| C2 | `controllerRedeemByPartition` reaching tokens under an active hold | ❌ reverts |

This is visible directly in the facet modifiers, which is why the result is trustworthy rather than
incidental — `executeHoldByPartition` carries `onlyIdentifiedAddresses(tokenHolder, _to)` and
`onlyCompliant(address(0), _to, false)`, while `releaseHoldByPartition` carries neither.

**What this means for the design — the core mechanic survives intact:**

1. **Borrowing and repaying need no privileges at all.** The employee can pledge to any escrow, and
   repayment always works. The happy path is completely unencumbered, which is the path 99% of
   loans take.
2. **The pool must be onboarded as a holder — KYC'd *and* allowlisted — but only so liquidation can
   land.** This is a one-time issuer action at deployment, not per-loan friction. And it is
   *correct*: a venue that can end up owning shares should be a known, approved holder. Frame it as
   the compliance model working, not as a workaround.
3. **Compliance is enforced exactly where it should be.** Pledging is not a transfer, so it is
   unrestricted; liquidation *is* a transfer, so it runs the full stack. That is a genuinely elegant
   property of ERC-1400 holds and worth one sentence in the pitch.

**New finding (C2) that changes a design rule.** Tokens under an active hold are **shielded from
`controllerRedeemByPartition`** — the issuer cannot claw back pledged collateral. There is also no
issuer override: `controllerHoldByPartition` only exposes `controllerCreateHoldByPartition` (create,
not break), and `reclaimHoldByPartition` works only *after* expiry.

So **the hold's `expirationTimestamp` is the issuer's only backstop**, which gives us a hard rule:

> `ESOPLendingPool` must **never** create a hold with `expirationTimestamp = 0` (the ATS "never
> expires" sentinel). Always set `loanTerm + grace`, and reject any user-supplied hold whose
> expiration exceeds a configured maximum.

Without that rule an employee could permanently escape clawback by pledging to a cooperative
escrow. The exposure is bounded — only *vested* tokens can be held, and unvested tokens are locked
rather than held, so they cannot be pledged at all — but the rule costs nothing and closes it.

**Remaining unknowns, both minor:** we have not yet confirmed a hold can be placed over a balance
that was *previously* locked and then released by vesting (expected to be fine — release returns
tokens to the free balance), nor measured this on Hedera rather than a local EVM. Both are cheap to
fold into Phase 1.

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

#### Spike #2 result — **GREEN** (run 2026-09-08, 9/9 passing)

`spikes/privyProtectedHold.spike.test.ts`. The employee is modelled as a **detached
`ethers.Wallet.createRandom()` with a zero balance that never sends a transaction** — precisely a
Privy embedded wallet on an unactivated Hedera account.

| # | Assertion | Result |
|---|---|---|
| E1 | ATS's hardcoded on-chain type string == a standard EIP-712 encoder's output | ✅ **byte-identical** |
| E2 | Domain is the standard 4 fields (`name, version, chainId, verifyingContract`), no salt | ✅ |
| F1 | Employee signs offline, relayer submits, hold is created | ✅ |
| F2 | Employee's native balance is **0 wei before and after** | ✅ never pays gas |
| F3 | Signature from the wrong key | ❌ rejected |
| F4 | Replay of the same signature | ❌ rejected |
| F5 | Expired `deadline` | ❌ rejected |
| F6 | Relayer without the partition role, valid signature | ❌ rejected |
| G1 | Self-service `createHoldByPartition` while partitions are protected | ❌ blocked |

**E1 is the assertion that closes the Privy question.** ATS hand-writes its type strings as
`keccak256` literals in `contracts/constants/eip712.sol`, so the risk was that they diverged from
the spec and demanded a bespoke signing path. They do not — `ethers.TypedDataEncoder` generates the
identical string. Combined with Privy's documented support for `eth_signTypedData_v4` and its
`useSignTypedData` hook, **any spec-compliant wallet produces a signature ATS accepts.** There is no
Privy-specific contract work.

F2 is the product claim, mechanically demonstrated: the employee pledged 400 tokens of collateral
while holding zero native balance the entire time. On Hedera that address is an unactivated hollow
account, and it still worked.

F6 and G1 together confirm the security shape is right: the relayer is a **role-gated participant**,
not an omnipotent key — it cannot act without a valid holder signature, and holders cannot bypass it.

> **Trap worth writing down — cost us a real debugging cycle if missed.** The EIP-712 domain
> `version` is **the ATS config version as a decimal string** (from `getConfigInfo().version_`),
> *not* the conventional `"1"`. A frontend that hardcodes `version: "1"` will produce
> signatures that fail verification with no useful error. Read both `name` and `version` from the
> deployed token at runtime and cache them — never hardcode either.

**Not yet covered:** the signature was produced by ethers rather than by Privy's actual SDK in a
browser. Since E1 proves the payload is spec-standard and Privy documents `eth_signTypedData_v4`
support, the residual risk is integration-level (wiring, chain config), not cryptographic. Close it
in Phase 3 with the first real login.

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
| 1 | Can a hold be executed to a non-KYC'd pool? | ✅ **GREEN, conditional** | 10/10 Hardhat assertions against the real ATS contracts. Pledge/repay need no privileges; liquidation requires the pool to be KYC'd **and** allowlisted. Also found C2: held tokens are immune to controller clawback, so hold expiry must always be bounded. See §5.2 |
| 2 | Does an off-chain signature authorise a pledge with the employee paying no gas? | ✅ **GREEN** | 9/9 assertions. ATS's EIP-712 type string is byte-identical to the standard encoding, so any compliant wallet works; employee held 0 wei throughout. Found the domain-`version` trap. See §6.3 |

**All four Phase 0 spikes are green. Nothing outstanding can force a redesign.** Every load-bearing
assumption in this plan has now been executed rather than asserted.

Method note worth reusing: spike #1 ran on a **local Hardhat EVM against the real ATS contracts**,
because "does the compliance stack block this?" is a Solidity question, not a Hedera one. No
testnet, no keys, no faucet, ~1 minute per run. Reach for testnet only when the question is
genuinely about Hedera — gas ceilings, HSS, the mirror node.

### Phase 1 — Token + lifecycle skeleton — ✅ **DONE (local), 18/18 passing**

`tests/esopLifecycle.test.ts` drives the whole lifecycle against real ATS contracts with the
production flag set from §3.1 — pool creation, KYC + allowlist onboarding, a 4-year/1-year-cliff
grant as 37 locks, cliff release, monthly vesting, freeze, bad leaver, good leaver. It is the
executable specification for `ESOPVestingController`, so Phase 2 has nothing left to discover.

Confirmed working end to end: `transferAndLockByPartition` → `releaseByPartition` →
`forceReleaseByPartition` + `controllerRedeemByPartition`, plus `setAddressFrozen` and the relayed
`protectedTransferFromByPartition`.

**Findings that change the build.** Four of these would have cost real time if met mid-Phase-4.

1. **Risk #5 is resolved with a number.** A tranche locked as its **own transaction** costs
   **425k gas average, 535k max**. See the correction in Phase 5 — batched inside `fundTranches`
   the marginal cost is roughly half that, which changes the batching rule substantially.

2. **Multi-partition disables three APIs.** `lock()`, `release()` and `freezePartialTokens()` all
   carry `onlyWithoutMultiPartition`. Use `lockByPartition` / `releaseByPartition` throughout — and
   accept that **partial freeze does not exist for us**. Multi-partition tokens only get
   all-or-nothing address freeze, so "freeze one disputed tranche" is not a feature we can offer.
   Remove it from the issuer console scope.

3. **`setAddressFrozen` and `isFrozen` are inconsistent — do not trust `isFrozen`.**
   `setAddressFrozen` manipulates the **control list** (whitelist mode: removes the address;
   blacklist mode: adds it), while `isFrozen()` reads `frozenTokens[user] > 0`, the *partial-freeze*
   counter that `setAddressFrozen` never writes. So freezing works — transfers are blocked — but
   `isFrozen()` keeps returning `false`. Two consequences:
   - The UI must read freeze state from **`isInControlList()`**, never `isFrozen()`.
   - Freeze and allowlist share one storage slot, so calling `addToControlList()` on a frozen
     employee **silently unfreezes them**. Onboarding and suspension must never be managed by
     independent code paths.

4. **Protected partitions block *every* direct employee action, not just holds.** With
   `arePartitionsProtected = true`, an employee cannot even `transferByPartition` their own vested
   tokens — everything must be relayed via a `protected*` variant with their EIP-712 signature.
   - *Good:* this makes the §6 gasless claim airtight. There is genuinely **no** code path that
     requires an employee to send a transaction, so they never need HBAR or an activated Hedera
     account. Not a convenience — a structural guarantee.
   - *Cost:* the relayer becomes load-bearing for ordinary transfers too. If it is down, employees
     can do nothing. Treat relayer availability as a production concern (health checks, a queue,
     and a documented break-glass path), and add it to the risk register.

5. **Vesting release is genuinely permissionless** — verified by having a zero-role, zero-token
   bystander call `releaseByPartition` and succeed. The trustless-vesting claim in §3.3 holds
   without qualification, and the keeper is a convenience rather than a dependency.

6. **Clawback is bounded by construction.** `controllerRedeemByPartition` cannot reach locked
   tokens, so a controller bug cannot confiscate vested equity by over-redeeming — it reverts.

#### Testnet leg — ✅ **DONE, all five Hedera-specific questions answered**

`scripts/testnet-lifecycle.ts`, run against Hedera testnet (chainId 296) through the pre-deployed
factory. First ESOP token: **`0x17E651D659704A47932ff7Ffd6032860E468cE58`**.

| | Question | Result |
|---|---|---|
| Q1 | Does the pre-deployed factory accept our production flag set? | ✅ Deployed with all six flags. **The version skew is a non-issue** — our contracts are pinned 2026-06-24, the testnet BLR was deployed 2026-06-12, and `deployEquity` worked unchanged. We do not need to deploy our own diamond |
| Q2 | Real Hedera gas for `transferAndLockByPartition`? | ✅ **431,025 avg / 534,795 max** |
| Q3 | Can a never-funded hollow address hold ESOPs? | ✅ Held 2,400 options having never been activated |
| Q4 | Does EIP-712 validate on chainId 296 with the relayer paying? | ✅ Relayed transfer succeeded (297,083 gas); employee's native balance stayed **0** throughout |
| Q5 | Does clawback work on Hedera? | ✅ 1,200 unvested clawed back, 1,150 vested retained (that run predated the switch from burning to pool recovery) |

**The most useful result is Q2, and it is not the number itself.** Hedera charged 431,025 gas
average against 425,406 measured locally — **within 1.3%**. Local Hardhat gas is a trustworthy
proxy for Hedera gas on this workload, so we can keep measuring in the 13-second local suite instead
of spending testnet HBAR. That speeds up every remaining phase.

It also confirms the batching rule with real numbers: a 37-tranche grant extrapolates to **~15.9M
gas**, against Hedera's 15M per-transaction ceiling. One transaction per tranche is not a
preference, it is required.

Q3 and Q4 together retire the last of the hollow-account concern. The employee key was generated in
the script, never funded, never sent a transaction, and still received equity, held it, and
authorised a transfer of it. That is the product claim, executed on the real network.

> Minor correction to the §6.3 trap: the EIP-712 domain `version` read back as `"1"` here, because
> the deployed equity config *is* version 1. The warning still stands — it is the ATS **config
> version**, not a constant — but today's value happens to coincide with the conventional `"1"`.
> Read it at runtime regardless; it will change when ATS registers a v2 config.

**Source verification.** The token is verified on Sourcify with an **`exact_match`**, which is what
HashScan and the mirror-node explorers read:
[`0x17E651…cE58`](https://hashscan.io/testnet/contract/0x17E651D659704A47932ff7Ffd6032860E468cE58).
`scripts/verify.mjs` submits the compiler input straight from our pinned ATS build to Sourcify's v2
API, checks first so it is safe to re-run, and records deployments in `deployments/`.

Two things worth knowing for the judging conversation:

- What we verify is the **`ResolverProxy`** — the diamond the factory created. The facets holding
  the logic are separate contracts deployed by the ATS team and verified independently. A judge
  clicking through HashScan will see a verified proxy, not a verified monolith, and that is the
  correct picture of a diamond.
- We got `runtimeMatch: exact_match` but `creationMatch: null`, because this deployment predates the
  script recording creation transaction hashes. Runtime match is sufficient for explorers to show
  the contract as verified; future deploys record the hash and should match on both.

### Phase 2 — `ESOPVestingController` — ✅ **DONE, 25/25 passing**

`contracts/ESOPVestingController.sol`. Grants, batched funding, permissionless vesting, and the
good/bad leaver matrix. Suite in `tests/esopVestingController.test.ts`; whole repo now 62 tests in
~20 seconds.

**API shape, and why it is two-phase.** `createGrant` records the schedule but locks nothing;
`fundTranches(grantId, maxCount)` then locks it in batches until the grant flips to `Active`. That
split is forced by the Phase 1 gas measurement, not by taste — 37 tranches is ~15.9M gas against a
15M ceiling, so a single-call `createGrant` is impossible. Measured worst batch at 20 tranches:
**5.97M gas**, so 20 is a safe default with real headroom.

`releaseVested(grantId, maxCount)` is **permissionless**, matching the token's own semantics, and
is idempotent — it tolerates being called twice, and tolerates a lock someone released directly on
the token, because vesting genuinely does not depend on this contract.

`terminate` and `clawback` are deliberately separate. `terminate` records the leaving date and moves
no tokens; `clawback(grantId, maxCount)` then force-releases unvested tranches and returns them to
the pool in bounded batches. Force-release and recovery happen **in the same call** on purpose: force-release drops tokens
into the employee's free balance, and leaving them there across transactions would open a window
where they are neither vested nor recoverable.

**The correctness property worth naming: vesting stops at the leaving date.** `terminate` freezes a
cutoff, and every subsequent vesting calculation uses it instead of `block.timestamp`. Without that,
a terminated employee would keep vesting while HR worked through a multi-batch clawback — and since
`releaseVested` is permissionless, *they could trigger it themselves*. Test 4.3 pins this by letting
two years pass between termination and release and asserting the balance never moves past the cliff.
`effectiveAt` may be back-dated to a real last working day but never forward-dated.

Also pinned: a bad leaver still keeps what already vested (4.5) — forfeiture is not confiscation —
and terminating one of an employee's grants leaves their others untouched (5.1).

**Access control is hand-rolled, on purpose.** ATS ships its own `IAccessControl`, so importing
OpenZeppelin's collides by Hardhat artifact name (`HH701`). Two roles did not justify fighting that,
so the contract implements `admin` + `isGrantAdmin` directly.

**Deployment note:** the controller *holds the option pool*, because `transferAndLockByPartition`
moves tokens from the caller. So it must be onboarded on the token exactly like a person — KYC'd and
allowlisted — and granted `ROLE_LOCKER`, `ROLE_CONTROLLER` and (while partitions are protected)
`ROLE_WILD_CARD`. `returnToTreasury` exists so the unallocated remainder is not stranded.

#### Security review pass (`solidity-dev` skill) — 5 findings, all fixed

Reviewed against
[`solidity-dev-skill`](https://github.com/balajipachai/solidity-dev-skill), plus a Slither run.
Suite went 25 → 30 tests.

| # | Finding | Severity | Fix |
|---|---|---|---|
| 1 | **Clawback burned the amount recorded at grant time, not the current one** | **High** | Burn what the token reports as locked now |
| 2 | External call before state write in both fund-moving loops | Medium | Flip `released`/`clawedBack` before the call (CEI) |
| 3 | No reentrancy guard on value-moving functions | Medium | Inline `nonReentrant` on all four |
| 4 | One-step `transferAdmin` could strand the role at a typo | Medium | Two-step `transferAdmin` + `acceptAdmin` |
| 5 | Termination verdict was not attributed on-chain | Low | `GrantTerminated` now logs `decidedBy` |

**Finding 1 was a real, quantified value bug, and the interesting one.** ATS scales locks by an
adjust-balance factor, so `getLockForByPartition` returns a **split-adjusted** amount while our
stored `Tranche.amount` stays at its grant-time nominal value. `clawback` force-released the
adjusted amount into the employee's free balance but redeemed the *nominal* one. I proved the gap
rather than asserting it: with the pre-review code, after a 2-for-1 split a bad leaver kept
**4,800 tokens** they had already forfeited (test 6.4 fails with `expected 4800 to equal 0`); after
the fix, zero. This is exactly the skill's *"derive stored amounts from actual value transferred,
never from a recorded parameter"* rule, and it would have been invisible until the first company
did a stock split.

**Finding 5 is the trust-boundary rule applied to `terminate`.** Employment ends off-chain, so
`leaver` and `effectiveAt` have to be parameters — no on-chain fact can establish who resigned or
which day was their last. Pretending otherwise would be fake trustlessness. The mitigations are
procedural, and now all three are present: the verdict is permanently attributed to `msg.sender`,
the grant-admin role is revocable via `setGrantAdmin`, and the *reason it is a parameter* is
written into the NatSpec so it survives the next reader.

**Slither:** 18 → 16 results. The two removed were unchecked booleans from `releaseByPartition` /
`forceReleaseByPartition` — they always return `true` today, but ATS is an upgradeable diamond, so
the contract now checks them and reverts with `TokenCallFailed`. The remaining 16 are
`calls-loop` (one lock per tranche is the design; `maxCount` is the bound), `timestamp` (vest dates
are months apart, so validator-scale drift cannot move a tranche across its boundary),
`uninitialized-state` on a mapping, and `unused-return` on a call that returns a partition key
rather than a status. Each carries an inline `slither-disable-next-line` with its reason.

#### Gas: storage pointers vs memory copies — measured, not assumed

The skill's gas reference says *"read a storage struct into memory once, mutate the memory copy,
write it back once."* Applied literally to `Grant` and `Tranche` that is **measurably wrong**, and
`contracts/test/GasProbe.sol` + `tests/gasProbe.test.ts` exist so the claim can be re-checked rather
than argued.

| Pattern | Storage pointer | Memory copy + write-back | Verdict |
|---|---:|---:|---|
| `terminate()` — 3 writes into one packed slot | 26,937 | 35,344 | memory **+31%** |
| Read 2 fields from a 4-slot struct | 28,778 | 32,999 | memory **+15%** |
| Release loop, 13 tranches | 121,312 | 131,060 | memory **+8%** |

The reason is that **`storage` pointers are lazy and `memory` copies are eager.** A storage pointer
touches only the slots you actually read or write; `Grant memory g = _grants[id]` loads all four
slots and `_grants[id] = g` writes all four back, even when only one changed. And the premise that
"each `g.member =` is a costly write" does not hold either: after the first SSTORE, further writes
to the *same* slot in the same transaction cost 100 gas, and `Grant`'s `status`, `terminatedAt` and
`leaver` are all in slot 3 by construction.

**The instinct still pointed at something real, just one level down.** Inside the loops, `g.employee`
and `g.partition` were re-read every iteration, and each `Tranche` field access was a separate
SLOAD of the *same* packed slot. Hoisting the invariants onto the stack and reading each tranche
once with `Tranche memory t = list[i]` — while keeping the single mutation as a targeted storage
write — is the correct form of the optimisation:

| Hot path | Before | After | Saved |
|---|---:|---:|---:|
| `releaseVested(12)` | 1,055,467 | 1,049,506 | −5,961 (0.56%) |
| `clawback(12)` | 925,192 | 920,160 | −5,032 (0.54%) |

Applied, because it costs nothing. Kept in perspective, because it is **half a percent** — these
functions are dominated by the external calls into the ATS diamond, at roughly 80k each. Anyone
optimising this contract further should attack the number of diamond round-trips, not the struct
access.

> Methodology note, because it nearly produced the wrong answer: the first draft of the probe wrote
> a `sink` variable that started at zero, so the first measurement in each test paid ~20k for a
> zero-to-non-zero SSTORE and every later one ~2.9k. That artefact alone was larger than the effect
> being measured and reversed two of the three verdicts. The probe now warms `sink` first.

**Two deliberate deviations from the skill's defaults**, both forced by the ATS host project:
Hardhat instead of Foundry (our suites need ATS's fixtures and path aliases, which only resolve
inside its own project), and hand-rolled access control instead of OpenZeppelin (ATS ships its own
`IAccessControl`, which collides by Hardhat artifact name). The `admin` role still follows the
`Ownable2Step` *shape*, which is the part that actually matters.

### Phase 3 — Employee portal + Privy — ✅ **DONE, verified end-to-end in a browser**

`apps/employee-portal` (Next.js 16, React 19, viem, `@privy-io/react-auth` v3 + `@privy-io/node`).
Login, My Equity, vesting timeline, manual claim. Builds and typechecks clean.

**On-chain prerequisites, both done and verified.** `ESOPVestingController` is deployed at
[`0xe630d8…3AE3`](https://hashscan.io/testnet/contract/0xe630d8fa035A99FB1e2ac51Df790059674313AE3)
(Sourcify `exact_match`), holding 500,000 options, with demo grant #1 live: 2,400 options over 13
tranches on a compressed schedule so a cliff actually lands during a demo. `npm run testnet:grant`
issues a grant to any address, which is how you grant to the Privy wallet after logging in.

**The read path is verified against live testnet**, independently of Privy: vested 1,200,
unvested 1,200, 1 tranche claimable, 13 tranches, locked 2,400. So the half that does not depend on
an app ID is proven working, not just compiling.

**Architecture, as built:**

- The employee's Privy wallet is an **identity, not a sender**. The server verifies the access
  token, resolves the wallet from Privy's directory — *never* from anything the client sent — and
  the relayer signs. That resolution step is the entire security model: a client-supplied address
  would let anyone claim anyone's equity.
- Reads go straight from the chain via viem; writes go through `/api/claim`.
- `/api/claim` derives the grant from the **verified wallet**, not from a `grantId` in the body.
  `releaseVested` is permissionless on-chain, so this is correctness rather than authority — but
  taking an id from the body would still be the wrong shape.
- **The relayer's authority is deliberately narrow.** It can only trigger `releaseVested`, which
  anyone can call anyway. A compromised relayer wastes gas; it cannot move anyone's equity. Pledging
  collateral in Phase 4 needs the employee's own EIP-712 signature, which is what spike #2 proved.

**One deliberate deviation from the loyalty-card pattern.** That app throws when
`NEXT_PUBLIC_PRIVY_APP_ID` is missing. Here that broke `next build` at prerender — a missing runtime
secret should not fail a build — so the portal renders a setup screen instead.

**Verified in Chrome against live testnet**, which is the only thing that closes this phase — the
plan's own rule is that typechecks do not catch wallet-state bugs. The full loop ran: Privy session
resolved to embedded wallet `0x8a3DbE…16e9`; the portal correctly showed "no grant yet" with the
address to grant to; `testnet:grant` issued 2,400 options over 13 tranches; the cliff vested live
with the countdown ticking; **Claim** relayed `releaseVested` and the banner, the "in your wallet"
stat and the timeline all updated.

Confirmed independently on-chain afterwards, because a green UI is not evidence:

| | |
|---|---|
| Employee spendable | 1,200 (the claimed cliff) |
| Employee still locked | 1,200 |
| **Employee native balance** | **0 — never paid gas** |
| Relayer spent | ~0.39 HBAR |

That last row is the product claim, measured rather than asserted: an employee holding real equity
on an unactivated Hedera account, having never touched HBAR.

**One bug the browser caught that nothing else would have.** Every tranche rendered as the same
date, because the row formatter was date-only and a compressed demo schedule puts tranches minutes
apart. Fixed by choosing the format from the schedule's actual span: under two days it shows the
time, otherwise the date. Unit tests and `tsc` were both green throughout.

### Phase 4 — Lending — 🟡 **contracts done, 24/24 passing; not yet deployed or wired to a UI**

`contracts/lending/`: `ESOPLendingPool`, `EsopNavOracle`, `MockUSDC`. Designed against the
`solidity-dev` skill **before** writing, per the standing rule, and the state machine below was
written out first rather than discovered.

| From | Action | Guard | To |
|---|---|---|---|
| — | `borrow` | pool is escrow **and** destination; expiry bounded and within [minTerm, maxTerm]; LTV ≤ 25%; both feeds fresh; liquidity available; hold not already pledged | Active |
| Active | `repay` / `repayAll` | partial reduces debt; full releases the hold | Active / **Repaid** |
| Active | `liquidate` | LTV ≥ 40% **or** past maturity | **Liquidated** — takes only what covers the debt, releases the surplus |

**Collateral never leaves the borrower's wallet.** It is a hold, not a transfer: the shares stay
theirs, marked as held, and only liquidation moves anything — through the token's full compliance
stack. Test 2.1 asserts the pool's balance is zero while a loan is outstanding, which is the whole
pitch in one assertion.

**Three things testing found that reasoning had not.**

1. **`executeHoldByPartition` reverts once a hold expires.** A loan maturing *at* its collateral's
   expiry could therefore never be seized — the borrower would simply reclaim and leave the pool
   unsecured. Maturity is now set to `expiry − liquidationGrace` (3 days), so there is always a
   window in which the loan is seizable and the hold is still executable. This was a genuine
   design bug, not a test artefact.
2. **`releaseHoldByPartition` reverts after expiry too**, which would have trapped a borrower
   trying to repay a lapsed loan — repayment would revert and the debt could never be cleared.
   Repayment now always succeeds; if the hold has lapsed the collateral is simply the borrower's
   to reclaim directly.
3. **A never-expiring hold cannot be created at all.** Spike #1's finding C2 — held tokens are
   immune to clawback — implied a permanent escape hatch via a zero-expiry hold. ATS refuses to
   create one, so the risk is closed a layer below us. The pool keeps its own guard anyway, since
   that is a property of ATS today rather than something it owes us.

**Valuation.** `EsopNavOracle` implements Chainlink's `AggregatorV3` shape, so a listed issuer
swaps in a real feed at the same interface and nothing downstream changes — that is the listed vs
unlisted answer from §5.3, delivered as one setter rather than a separate router contract. The pool
reads **two** feeds: NAV for the collateral and a peg feed for the stablecoin, because if USDC is
worth $0.90 then a borrower repaying "1,000 USDC" is repaying $900 of value, and pricing collateral
as though it were $1,000 quietly under-collateralises the book. Staleness bounds are **per feed**
— an appraisal is annual by nature, a market feed that has not moved in a day is broken — which is
the §5.3.2 lesson applied rather than restated.

The NAV oracle is the trust boundary, handled the way `terminate` was: the price is a parameter
because no on-chain fact can derive a private company's share price, every publication is
attributed to its writer with a free-text `basis` (a 409A id, a funding round), the agent roster is
revocable, and a `maxDeviationBps` circuit breaker stops one fat-fingered price repricing every
loan at once.

**A property worth naming: a stale price pauses liquidation, deliberately.** Seizing somebody's
equity at a price nobody can vouch for is worse than waiting. The operational answer is to keep the
feed alive — which makes oracle liveness a solvency concern here, not just a UX one. Test 4.6 pins
it.

**Slither:** 17 → 16 on the pool, 1 on the oracle. Fixed rather than suppressed: a
`divide-before-multiply` in `collateralValue` that lost precision on large positions, and two
unchecked ATS return values. `repay` now **caps** at the amount owed instead of reverting on an
overshoot — interest accrues per second, so anyone aiming at the exact figure is guessing, and
punishing an overshoot would make undershooting (which silently leaves the loan open) the safer
mistake. Everything remaining carries an inline suppression with a reason.

#### Live on testnet, borrow and repay verified

| | |
|---|---|
| `ESOPLendingPool` | [`0x0f286F…cbF6`](https://hashscan.io/testnet/contract/0x0f286F61d1bC1196098fFF3C302EC118F525cbF6) |
| `EsopNavOracle` | [`0x5E3fa4…9c41`](https://hashscan.io/testnet/contract/0x5E3fa4B87Ab7A7359A21196d59E4b1943CB29c41) |
| `MockUSDC` | [`0x80f3F9…876a`](https://hashscan.io/testnet/contract/0x80f3F992d1771BA7562c1749dc09695fa285876a) |

All three Sourcify `exact_match`. The peg feed points at the **real Chainlink USDC/USD feed**
(`0xb632a7…B6B5`), not a stand-in.

`npm run testnet:lending-demo` runs a full loan against live testnet. Pledged 5,000 shares,
borrowed 1,250.10 USDC at 12.49% LTV, repaid in full, collateral returned. Two details worth
noticing in that output:

- **1,000 shares priced at 2000.16 USDC, not 2000.00.** The live Chainlink feed reports USDC at
  $0.99992, so $2,000 of value costs slightly more than 2,000 coins. That is the depeg adjustment
  doing real work against a real feed, not a rounding artefact.
- **The pool's ESOP balance stayed at zero throughout.** The borrower's shares never moved — 5,000
  sat in their own wallet marked as held, then came back. That single number is the pitch.

**Still to do:** wire borrow/repay into the employee portal behind the
`protectedCreateHoldByPartition` signature path from spike #2, so an employee can do this without
gas. The contracts and the demo script prove the mechanic; the UI is what makes it a product.

### Phase 4 (original plan) — Lending
`EsopNavOracle`, `EsopPriceRouter`, `ESOPLendingPool`, Chainlink feeds, borrow/repay/liquidate,
portal borrow UI. **Onboard the pool address as a KYC'd + allowlisted holder as part of deployment**
(spike #1) and enforce bounded hold expiry (finding C2).
**Demoable:** the differentiator — borrow against vested equity without selling it.

### Phase 5 — Issuer console — 🟡 **built; reads verified, writes need a connected wallet**

`apps/issuer-console` (Next.js + viem, port 3001). Option pool summary, onboarding (KYC +
allowlist), grant issuance with a configurable schedule, suspend/reinstate, and the good/bad leaver
flow with clawback. Brought forward ahead of Phase 4 because until it existed `terminate` and
`clawback` had **no caller at all** outside the Hardhat tests — the leaver moment, which is the
sharpest part of the demo, could not be shown.

**HR signs with their own wallet, not a shared server key.** That asymmetry with the employee
portal is deliberate: `terminate` records `msg.sender` as the deciding address, so per-person
signing is what makes that attribution mean anything, and one shared key would trace every
forfeiture to the same address. The portal relays for exactly the opposite reason — an employee
should never need gas to receive their own equity. `npm run testnet:grant-roles` authorises an HR
wallet without anyone importing the operator key into a browser.

#### Real economics, measured on testnet — and a correction to Phase 1

The first grant issued through the console cost **3.72 HBAR ≈ $0.30** (HBAR at $0.0799, from the
Chainlink feed verified in §5.3.2). From the mirror node:

| Call | gas limit | gas used | used/limit | Fee |
|---|---:|---:|---:|---:|
| `createGrant` (13 tranches) | 524,174 | 495,846 | 94.6% | 0.53 ℏ |
| `fundTranches` (13 tranches) | 3,170,214 | 2,982,440 | 94.1% | 3.19 ℏ |

**This corrects the Phase 1 batching rule.** A tranche costs ~425k gas as its *own* transaction but
only **~230k batched** inside `fundTranches` — the base fee and calldata amortise, and storage stays
warm. A full 37-tranche grant is therefore **~8.5M gas, comfortably inside one transaction**, not
the ~15.9M extrapolated earlier. Batch size raised 20 → 40. The Phase 1 figure was not wrong, it
measured the wrong thing: 37 separate transactions, which is not how the controller funds.

| Schedule | Gas | Cost |
|---|---:|---:|
| 13 tranches (demo) | 3.5M | **$0.30** |
| 17 tranches (3y quarterly) | 4.5M | **$0.39** |
| 37 tranches (4y monthly) | 9.9M | **$0.85** |

Plus roughly $0.03 per claim, so **lifetime cost per employee is under $2**. The comparison that
matters is not against zero but against Carta, or a spreadsheet plus a lawyer. If cost ever bites,
the lever is schedule granularity — quarterly vesting more than halves it, and employees can batch
claims rather than claiming monthly.

Worth knowing for anyone tuning this: MetaMask's estimates landed at ~94% of gas used, so there is
no headroom being wasted. Do **not** "fix" anything with a generous hardcoded gas limit — Hedera
charges most of the offered limit even when unused, so an over-generous constant is a real cost
rather than free safety.

> **Do not trust Hedera's `eth_estimateGas` for loops.** A claim reverted on-chain
> ([`0xfc8038…d73c`](https://hashscan.io/testnet/transaction/0xfc803847978fb637560975f4db270a050fa83d48308d1791cd6756aba9a1d73c))
> having burned 523,181 of a 523,257 limit with an empty revert reason — the signature of
> running out of gas, not of a failed require. The estimator had returned ~523k for a
> `releaseVested` that our own measurement puts at ~1.05M for 12 tranches: it under-counts
> loops that call into the ATS diamond, by roughly half. Both apps now size the limit from
> the work itself (~140k per tranche against ~88k measured) rather than from the estimate.
> Sizing beats a blanket multiplier here because Hedera charges most of the offered limit
> even when unused, so over-asking is a real cost rather than free insurance.
>
> **Two clock traps in `terminate`, both found by simulating rather than guessing.**
> The contract rejects an effective date after `block.timestamp` (to stop anyone
> forward-dating a termination and manufacturing extra vesting) and before `grantDate`.
> Sending `Date.now()` reverted with `EffectiveDateInFuture` because the browser clock ran
> **5 seconds ahead of consensus** — well within normal skew, and a race rather than a
> misconfiguration. Defaulting instead to "today at midnight" then reverted with
> `EffectiveDateBeforeGrant` for any grant issued earlier the same day. The console now
> clamps to `[grantDate, chainNow]` and takes the leaving date from a date picker, which
> is the honest model anyway: HR terminates as of a real last working day, usually in the
> past, and back-dating legitimately forfeits everything that would have vested after it.
>
> **A separate trap that looked like a revert.** `terminate` failed with *"RPC endpoint returned HTTP client
> error"*, which reads like a contract revert but is not one — Hedera rejects raw transactions
> priced below the network minimum, and MetaMask offered less. Cheap calls hit it while expensive
> ones happened not to. Every issuer write now prices from `eth_gasPrice` with a margin rather than
> leaving it to the wallet. ATS's own constants flag this: *"must be set alongside gasLimit to skip
> eth_estimateGas on Hedera"*.

### Phase 6 — Automation + polish
HSS `scheduleCall` auto-vesting (with keeper fallback), Mirror Node indexer, dividends, seeded demo
data, recorded fallback video.

### Phase 7 — Stablecoin payroll on Privy

**Why this is not a bolt-on.** There is a hole in the product as it stands: an employee borrows
500 USDC against vested equity and immediately owes 500.000166, because interest accrues from the
first second. On testnet there is no income anywhere in the system, so the borrowed funds can
never close the loan and the demo needs a faucet to finish. Payroll supplies the missing half —
salary is what services the loan. Same issuer, same employees, same wallets, and the faucet
becomes a product feature instead of a workaround.

**Shape.** An organisation treasury as a Privy **server wallet** holding USDC. HR drafts a payroll
run (recipients + amounts); the run requires **key-quorum** approval before it can be signed; a
**policy** on the wallet independently constrains what it is even capable of. Then a batch of
USDC transfers, with an on-chain receipt.

The quorum is the same instinct as `ESOPVestingController.setArbiter` requiring a multisig with
`getThreshold() >= 2` — no single person should be able to move other people's money on their own.
Worth saying in the pitch: the same principle is enforced twice, once in Solidity for forfeiture
and once in Privy for payment.

**Defence in depth, deliberately.** Quorum answers *who approved this run*; policy answers *what
this wallet can do at all*. A compromised approver still cannot send to an address outside the
allowlist, and a policy bug still cannot move funds without approvals. Neither is a substitute for
the other, and saying so is a stronger answer than presenting one control as sufficient.

**Verified available** in `@privy-io/node@0.34` as installed — no upgrade needed:
`keyQuorums.create({ authorization_threshold })`, `policies.create({ rules: [{ action, method,
conditions: [{ field_source: 'ethereum_transaction', ... }] }] })`, plus `wallets`,
`organizations`, `intents` and `wallet-automations`.

**Policy rules to enforce** (each maps to a real payroll control):

| Rule | Why |
|---|---|
| `method: eth_sendTransaction`, recipient ∈ allowlist | payroll may only pay onboarded employees |
| `to` = MockUSDC only | the treasury cannot touch the ESOP token — payroll must never move equity |
| per-transaction cap | bounds the blast radius of a bad run |

That second rule is the one worth defending out loud: the payroll wallet is structurally incapable
of touching the equity ledger, so a payroll compromise cannot become a cap-table compromise.

**Contract surface.** A small `PayrollDisburser` that takes `(address[] recipients, uint256[]
amounts)`, pulls USDC by allowance from the treasury and emits `SalaryPaid` per employee — an
on-chain payroll register, so payslips are receipts rather than database rows. Alternative
considered: pure Privy wallet transfers with no contract, which is less to build and less to
redeploy but leaves no auditable register. **The contract gets the `solidity-dev` review pass
before it is written, not after.** It also batches, which on Hedera matters: §5.1 measured batched
tranches at ~230k gas against ~425k done singly.

**Qualification mapping** (Privy B2B track):

| Requirement | Where it is met |
|---|---|
| Privy as a core part | already load-bearing — every employee is a Privy embedded wallet, and §6 relays their signatures |
| At least one Privy wallet | employee embedded wallets + the org treasury server wallet |
| Business/organisation use case | an issuer paying its employees |
| A functional B2B workflow | draft run → quorum approval → disbursement |
| At least one Privy control | key quorum **and** policy (see above) |
| Explain how Privy enables it | employees never hold gas or seed phrases, yet receive salary and service loans from the same wallet |

**Ordering note.** This should probably come *before* Phase 6, not after. Phase 6 is explicitly the
designated cut line below, and payroll is a whole second submission track. The earlier argument for
doing Phase 6 first was that its `scheduleCall` scheduler would be reused here — that is weaker
than it looked: a quorum-approved manual run qualifies on its own, and HSS scheduling is an
enhancement to payroll rather than a prerequisite for it.

**Cut line:** Phases 0–4 are the submission. Phase 5 makes it enterprise-credible. Phase 7 opens a
second prize track. Phase 6 is upside — if you are behind, cut Phase 6 first and the cap table from
Phase 5 second.

---

## 10. Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | ~~Hold cannot be executed to a non-KYC'd pool~~ | ~~High~~ → **Closed** | Confirmed by spike #1 (§5.2), then **exercised for real** by `testnet:liquidation-demo`: the pool seized 2,174 of 5,000 pledged shares and released the 2,826 surplus. Pledge and repay are unrestricted; the seizure leg needs the pool KYC'd + allowlisted, which `testnet:deploy-lending` does |
| 1b | **Perpetual hold used to dodge clawback** | Medium *(new, from spike C2)* | Held tokens are immune to `controllerRedeemByPartition` and there is no issuer override. `ESOPLendingPool` must never issue a hold with `expirationTimestamp = 0`, and must cap user-supplied expirations |
| 2 | ~~Privy hollow accounts un-activated~~ | ~~High~~ → **Low** | **Retired by §6.** Employees never send transactions, so their accounts never need activating. Only the backend relayer needs HBAR — one account to fund and monitor |
| 3 | ~~Chainlink feeds stale or absent~~ | ~~Medium~~ → **Closed** | Verified live (§5.3.2). Residual: use **per-feed** staleness thresholds — USDC/USD was 18 h old at check time and a global 1 h guard would brick the pool |
| 4 | ~~HIP-1215 unavailable~~ | ~~Low~~ → **Closed** | Verified live (§7). Residual: the 62-day expiry cap forces rolling re-arm; the keeper must detect a failed roll |
| 5 | ~~37 tranche locks exceed the gas ceiling~~ | ~~Medium~~ → **Closed** | Measured in Phase 1: 425k avg / 535k max per tranche. Safe as one tx per tranche; unsafe if batched (15.7M total vs a 15M ceiling) |
| 5b | **Relayer downtime blocks all employee actions** | **High** *(new, from Phase 1)* | Protected partitions mean employees cannot transact directly at all. Health-check the relayer, queue and retry submissions, and document a break-glass (temporarily grant the employee `WILD_CARD`, or unprotect the partition) |
| 6 | ATS SDK v8 API drift vs docs | Medium | The vendored source is ground truth — read `packages/ats/sdk/src/port/in`, not the docs |
| 7 | Hashio rate limits under demo load | Medium | Own relay endpoint or a paid provider; cache reads through the Mirror Node, not RPC |
| 8 | **Relayer key compromise or drain** | **High** *(new)* | The relayer pays all gas and holds issuer authority. Rate-limit per user, idempotency keys, cap per-tx gas, alert on balance drop, keep it off the issuer's admin key. Spike #2 F6 confirms it cannot pledge without a holder signature, which bounds the blast radius |
| 8b | **Hardcoded EIP-712 domain `version`** | Medium *(new, from spike #2)* | ATS sets domain `version` to the config version (`getConfigInfo().version_`), not `"1"`. Hardcoding it yields signatures that fail with no useful error. Read `name` and `version` from the deployed token at runtime |
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
