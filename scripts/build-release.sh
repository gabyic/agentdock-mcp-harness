#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
OUTPUT_DIR="${1:-${SOURCE_DIR}/dist}"

command -v git >/dev/null 2>&1 || {
  echo "git is required to build a release artifact." >&2
  exit 1
}
command -v gzip >/dev/null 2>&1 || {
  echo "gzip is required to build a release artifact." >&2
  exit 1
}

if ! git -C "${SOURCE_DIR}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Release artifacts must be built from a Git checkout." >&2
  exit 1
fi
if [[ -n "$(git -C "${SOURCE_DIR}" status --porcelain=v1 --untracked-files=all)" ]]; then
  echo "Refusing release build from a dirty worktree." >&2
  exit 1
fi

VERSION="$(node -p "require('${SOURCE_DIR}/package.json').version")"
COMMIT="$(git -C "${SOURCE_DIR}" rev-parse HEAD)"
PREFIX="agentdock-mcp-harness-${VERSION}/"
BASENAME="agentdock-mcp-harness-v${VERSION}"
mkdir -p "${OUTPUT_DIR}"
OUTPUT_DIR="$(cd -- "${OUTPUT_DIR}" && pwd)"
TAR_PATH="${OUTPUT_DIR}/${BASENAME}.tar"
TGZ_PATH="${OUTPUT_DIR}/${BASENAME}.tar.gz"
SHA_PATH="${TGZ_PATH}.sha256"
rm -f -- "${TAR_PATH}" "${TGZ_PATH}" "${SHA_PATH}"

git -C "${SOURCE_DIR}" archive   --format=tar   --prefix="${PREFIX}"   "${COMMIT}" > "${TAR_PATH}"

gzip -n -9 -c "${TAR_PATH}" > "${TGZ_PATH}"
rm -f -- "${TAR_PATH}"

(
  cd "${OUTPUT_DIR}"
  sha256sum "${BASENAME}.tar.gz" > "${BASENAME}.tar.gz.sha256"
)

echo "VERSION=${VERSION}"
echo "COMMIT=${COMMIT}"
echo "ARTIFACT=${TGZ_PATH}"
echo "SHA256=${SHA_PATH}"
