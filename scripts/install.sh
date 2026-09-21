#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_NAME="agentdock-mcp-harness"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

INSTALL_DIR="${AGENTDOCK_INSTALL_DIR:-${HOME}/.local/share/agentdock-mcp-harness}"
BIN_DIR="${AGENTDOCK_BIN_DIR:-${HOME}/.local/bin}"
STATE_DIR="${AGENTDOCK_STATE_DIR:-${HOME}/.local/state/agentdock}"
SKIP_TESTS=0

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
require git

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ "${NODE_MAJOR}" -lt 24 ]]; then
  echo "AgentDock requires Node.js 24 or newer; found $(node --version)." >&2
  exit 1
fi

if ! git -C "${SOURCE_DIR}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Run this installer from a Git checkout of AgentDock MCP Harness." >&2
  exit 1
fi

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

cp -R "${SOURCE_DIR}/src" "${staging}/src"
cp "${SOURCE_DIR}/package.json" "${SOURCE_DIR}/package-lock.json" "${staging}/"

(
  cd "${staging}"
  npm ci --omit=dev
)

if [[ -e "${INSTALL_DIR}" ]]; then
  mv "${INSTALL_DIR}" "${backup}"
fi
mv "${staging}" "${INSTALL_DIR}"
rm -rf "${backup}"

launcher="${BIN_DIR}/agentdock-mcp"
cat > "${launcher}" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
export AGENTDOCK_STATE_DIR="\${AGENTDOCK_STATE_DIR:-${STATE_DIR}}"
exec node "${INSTALL_DIR}/src/index.js" "\$@"
EOF
chmod 755 "${launcher}"

echo
echo "Installed ${PROJECT_NAME}."
echo "Launcher: ${launcher}"
echo "State:    ${STATE_DIR}"

case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *)
    echo
    echo "Add this directory to PATH:"
    echo "  export PATH=\"${BIN_DIR}:\$PATH\""
    ;;
esac

echo
echo "Smoke test:"
echo "  ${launcher}"
echo
echo "For MCP client and remote deployment examples, see docs/deployment.md."
