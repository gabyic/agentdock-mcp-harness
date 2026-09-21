#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_NAME="agentdock-mcp-harness"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

INSTALL_DIR="${AGENTDOCK_INSTALL_DIR:-${HOME}/.local/share/agentdock-mcp-harness}"
BIN_DIR="${AGENTDOCK_BIN_DIR:-${HOME}/.local/bin}"
DEFAULT_STATE_DIR="${HOME}/.local/state/agentdock"
STATE_DIR="${AGENTDOCK_STATE_DIR:-${DEFAULT_STATE_DIR}}"
STATE_DIR_EXPLICIT=0
if [[ -n "${AGENTDOCK_STATE_DIR:-}" ]]; then
  STATE_DIR_EXPLICIT=1
fi
SKIP_TESTS=0
INSTALL_MODE="${AGENTDOCK_INSTALL_MODE:-install}"

usage() {
  cat <<'EOF'
Usage: ./scripts/install.sh [options]

Options:
  --install-dir PATH   Installation directory.
  --bin-dir PATH       Launcher directory.
  --state-dir PATH     Default AgentDock state directory.
  --skip-tests         Do not run npm test before installing.
  -h, --help           Show this help.

This installs AgentDock Core for the current user. It does not configure
public ingress, TLS, OAuth, DNS, sudo, or a system service.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --bin-dir)
      BIN_DIR="$2"
      shift 2
      ;;
    --state-dir)
      STATE_DIR="$2"
      STATE_DIR_EXPLICIT=1
      shift 2
      ;;
    --skip-tests)
      SKIP_TESTS=1
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

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require node
require npm

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ "${NODE_MAJOR}" -lt 24 ]]; then
  echo "AgentDock requires Node.js 24 or newer; found $(node --version)." >&2
  exit 1
fi

for required_path in package.json package-lock.json src/index.js src/cli.js scripts/upgrade.sh scripts/uninstall.sh scripts/version-compare.mjs; do
  if [[ ! -e "${SOURCE_DIR}/${required_path}" ]]; then
    echo "AgentDock source/release is missing: ${required_path}" >&2
    exit 1
  fi
done

abspath() {
  node -e 'const path=require("node:path"); const os=require("node:os"); let v=process.argv[1]; if(v==="~") v=os.homedir(); else if(v.startsWith("~/")) v=path.join(os.homedir(),v.slice(2)); process.stdout.write(path.resolve(v));' "$1"
}

INSTALL_DIR="$(abspath "${INSTALL_DIR}")"
BIN_DIR="$(abspath "${BIN_DIR}")"
STATE_DIR="$(abspath "${STATE_DIR}")"
PACKAGE_VERSION="$(node -p "require('${SOURCE_DIR}/package.json').version")"
PACKAGE_NAME="$(node -p "require('${SOURCE_DIR}/package.json').name")"

echo "Mode:        ${INSTALL_MODE}"
echo "Version:     ${PACKAGE_VERSION}"
echo "Source:      ${SOURCE_DIR}"
echo "Install dir: ${INSTALL_DIR}"
echo "Bin dir:     ${BIN_DIR}"
echo "State dir:   ${STATE_DIR}"

cd "${SOURCE_DIR}"
npm ci

if [[ "${SKIP_TESTS}" -eq 0 ]]; then
  npm test
fi

parent="$(dirname -- "${INSTALL_DIR}")"
mkdir -p "${parent}" "${BIN_DIR}" "${STATE_DIR}"
chmod 700 "${STATE_DIR}"

staging="${INSTALL_DIR}.new.$$"
backup="${INSTALL_DIR}.old.$$"
rm -rf "${staging}" "${backup}"
mkdir -p "${staging}"

SWAPPED=0
rollback_install() {
  if [[ "${SWAPPED}" -eq 1 ]]; then
    rm -rf -- "${INSTALL_DIR}" 2>/dev/null || true
    if [[ -e "${backup}" ]]; then
      mv "${backup}" "${INSTALL_DIR}" 2>/dev/null || true
    fi
  fi
  rm -rf -- "${staging}" 2>/dev/null || true
  if [[ -n "${mcp_launcher_tmp:-}" ]]; then
    rm -f -- "${mcp_launcher_tmp}" 2>/dev/null || true
  fi
  if [[ -n "${cli_launcher_tmp:-}" ]]; then
    rm -f -- "${cli_launcher_tmp}" 2>/dev/null || true
  fi
}
trap rollback_install ERR

