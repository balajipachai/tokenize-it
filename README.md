# tokenize-it

Tokenized employee stock options with real lifecycle management, on Hedera via the
[Asset Tokenization Studio](https://github.com/hashgraph/asset-tokenization-studio).

Employee stock options are the most widely held private-market asset on earth and the worst
served. A grant is a PDF, vesting is a spreadsheet, and nobody can borrow against equity they
have already earned. This runs the whole lifecycle on-chain — issuance, KYC gating, vesting,
suspension, leaver clawback, appeals — then lets an employee borrow against their **vested**
options without selling them and without leaving the compliance perimeter, and pays their
salary in the same stablecoin they repay the loan with.

**The one idea worth keeping:** collateral never leaves the employee's wallet. A pledge is an
ERC-1400 *hold* over their own balance, not a transfer. The issuer keeps freeze and clawback
authority over pledged equity, and the lending pool never has to be trusted with custody —
because it never has any. You can check that claim yourself in about five seconds:

```bash
npm run proof:no-custody
```

---

## What you need before you start

| | | |
|---|---|---|
| **Node.js 20+** | `node --version` | any recent LTS is fine |
| **A Hedera testnet account** | [portal.hedera.com](https://portal.hedera.com) | free, funded with test HBAR, takes two minutes |
| **A Privy app** | [dashboard.privy.io](https://dashboard.privy.io) | free; only needed for the employee sign-in |
| **MetaMask** | [metamask.io](https://metamask.io) | only needed for the issuer side |

Nothing here costs real money. Hedera testnet HBAR comes from the portal faucet, and the
stablecoin is a testnet stand-in you can mint freely.

If you only want to run the tests, you need none of the above — skip to
[Run the tests](#run-the-tests).

---

## Quick start

### 1. Install

```bash
git clone git@github.com:balajipachai/tokenize-it.git
cd tokenize-it
npm install
npm run setup:ats
```

`setup:ats` clones the Asset Tokenization Studio into `vendor/` (gitignored) at a pinned
commit and installs its contracts workspace. It takes a few minutes and only has to happen
once. ATS is not vendored in git because it is large and we only need it as a build and test
host — the source of truth for everything in this project stays in this repository.

### 2. Check it works, without touching a network

```bash
npm run test:ats
```

165 tests, about 45 seconds, entirely on a local EVM. No testnet account, no keys, no faucet.
If this passes, the contracts are fine and anything that goes wrong later is configuration.

### 3. Point it at Hedera testnet

```bash
cp .env.example .env
```

Open `.env` and fill in three values from your Hedera portal account:

```
HEDERA_TESTNET_PRIVATE_KEY_0='0x...'    # the HEX ECDSA key, 0x-prefixed
HEDERA_TESTNET_ACCOUNT_ID='0.0.xxxxxx'
HEDERA_TESTNET_EVM_ADDRESS='0x...'
```

This account pays for every transaction the scripts send and holds the issuer's authority, so
give it a few hundred test HBAR from the portal faucet.

> `.env` is gitignored and must stay that way. Never paste a private key into an issue, a pull
> request, or a chat window.

### 4. Deploy your own stack

Each of these records what it deployed into `deployments/hedera-testnet.json`, which is what
the app and every later script read. Run them in this order:

```bash
npm run testnet:lifecycle          # deploys the ESOP token through the ATS factory
npm run testnet:deploy-controller  # vesting, leavers, disputes
npm run testnet:deploy-lending     # stablecoin, NAV oracle, lending pool
npm run testnet:deploy-payroll     # salary disbursement
```

Then hand the issuer console's powers to the wallet you will actually click with:

```bash
HR=0xYourMetaMaskAddress npm run testnet:grant-roles
```

**Or skip all of it.** A working stack is already live on Hedera testnet and recorded in
`deployments/hedera-testnet.json` — see [Live addresses](#live-addresses). If you just want to
see the thing run, leave that file alone and go to the next step.

### 5. Configure and start the app

```bash
cp apps/web/.env.example apps/web/.env.local
```

Fill in `apps/web/.env.local`:

```
NEXT_PUBLIC_PRIVY_APP_ID=''   # from dashboard.privy.io
PRIVY_APP_SECRET=''           # same place
RELAYER_PRIVATE_KEY=''        # a funded testnet key that is NOT your issuer key
```

The relayer is what makes the employee experience work: it pays every network fee, so an
employee can hold equity on an account that has never touched HBAR. Give it a separate testnet
account with some HBAR in it. It can only trigger `releaseVested`, which anyone can call
anyway, so a compromised relayer wastes gas and nothing else.

```bash
npm run dev
```

- **http://localhost:3000** — the employee. Sign in with an email; Privy creates a wallet on
  first login. No extension, no seed phrase, no HBAR.
- **http://localhost:3000/issuer** — the issuer. Connect the MetaMask wallet you passed as `HR`
  above. Every action is signed by *that* wallet rather than a shared server key, because
  `terminate` records the deciding address on-chain and that attribution should mean something.

### 6. Give yourself something to look at

The employee page will be empty until someone has been granted options. From the issuer
console, onboard an address and issue a grant — or do it from the command line:

```bash
EMPLOYEE=0xTheWalletThePortalShowsYou npm run testnet:grant
```

That onboards the address (KYC plus allowlist), issues a 2,400-option grant over 13 tranches,
and funds every tranche as an on-chain lock. The cliff vests two minutes later, so you do not
have to wait a year to watch vesting work.

---

## Run the tests

```bash
npm run test:ats         # everything — 165 tests, ~45s
npm run test:lifecycle   # the ESOP lifecycle on raw ATS primitives
npm run test:controller   # vesting, leavers, disputes
npm run test:spikes      # the experiments that settled the load-bearing design questions
```

These are Solidity questions and a local EVM answers them all. Reach for testnet only for
genuinely Hedera-specific behaviour: gas ceilings, the Schedule Service, the mirror node.

Our tests need ATS's Hardhat path aliases and deployment fixtures, so `scripts/ats-test.sh`
syncs them into the vendored project and runs Hardhat there.

> Keep `useLoadFixture` at its default (`true`) in `deployEquityTokenFixture`. Passing `false`
> redeploys the entire ATS infrastructure on every `beforeEach` and takes the suite from 45
> seconds to 36 minutes.

---

## Walking through each flow on testnet

Each of these drives one complete flow against live Hedera and prints what happened at every
step. They are the fastest way to understand what the contracts actually do.

| Command | What it does | Takes |
|---|---|---|
| `npm run proof:no-custody` | Shows the pool holding zero shares while collateral sits in the employee's wallet | seconds |
| `npm run testnet:lending-walkthrough` | Pledge, borrow, accrue interest, repay, release | ~2 min |
| `npm run testnet:liquidation-walkthrough` | Publishes a down round, seizes the debt, returns the surplus | ~3 min |
| `npm run testnet:dispute-walkthrough` | Bad leaver, appeal, arbitration, reinstatement — every branch | ~8 min |
| `npm run testnet:payroll-walkthrough` | A quorum-approved salary run | ~1 min |
| `npm run testnet:dividend-walkthrough` | Record date, snapshot, pro-rata distribution | ~90s |

A full manual pass over every flow, in order, is in [docs/TESTING.md](./docs/TESTING.md).

---

## Payroll

```bash
npm run testnet:deploy-payroll
node apps/web/scripts/setup-payroll-org.mjs        # Privy quorum + policy + treasury wallet
TREASURY=0x… npm run testnet:set-payroll-treasury  # hand the contract over to the quorum
```

`setup-payroll-org.mjs` prints a treasury address. Send it some testnet HBAR — it pays for its
own transactions.

Salary in stablecoin, from a treasury nobody controls alone. It closes a real hole: interest
accrues from the first second of a loan, so an employee owes more than they borrowed and
nothing else in the system produces the income to cover it. Salary is the missing half, and
paying it in the same stablecoin the pool lends is what makes "borrow against equity, repay
from wages" true rather than rhetorical.

Three layers, each answering a different question:

| Layer | Question | Enforced by |
|---|---|---|
| Key quorum | *Who approved this run?* | Privy — 2 of 2 officers |
| Policy | *What can this wallet do at all?* | Privy — `to ∈ {payroll, stablecoin}`, `chain_id = 296` |
| Contract | *Who may be paid?* | bytecode — allowlisted employees only |

The middle one carries the argument: the treasury is **structurally incapable** of sending to
the ESOP token, so a compromised payroll wallet cannot become a compromised cap table. Both
controls were tested by trying to break them — one signature is refused with a 401, and a
request to the equity token carrying a *full* quorum is refused with `policy_violation`.

Runs are drafted in the console's **Payroll** tab and approved per officer, so the threshold is
visible rather than something you take on trust.

> If you redeploy the payroll contract, re-point the policy at it or every run will be refused:
> `node apps/web/scripts/sync-payroll-policy.mjs`

---

## Live addresses

All verified on [Sourcify](https://sourcify.dev) as `exact_match`, which is what HashScan and
the mirror-node explorers read.

| Contract | Address |
|---|---|
| ESOP token (ResolverProxy) | [`0x17E651…cE58`](https://hashscan.io/testnet/contract/0x17E651D659704A47932ff7Ffd6032860E468cE58) |
| ESOPVestingController | [`0xbCd631…e065`](https://hashscan.io/testnet/contract/0xbCd6318cF45f470B845eBfb292a05212150ce065) |
| ESOPLendingPool | [`0x1c1885…Ae2C`](https://hashscan.io/testnet/contract/0x1c1885A672c39EEA505E75B83508D78574f7Ae2C) |
| PayrollDisburser | [`0x23608a…e013`](https://hashscan.io/testnet/contract/0x23608aC73e238F95a378233318E526EE6059e013) |
| EsopNavOracle | [`0x0C101f…5511`](https://hashscan.io/testnet/contract/0x0C101f1439B2356C2E7b1844FB039b7BB8885511) |
| MockUSDC (testnet stand-in) | [`0x7f22F5…07F9`](https://hashscan.io/testnet/contract/0x7f22F51119D41CA4D8Cc36b0b48cf01c644407F9) |
| Chainlink USDC/USD | [`0xb632a7…B6B5`](https://hashscan.io/testnet/contract/0xb632a7e7e02d76c0Ce99d9C62c7a2d1B5F92B6B5) |

Two notes a reader deserves up front.

The **ESOP token is a `ResolverProxy`** — an EIP-2535 diamond created by the ATS factory — so
verifying it publishes the *proxy's* source. The ~100 facets holding the actual logic are
separate contracts deployed and verified by the ATS team.

**`EsopNavOracle` does not fetch anything from Chainlink.** It implements Chainlink's
`AggregatorV3` interface, which invites exactly the opposite assumption, but the price is
whatever a valuation agent last published by hand. That is unavoidable: a private company's
share price comes from an independent appraisal (a 409A in the US, an HMRC-agreed valuation for
UK EMI options, a Rule 11UA report in India) and no on-chain fact can derive it. The mitigations
are procedural and all three are in the contract — every update is permanently attributed to its
writer, the writer roster is revocable, and no single update may move the price more than 30%.
The *peg* feed above is a genuine Chainlink feed. One of the two is real and the other is
published by a person, and both say so in their own NatSpec.

### Verifying your own deployments

```bash
npm run verify                    # verifies whatever the last run deployed
node scripts/verify.mjs 0xabc...  # or one specific address
```

Safe to re-run: it checks first and exits early if the contract is already verified. It reads
the compiler input straight from the pinned ATS build, which is why the match comes back exact.

---

## How it is put together

```
apps/web/        one Next.js app — employee at /, issuer at /issuer
contracts/
  ESOPVestingController.sol   grants, vesting, leaver clawback, disputes
  lending/                    pool, NAV oracle, testnet stablecoin
  payroll/                    accrue-then-withdraw salary
  automation/                 VestingScheduler (HIP-1215 — see the caveat below)
  interfaces/                 the slices of ATS and Chainlink we depend on
services/indexer/  mirror-node event ingestion into a cap table
tests/             lifecycle, controller, lending and payroll suites (165 tests, ~45s)
spikes/            Phase 0 experiments, kept because their answers are load-bearing
scripts/           setup, test harness, and one script per testnet flow
docs/TESTING.md    a manual pass over every flow, in order
deployments/       what is deployed where — read by the app and every script
vendor/            the ATS checkout (gitignored)
```

The employee and issuer sides are one app rather than two. They share a chain config, a
stylesheet and a contract surface, so running them separately bought nothing and cost a second
install, a second build and a second deployment — and two copies of the same ABI that had
already drifted apart in a way that silently broke the console. What stays separate is what
should: the employee signs with Privy and never holds gas, HR signs with their own wallet.

---

## Things that will bite you

**`HH700` / `HH701` about a missing or ambiguous artifact.** Hardhat's cache went stale after
an import was added and removed. Fix with:

```bash
cd vendor/ats/packages/ats/contracts && rm -f cache/solidity-files-cache.json && npx hardhat compile
```

Related: ATS already ships an `IAccessControl`, so importing OpenZeppelin's collides by artifact
name. `ESOPVestingController` implements its own two-role access control for that reason. (There
is no such collision for `ReentrancyGuard`, which is why all three contracts use OpenZeppelin's.)

**A transaction reverted with no reason.** Check the gas used against the gas offered on
HashScan. If it is above 99%, it ran out of gas — Hedera's estimator is not a reliable bound and
this failure looks identical to a revert. Hedera charges gas **used**, not gas **offered**
(measured: the same mint cost an identical 0.03710687 HBAR at a 120k limit and a 900k limit), so
a generous limit is free and a tight one is how you lose an afternoon.

**A grant shows up but cannot be claimed.** Funding a grant is several transactions, one batch
of tranche locks at a time, so it can stop half way. Finish it with `npm run testnet:fund-grant`.
If that reports the tranche dates are in the past, the grant is unrecoverable — ATS will not lock
tokens until a date that has already gone by — and it has to be reissued.

**Auto-vesting does nothing.** `VestingScheduler` wraps Hedera's HIP-1215 Schedule Service, and
`scheduleCall` currently returns `INVALID_CONTRACT_ID` on testnet for every target, from an EOA
and from contract code alike, while `hasScheduleCapacity` on the same system contract answers
true. This costs nothing, which was the design goal: release is permissionless and the lock's
expiry is the real source of truth, so `npm run testnet:vesting-keeper` delivers the same
outcome. Automation here is convenience, never correctness.

**Hashio rate-limits or drops revert data.** It also caps `eth_getLogs` to a 7-day window, which
is why anything scanning history reads the mirror node instead.

**Retiring a contract strands what it holds.** Redeploying does not move balances. Run
`npm run testnet:retire-stack` first — it delivers outstanding salary and withdraws pool
liquidity, and refuses to touch a pool with a live loan.

---

## Where the reasoning lives

[IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) is the long version: every design decision,
what was measured rather than assumed, and the things that turned out wrong. It is written to be
read by someone deciding whether to trust the design, so the failures are in it too.
