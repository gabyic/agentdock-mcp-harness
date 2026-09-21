#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_SOURCE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
SOURCE_DIR="${DEFAULT_SOURCE_DIR}"
INSTALL_DIR="${AGENTDOCK_INSTALL_DIR:-${HOME}/.local/share/agentdock-mcp-harness}"
BIN_DIR="${AGENTDOCK_BIN_DIR:-${HOME}/.local/bin}"
SKIP_TESTS=0
ALLOW_DOWNGRADE=0
FORCE=0

usage() {
  cat <<'EOF'
Usage: ./scripts/upgrade.sh [options]

Options:
  --source PATH        New AgentDock checkout or extracted release directory.
  --install-dir PATH   Managed installation directory.
  --bin-dir PATH       Launcher directory.
  --skip-tests         Skip the source test suite before upgrading.
  --allow-downgrade    Permit a target version older than the installed version.
  --force              Reinstall even when the target version is unchanged.
  -h, --help           Show this help.

Upgrade never downloads code. The source directory must already exist locally.
State and configuration are preserved.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      SOURCE_DIR="$2"
      shift 2
      ;;
    --install-dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --bin-dir)
      BIN_DIR="$2"
      shift 2
      ;;
    --skip-tests)
      SKIP_TESTS=1
      shift
      ;;
    --allow-downgrade)
      ALLOW_DOWNGRADE=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

SOURCE_DIR="$(cd -- "${SOURCE_DIR}" && pwd)"
INSTALL_DIR="$(node -e 'const path=require("node:path"); const os=require("node:os"); let v=process.argv[1]; if(v==="~") v=os.homedir(); else if(v.startsWith("~/")) v=path.join(os.homedir(),v.slice(2)); process.stdout.write(path.resolve(v));' "${INSTALL_DIR}")"
BIN_DIR="$(node -e 'const path=require("node:path"); const os=require("node:os"); let v=process.argv[1]; if(v==="~") v=os.homedir(); else if(v.startsWith("~/")) v=path.join(os.homedir(),v.slice(2)); process.stdout.write(path.resolve(v));' "${BIN_DIR}")"
MANIFEST="${INSTALL_DIR}/.agentdock-install.json"

if [[ ! -f "${SOURCE_DIR}/package.json" || ! -f "${SOURCE_DIR}/scripts/install.sh" ]]; then
  echo "Invalid AgentDock upgrade source: ${SOURCE_DIR}" >&2
  exit 1
fi

if [[ ! -f "${MANIFEST}" ]]; then
  echo "Managed AgentDock install manifest not found: ${MANIFEST}" >&2
  echo "Refusing to upgrade an unmanaged directory." >&2
  exit 1
fi

CURRENT_VERSION="$(node -e "const m=require(process.argv[1]); if(m.schema_version!==1) process.exit(2); process.stdout.write(String(m.version));" "${MANIFEST}")"
TARGET_VERSION="$(node -p "require('${SOURCE_DIR}/package.json').version")"

COMPARE="$(node "${SOURCE_DIR}/scripts/version-compare.mjs" "${TARGET_VERSION}" "${CURRENT_VERSION}")"
if [[ "${COMPARE}" == "0" && "${FORCE}" -ne 1 ]]; then
  echo "AgentDock is already at ${CURRENT_VERSION}; nothing to upgrade."
  exit 0
fi
if [[ "${COMPARE}" == "-1" && "${ALLOW_DOWNGRADE}" -ne 1 ]]; then
  echo "Refusing downgrade from ${CURRENT_VERSION} to ${TARGET_VERSION}." >&2
  echo "Use --allow-downgrade only when this is intentional." >&2
  exit 1
fi

MANIFEST_BIN_DIR="$(node -e "const m=require(process.argv[1]); process.stdout.write(String(m.bin_dir));" "${MANIFEST}")"
if [[ "${BIN_DIR}" == "${HOME}/.local/bin" && -n "${MANIFEST_BIN_DIR}" ]]; then
  BIN_DIR="${MANIFEST_BIN_DIR}"
fi

STATE_EXPLICIT="$(node -e "const m=require(process.argv[1]); process.stdout.write(m.state_dir_explicit?'1':'0');" "${MANIFEST}")"
STATE_DIR="$(node -e "const m=require(process.argv[1]); process.stdout.write(String(m.state_dir_at_install));" "${MANIFEST}")"

args=(
  --install-dir "${INSTALL_DIR}"
  --bin-dir "${BIN_DIR}"
)
if [[ "${SKIP_TESTS}" -eq 1 ]]; then
  args+=(--skip-tests)
fi
if [[ "${STATE_EXPLICIT}" -eq 1 ]]; then
  args+=(--state-dir "${STATE_DIR}")
fi

echo "Upgrading AgentDock ${CURRENT_VERSION} -> ${TARGET_VERSION}"
AGENTDOCK_INSTALL_MODE=upgrade "${SOURCE_DIR}/scripts/install.sh" "${args[@]}"

NEW_VERSION="$(node -e "const m=require(process.argv[1]); process.stdout.write(String(m.version));" "${MANIFEST}")"
if [[ "${NEW_VERSION}" != "${TARGET_VERSION}" ]]; then
  echo "Upgrade verification failed: expected ${TARGET_VERSION}, installed ${NEW_VERSION}." >&2
  exit 1
fi

echo "Upgrade complete: ${CURRENT_VERSION} -> ${NEW_VERSION}"