cp -R "${SOURCE_DIR}/src" "${staging}/src"
mkdir -p "${staging}/scripts"
cp "${SOURCE_DIR}/scripts/upgrade.sh" "${staging}/scripts/upgrade.sh"
cp "${SOURCE_DIR}/scripts/uninstall.sh" "${staging}/scripts/uninstall.sh"
cp "${SOURCE_DIR}/scripts/version-compare.mjs" "${staging}/scripts/version-compare.mjs"
cp "${SOURCE_DIR}/package.json" "${SOURCE_DIR}/package-lock.json" "${staging}/"
if [[ -f "${SOURCE_DIR}/config.example.json" ]]; then
  cp "${SOURCE_DIR}/config.example.json" "${staging}/"
fi
chmod 755 "${staging}/scripts/upgrade.sh" "${staging}/scripts/uninstall.sh" "${staging}/scripts/version-compare.mjs"

(
  cd "${staging}"
  npm ci --omit=dev
)

MANIFEST_PATH="${staging}/.agentdock-install.json"
MANIFEST_VERSION="${PACKAGE_VERSION}" MANIFEST_PACKAGE_NAME="${PACKAGE_NAME}" MANIFEST_INSTALL_DIR="${INSTALL_DIR}" MANIFEST_BIN_DIR="${BIN_DIR}" MANIFEST_STATE_DIR="${STATE_DIR}" MANIFEST_STATE_EXPLICIT="${STATE_DIR_EXPLICIT}" MANIFEST_INSTALL_MODE="${INSTALL_MODE}" node <<'NODE' > "${MANIFEST_PATH}"
const manifest = {
  schema_version: 1,
  package_name: process.env.MANIFEST_PACKAGE_NAME,
  version: process.env.MANIFEST_VERSION,
  install_dir: process.env.MANIFEST_INSTALL_DIR,
  bin_dir: process.env.MANIFEST_BIN_DIR,
  state_dir_at_install: process.env.MANIFEST_STATE_DIR,
  state_dir_explicit: process.env.MANIFEST_STATE_EXPLICIT === "1",
  install_mode: process.env.MANIFEST_INSTALL_MODE,
  installed_at: new Date().toISOString(),
};
process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
NODE
chmod 600 "${MANIFEST_PATH}"

if [[ -e "${INSTALL_DIR}" ]]; then
  mv "${INSTALL_DIR}" "${backup}"
fi
mv "${staging}" "${INSTALL_DIR}"
SWAPPED=1

write_launcher() {
  local target="$1"
  local entrypoint="$2"

  {
    echo '#!/usr/bin/env bash'
    echo 'set -Eeuo pipefail'
    if [[ "${STATE_DIR_EXPLICIT}" -eq 1 ]]; then
      printf 'export AGENTDOCK_STATE_DIR="${AGENTDOCK_STATE_DIR:-%s}"\n' "${STATE_DIR}"
    fi
    printf 'exec node "%s/%s" "$@"\n' "${INSTALL_DIR}" "${entrypoint}"
  } > "${target}"
  chmod 755 "${target}"
}

mcp_launcher="${BIN_DIR}/agentdock-mcp"
cli_launcher="${BIN_DIR}/agentdock"
mcp_launcher_tmp="${mcp_launcher}.new.$$"
cli_launcher_tmp="${cli_launcher}.new.$$"
write_launcher "${mcp_launcher_tmp}" "src/index.js"
write_launcher "${cli_launcher_tmp}" "src/cli.js"
mv "${mcp_launcher_tmp}" "${mcp_launcher}"
mv "${cli_launcher_tmp}" "${cli_launcher}"

rm -rf -- "${backup}"
SWAPPED=0
trap - ERR

echo
if [[ "${INSTALL_MODE}" == "upgrade" ]]; then
  echo "Upgraded ${PROJECT_NAME} to ${PACKAGE_VERSION}."
else
  echo "Installed ${PROJECT_NAME} ${PACKAGE_VERSION}."
fi
echo "MCP launcher: ${mcp_launcher}"
echo "CLI launcher: ${cli_launcher}"
echo "State:        ${STATE_DIR}"

case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *)
    echo
    echo "Add this directory to PATH:"
    echo "  export PATH=\"${BIN_DIR}:\$PATH\""
    ;;
esac

echo
echo "Smoke tests:"
echo "  ${mcp_launcher}"
echo "  ${cli_launcher} doctor"
echo
echo "For MCP client and remote deployment examples, see docs/deployment.md."
