# Spikes

Throwaway experiments that answer one design question each, kept because the answers are
load-bearing for `IMPLEMENTATION_PLAN.md`.

## `esopCollateral.spike.test.ts` — Spike #1

**Question:** can an ATS hold be used as loan collateral when the lending pool is an address the
issuer has not KYC'd?

**Answer:** yes for pledge and repay; liquidation requires the pool to be KYC'd *and* allowlisted.
Also found that held tokens are immune to controller clawback, so hold expiry must be bounded.
Full results and design consequences in §5.2 of the plan. 10/10 passing.

## `privyProtectedHold.spike.test.ts` — Spike #2

**Question:** can an employee authorise a collateral pledge with an off-chain EIP-712 signature
alone, while a relayer pays all gas — i.e. does the Privy embedded-wallet model work?

**Answer:** yes. ATS hand-writes its EIP-712 type strings as `keccak256` literals, and they are
byte-identical to what a standard encoder produces, so any spec-compliant wallet works. The
employee wallet held 0 wei throughout. Watch the domain `version` trap (it is the ATS config
version, not `"1"`). Full results in §6.3. 9/9 passing.

The employee is modelled as a detached `ethers.Wallet.createRandom()` that never sends a
transaction — the same position as a Privy embedded wallet on an unactivated Hedera account.

### How to run

It needs the ATS contracts and their Hardhat setup, so it runs from inside a checkout of ATS rather
than from this repo:

```bash
git clone --depth 1 https://github.com/hashgraph/asset-tokenization-studio.git
cd asset-tokenization-studio
npm install --workspace=packages/ats/contracts --include-workspace-root

mkdir -p packages/ats/contracts/test/contracts/integration/spike
cp /path/to/tokenize-it/spikes/*.spike.test.ts \
   packages/ats/contracts/test/contracts/integration/spike/

cd packages/ats/contracts
npx hardhat test test/contracts/integration/spike/*.spike.test.ts
```

Expect 19 passing, ~2 minutes. No testnet, keys or faucet needed — these are Solidity questions, so
a local EVM answers them. Reach for testnet only for genuinely Hedera-specific questions (gas
ceilings, the Schedule Service, mirror node behaviour).

Once we vendor ATS as a submodule, this moves into our own test suite and stops being a spike.
