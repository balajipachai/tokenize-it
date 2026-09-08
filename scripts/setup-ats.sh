#!/usr/bin/env bash
#
# Clones Asset Tokenization Studio into vendor/ats and installs the contracts
# workspace. ATS is not committed here -- it is large, and we only need it as a
# build/test host. vendor/ is gitignored.
#
# Pinned to a known-good commit so a green test run stays green.

set -euo pipefail

ATS_REPO="https://github.com/hashgraph/asset-tokenization-studio.git"
ATS_COMMIT="be4f860e408ec5b1a24d12feb6f872aabff69319" # 2026-06-24
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vendor/ats"

# A dangling symlink (e.g. left by a previous scratch checkout) would break the clone.
if [ -L "$VENDOR" ] && [ ! -e "$VENDOR" ]; then
  echo "Removing dangling vendor/ats symlink."
  rm -f "$VENDOR"
fi

if [ -d "$VENDOR/.git" ]; then
  echo "vendor/ats already present; skipping clone."
else
  echo "Cloning ATS into vendor/ats ..."
  mkdir -p "$ROOT/vendor"
  git clone --filter=blob:none "$ATS_REPO" "$VENDOR"
fi

cd "$VENDOR"
git fetch --depth 1 origin "$ATS_COMMIT" 2>/dev/null || true
git checkout --quiet "$ATS_COMMIT"
echo "ATS pinned at $ATS_COMMIT"

if [ ! -d "$VENDOR/node_modules" ]; then
  echo "Installing ATS contracts workspace (this takes a few minutes) ..."
  npm install --workspace=packages/ats/contracts --include-workspace-root
fi

echo "Done. Run 'npm run test:ats' to execute our suites against ATS."
