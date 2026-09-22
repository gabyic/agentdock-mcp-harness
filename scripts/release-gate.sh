#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
TAG="${1:-}"
cd "${SOURCE_DIR}"

if [[ -n "$(git status --porcelain=v1 --untracked-files=all)" ]]; then
  echo "RELEASE_GATE_FAIL: worktree must be clean." >&2
  exit 1
fi

verify_args=()
if [[ -n "${TAG}" ]]; then
  verify_args+=(--tag "${TAG}")
fi

node scripts/verify-release.mjs "${verify_args[@]}"

npm ci
npm test -- --test-reporter=spec
npm run acceptance:v0.1
npm audit --omit=dev --audit-level=high
npm run service:verify

rm -rf dist
npm run release:build
version="$(node -p "require('./package.json').version")"
artifact="dist/agentdock-mcp-harness-v${version}.tar.gz"
checksum="${artifact}.sha256"

(
  cd dist
  sha256sum -c "$(basename -- "${checksum}")"
)

tmp="$(mktemp -d)"
cleanup() {
  rm -rf -- "${tmp}"
}
trap cleanup EXIT

./scripts/build-release.sh "${tmp}" >/dev/null
sha1="$(sha256sum "${artifact}" | awk '{print $1}')"
sha2="$(sha256sum "${tmp}/$(basename -- "${artifact}")" | awk '{print $1}')"
if [[ "${sha1}" != "${sha2}" ]]; then
  echo "RELEASE_GATE_FAIL: release artifact is not reproducible." >&2
  echo "first=${sha1}" >&2
  echo "second=${sha2}" >&2
  exit 1
fi

./scripts/smoke-release.sh "${artifact}"

pack_json="${tmp}/npm-pack.json"
npm pack --dry-run --json >"${pack_json}"
PACK_JSON="${pack_json}" node <<'NODE'
const fs = require("node:fs");
const result = JSON.parse(
  fs.readFileSync(process.env.PACK_JSON, "utf8"),
)[0];
if (!result || !Array.isArray(result.files)) process.exit(1);
const files = new Set(result.files.map((entry) => entry.path));
for (const required of [
  "src/cli.js",
  "src/index.js",
  "src/version.js",
  "scripts/install.sh",
  "scripts/upgrade.sh",
  "scripts/uninstall.sh",
  "deploy/systemd/agentdock-http.service",
]) {
  if (!files.has(required)) {
    console.error("RELEASE_GATE_FAIL: npm pack metadata missing " + required);
    process.exit(1);
  }
}
NODE

echo "RELEASE_GATE=PASS"
echo "VERSION=${version}"
echo "TAG=${TAG:-none}"
echo "ARTIFACT=${artifact}"
echo "SHA256=${sha1}"
