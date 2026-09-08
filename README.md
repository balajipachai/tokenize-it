# tokenize-it

Tokenized ESOPs with real lifecycle management, on Hedera via the
[Asset Tokenization Studio](https://github.com/hashgraph/asset-tokenization-studio).

Employee stock options are the most widely held private-market asset on earth and the worst served.
A grant is a PDF, vesting is a spreadsheet, and nobody can borrow against equity they have already
earned. This project runs the whole lifecycle on-chain — issuance, KYC gating, vesting, freezing,
leaver clawback — and then lets an employee borrow against their **vested** ESOPs without selling
them and without leaving the compliance perimeter.

See [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) for the architecture, the design decisions
and their rationale, and the phased delivery plan.

## Status

| Phase | | |
|---|---|---|
| 0 | De-risking spikes | ✅ 4/4 green |
| 1 | Token + lifecycle skeleton | ✅ 18/18 local + full lifecycle live on Hedera testnet |
| 2 | `ESOPVestingController` | next |
| 3 | Employee portal + Privy | |
| 4 | Lending | |
| 5 | Issuer console | |
| 6 | Automation + polish | |

## Getting started

ATS is not vendored in git — it is large, and we only need it as a build/test host. Fetch it once
(pinned to a known-good commit) and install its contracts workspace:

```bash
npm run setup:ats     # clones into vendor/ (gitignored) + npm install; takes a few minutes
```

Then run the suites:

```bash
npm run test:ats        # everything
npm run test:lifecycle  # the Phase 1 ESOP lifecycle
npm run test:spikes     # the Phase 0 de-risking spikes
```

Our tests need ATS's Hardhat path aliases and deployment fixtures, so `scripts/ats-test.sh` syncs
them into the vendored project and runs Hardhat there. Source of truth stays in this repo.

To drive the same lifecycle against real Hedera testnet, copy `.env.example` to `.env`, add your
operator key, and:

```bash
npm run testnet:lifecycle
```

It deploys an ESOP token through the pre-deployed ATS factory, grants a vesting schedule to a
freshly generated wallet that is never funded, releases the cliff, relays a signature-authorised
transfer, and claws back the unvested remainder. Takes about two minutes, most of it waiting for
the cliff.

Nothing here needs a testnet account, keys, or a faucet — these are Solidity questions, and a local
EVM answers the whole suite in about 15 seconds. Reach for testnet only for genuinely
Hedera-specific behaviour (gas ceilings, the Schedule Service, the mirror node).

> Keep `useLoadFixture` at its default (`true`) in `deployEquityTokenFixture`. Passing `false`
> redeploys the entire ATS infrastructure on every `beforeEach` and takes the suite from 13 seconds
> to 36 minutes.

## Layout

```
tests/     ESOP lifecycle suite — the executable spec for ESOPVestingController
spikes/    Phase 0 experiments, kept because their answers are load-bearing
scripts/   setup + test harness
vendor/    ATS checkout (gitignored)
```
