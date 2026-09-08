# Spikes

Throwaway experiments that answer one design question each, kept because the answers are
load-bearing for `IMPLEMENTATION_PLAN.md`.

## `esopCollateral.spike.test.ts` — Spike #1

**Question:** can an ATS hold be used as loan collateral when the lending pool is an address the
issuer has not KYC'd?

**Answer:** yes for pledge and repay; liquidation requires the pool to be KYC'd *and* allowlisted.
Full results and design consequences in §5.2 of the plan.

### How to run

It needs the ATS contracts and their Hardhat setup, so it runs from inside a checkout of ATS rather
than from this repo:

```bash
git clone --depth 1 https://github.com/hashgraph/asset-tokenization-studio.git
cd asset-tokenization-studio
npm install --workspace=packages/ats/contracts --include-workspace-root

mkdir -p packages/ats/contracts/test/contracts/integration/spike
cp /path/to/tokenize-it/spikes/esopCollateral.spike.test.ts \
   packages/ats/contracts/test/contracts/integration/spike/

cd packages/ats/contracts
npx hardhat test test/contracts/integration/spike/esopCollateral.spike.test.ts
```

Expect 10 passing, ~1 minute. No testnet, keys or faucet needed — the question is Solidity
behaviour, so a local EVM answers it. Reach for testnet only for genuinely Hedera-specific
questions (gas ceilings, the Schedule Service, mirror node behaviour).

Once we vendor ATS as a submodule, this moves into our own test suite and stops being a spike.
