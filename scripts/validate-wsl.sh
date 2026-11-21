#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 12)) { console.error("Node.js 22.12+ is required."); process.exit(1); }'
uv lock --check
uv run ruff check apps/api tests
uv run ruff format --check apps/api tests
uv run mypy apps/api/app
for run in 1 2 3; do
  printf '=== Backend test run %s of 3 ===\n' "$run"
  uv run pytest
done

cd "$repo_root/apps/desktop"
npm audit --omit=dev
npm audit --audit-level=high
for run in 1 2; do
  printf '=== Desktop test run %s of 2 ===\n' "$run"
  npm run test
done
npm run typecheck
npm run typecheck:electron
npm run build
