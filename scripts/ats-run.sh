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

cd "$CONTRACTS"
npx hardhat run "scripts/tokenize-it/$SCRIPT" --network "$NETWORK"
