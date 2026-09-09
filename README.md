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
| 2 | `ESOPVestingController` | ✅ 30/30 passing, security-reviewed |
| 3 | Employee portal + Privy | ✅ verified end-to-end in a browser |
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
the cliff. What it deploys is recorded in `deployments/hedera-testnet.json`.

### Verifying deployed contracts

Hedera reads verification status from [Sourcify](https://sourcify.dev), which HashScan and the
mirror-node explorers then surface. Publish sources for whatever the last run deployed:

```bash
npm run verify                    # uses deployments/hedera-testnet.json
node scripts/verify.mjs 0xabc...  # or a specific address
node scripts/verify.mjs 0xabc... --contract contracts/foo/Bar.sol:Bar --chain 295
```

The script checks first and exits early if the contract is already verified, so it is safe to
re-run. It reads the compiler input straight from the pinned ATS build, which is why the match is
exact — we compile the same source the factory deployed.

Note what is being verified: the ESOP token is a `ResolverProxy` (an EIP-2535 diamond) created by
the ATS factory, so verifying it publishes the *proxy's* source. The facets holding the actual logic
are separate contracts deployed by the ATS team and are verified independently.

Currently verified, both `exact_match`:

| Contract | Address |
|---|---|
| ESOP token (ResolverProxy) | [`0x17E651…cE58`](https://hashscan.io/testnet/contract/0x17E651D659704A47932ff7Ffd6032860E468cE58) |
| ESOPVestingController | [`0xe630d8…3AE3`](https://hashscan.io/testnet/contract/0xe630d8fa035A99FB1e2ac51Df790059674313AE3) |

## Employee portal

```bash
npm run testnet:deploy-controller   # once: deploy the controller + seed a demo grant
cp apps/employee-portal/.env.example apps/employee-portal/.env.local   # add your Privy app
npm run portal:dev                  # http://localhost:3000
EMPLOYEE=0x... npm run testnet:grant  # grant options to the wallet the portal shows you
```

Sign in with an email; Privy creates an embedded wallet on first login. The portal shows granted
vs vested vs still-vesting, a vesting timeline, and a Claim button. The employee never installs a
wallet, never sees a seed phrase, and never holds HBAR — a backend relayer pays every network fee,
and reads come straight from the chain.

Nothing here needs a testnet account, keys, or a faucet — these are Solidity questions, and a local
EVM answers the whole suite in about 15 seconds. Reach for testnet only for genuinely
Hedera-specific behaviour (gas ceilings, the Schedule Service, the mirror node).

> Keep `useLoadFixture` at its default (`true`) in `deployEquityTokenFixture`. Passing `false`
> redeploys the entire ATS infrastructure on every `beforeEach` and takes the suite from 13 seconds
> to 36 minutes.

> Hitting `HH700`/`HH701` about a missing or ambiguous artifact usually means Hardhat's cache is
> stale after an import was added and then removed. Fix with:
> `cd vendor/ats/packages/ats/contracts && rm -f cache/solidity-files-cache.json && npx hardhat compile`.
> Note that ATS already ships an `IAccessControl`, so importing OpenZeppelin's collides by artifact
> name — `ESOPVestingController` deliberately implements its own two-role access control instead.

## Layout

```
apps/      employee-portal — Next.js + Privy, the employee-facing app
contracts/ ESOPVestingController — grants, vesting, leaver clawback
tests/     lifecycle + controller suites (67 tests, ~20s)
spikes/    Phase 0 experiments, kept because their answers are load-bearing
scripts/   setup + test harness
vendor/    ATS checkout (gitignored)
```
