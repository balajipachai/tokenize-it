#!/usr/bin/env bash
#
# Runs one of our Hardhat scripts inside the vendored ATS project, against a
# named network. Same reason as ats-test.sh: our code needs ATS's path aliases
# and helpers, which only resolve there.
#
#   ./scripts/ats-run.sh testnet-lifecycle.ts hedera-testnet
#
# Loads .env from THIS repo and exports it, so ATS's Configuration picks up the
# operator key and endpoints without us editing anything inside vendor/.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="$ROOT/vendor/ats/packages/ats/contracts"
DEST="$CONTRACTS/scripts/tokenize-it"

SCRIPT="${1:-}"
NETWORK="${2:-hedera-testnet}"

if [ -z "$SCRIPT" ]; then
  echo "usage: $0 <script.ts> [network]" >&2
  exit 1
fi
if [ ! -d "$CONTRACTS" ]; then
  echo "vendor/ats not found. Run: npm run setup:ats" >&2
  exit 1
fi
if [ ! -f "$ROOT/.env" ]; then
  echo "No .env found. Copy .env.example to .env and fill in your testnet key." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. "$ROOT/.env"
# vendor/ats may be a symlink, so scripts cannot derive the repo root from __dirname.
TOKENIZE_IT_ROOT="$ROOT"
set +a

if [ -z "${HEDERA_TESTNET_PRIVATE_KEY_0:-}" ] || [ "${HEDERA_TESTNET_PRIVATE_KEY_0}" = "0x..." ]; then
  echo "HEDERA_TESTNET_PRIVATE_KEY_0 is not set in .env." >&2
  exit 1
fi

SOL_DEST="$CONTRACTS/contracts/tokenize-it"
rm -rf "$SOL_DEST"
mkdir -p "$SOL_DEST"
cp -R "$ROOT"/contracts/. "$SOL_DEST"/

mkdir -p "$DEST"
cp "$ROOT/scripts/$SCRIPT" "$DEST/"

# Triple every gas estimate on the Hedera networks.
#
# Hedera's eth_estimateGas UNDER-counts: 11% low on a bare ERC-20 mint, and roughly half on
# anything looping into the ATS diamond. Sent raw, an estimate runs out of gas -- and the
# failure is nasty to read, because an out-of-gas revert carries no reason. `revokeKyc` died
# exactly this way while re-seeding demo data: 97,641 gas burned of a 98,458 limit, 99.2%
# consumed, empty revert data, while the same call succeeded under `staticCall`.
#
# The headroom is free. Hedera charges on gas USED, not the limit offered -- measured
# directly, the same call offered 120,000 and 900,000 cost an identical 0.03710687 HBAR.
#
# Done here rather than in vendor/ats because that tree is gitignored and rebuilt by
# `npm run setup:ats`, so an edit there would silently vanish.
#
# MEASURED CAVEAT: this alone did NOT fix the revokeKyc failure -- the limit was byte-identical
# (98,458) with and without it, so hardhat-ethers is not applying the multiplier to these
# calls. It is kept because it is correct for anything that IS auto-estimated, but scripts
# must not rely on it: pass an explicit gasLimit on ATS writes. See GAS in testnet-grant.ts.
if ! grep -q "gasMultiplier" "$CONTRACTS/hardhat.config.ts"; then
  perl -0pi -e 's/(\"hedera-(?:testnet|mainnet|hashsphere)\":\s*\{)/$1\n      gasMultiplier: 3,/g' \
    "$CONTRACTS/hardhat.config.ts"
fi

cd "$CONTRACTS"
npx hardhat run "scripts/tokenize-it/$SCRIPT" --network "$NETWORK"
