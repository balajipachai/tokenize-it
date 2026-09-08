#!/usr/bin/env bash
#
# Runs our Hardhat suites inside the vendored ATS project.
#
# Our tests need ATS's path aliases (@test, @scripts, @contract-types) and its
# deployment fixtures, which only resolve inside its own Hardhat project. So we
# sync our files in and run there. Source of truth stays in this repo.
#
#   ./scripts/ats-test.sh              # everything
#   ./scripts/ats-test.sh lifecycle    # only files matching "lifecycle"

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="$ROOT/vendor/ats/packages/ats/contracts"
DEST="$CONTRACTS/test/contracts/integration/tokenize-it"

if [ ! -d "$CONTRACTS" ]; then
  echo "vendor/ats not found. Run: npm run setup:ats" >&2
  exit 1
fi

FILTER="${1:-}"

# Our Solidity has to sit inside ATS's contracts tree to compile against its
# remappings and OpenZeppelin install.
SOL_DEST="$CONTRACTS/contracts/tokenize-it"
rm -rf "$SOL_DEST"
mkdir -p "$SOL_DEST"
cp -R "$ROOT"/contracts/. "$SOL_DEST"/

rm -rf "$DEST"
mkdir -p "$DEST"
for f in "$ROOT"/tests/*.test.ts "$ROOT"/spikes/*.test.ts; do
  [ -e "$f" ] || continue
  cp "$f" "$DEST/"
done

cd "$CONTRACTS"

# Portable across bash 3.2 (macOS default) -- no mapfile/readarray.
FILES=()
while IFS= read -r line; do
  FILES+=("$line")
done < <(find "$DEST" -name "*${FILTER}*.test.ts" | sort)

if [ ${#FILES[@]} -eq 0 ]; then
  echo "No test files matched filter '${FILTER}'." >&2
  exit 1
fi

npx hardhat test "${FILES[@]}"
