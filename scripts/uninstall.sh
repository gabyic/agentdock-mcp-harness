#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="${AGENTDOCK_INSTALL_DIR:-${HOME}/.local/share/agentdock-mcp-harness}"
BIN_DIR="${AGENTDOCK_BIN_DIR:-${HOME}/.local/bin}"
REMOVE_STATE=0
REMOVE_CONFIG=0
STATE_DIR_OVERRIDE=""
CONFIG_PATH="${AGENTDOCK_CONFIG:-${HOME}/.config/agentdock/config.json}"
CONFIG_PATH_EXPLICIT=0
if [[ -n "${AGENTDOCK_CONFIG:-}" ]]; then
  CONFIG_PATH_EXPLICIT=1
fi

usage() {
  cat <<'EOF'
Usage: agentdock uninstall [options]

Options:
  --install-dir PATH   Managed installation directory.
  --bin-dir PATH       Launcher directory.
  --remove-state       Also permanently remove AgentDock durable state.
  --state-dir PATH     Explicit state directory for --remove-state.
  --remove-config      Also remove the selected AgentDock config file.
  --config PATH        Config file path used by --remove-config / state resolution.
  -h, --help           Show this help.

By default uninstall removes only AgentDock program files and managed launchers.
Durable Task state and configuration are preserved.
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
    --remove-state)
      REMOVE_STATE=1
      shift
      ;;
    --state-dir)
      STATE_DIR_OVERRIDE="$2"
      shift 2
      ;;
    --remove-config)
      REMOVE_CONFIG=1
      shift
      ;;
    --config)
      CONFIG_PATH="$2"
      CONFIG_PATH_EXPLICIT=1
      shift 2
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

abspath() {
  node -e 'const path=require("node:path"); const os=require("node:os"); let v=process.argv[1]; if(v==="~") v=os.homedir(); else if(v.startsWith("~/")) v=path.join(os.homedir(),v.slice(2)); process.stdout.write(path.resolve(v));' "$1"
}

INSTALL_DIR="$(abspath "${INSTALL_DIR}")"
BIN_DIR="$(abspath "${BIN_DIR}")"
CONFIG_PATH="$(abspath "${CONFIG_PATH}")"
MANIFEST="${INSTALL_DIR}/.agentdock-install.json"

if [[ ! -f "${MANIFEST}" ]]; then
  echo "Managed AgentDock install manifest not found: ${MANIFEST}" >&2
  echo "Refusing to uninstall an unmanaged directory." >&2
  exit 1
fi

MANIFEST_INSTALL_DIR="$(node -e "const m=require(process.argv[1]); if(m.schema_version!==1) process.exit(2); process.stdout.write(String(m.install_dir));" "${MANIFEST}")"
MANIFEST_BIN_DIR="$(node -e "const m=require(process.argv[1]); process.stdout.write(String(m.bin_dir));" "${MANIFEST}")"
MANIFEST_STATE_DIR="$(node -e "const m=require(process.argv[1]); process.stdout.write(String(m.state_dir_at_install));" "${MANIFEST}")"
MANIFEST_STATE_EXPLICIT="$(node -e "const m=require(process.argv[1]); process.stdout.write(m.state_dir_explicit?'1':'0');" "${MANIFEST}")"
if [[ "$(abspath "${MANIFEST_INSTALL_DIR}")" != "${INSTALL_DIR}" ]]; then
  echo "Install manifest path mismatch; refusing uninstall." >&2
  exit 1
fi
BIN_DIR="$(abspath "${MANIFEST_BIN_DIR}")"

STATE_DIR=""
if [[ "${REMOVE_STATE}" -eq 1 ]]; then
  if [[ -n "${STATE_DIR_OVERRIDE}" ]]; then
    STATE_DIR="$(abspath "${STATE_DIR_OVERRIDE}")"
  elif [[ "${MANIFEST_STATE_EXPLICIT}" -eq 1 ]]; then
    STATE_DIR="$(abspath "${MANIFEST_STATE_DIR}")"
  else
    set +e
    if [[ "${CONFIG_PATH_EXPLICIT}" -eq 1 ]]; then
      STATE_DIR="$(AGENTDOCK_CONFIG="${CONFIG_PATH}" node --input-type=module -e "import {loadAgentDockConfig} from 'file://${INSTALL_DIR}/src/config.js'; try { process.stdout.write(loadAgentDockConfig().config.state.dir); } catch { process.exit(1); }" 2>/dev/null)"
    else
      STATE_DIR="$(env -u AGENTDOCK_CONFIG node --input-type=module -e "import {loadAgentDockConfig} from 'file://${INSTALL_DIR}/src/config.js'; try { process.stdout.write(loadAgentDockConfig().config.state.dir); } catch { process.exit(1); }" 2>/dev/null)"
    fi
    rc=$?
    set -e
    if [[ "${rc}" -ne 0 || -z "${STATE_DIR}" ]]; then
      echo "Could not resolve effective state directory safely." >&2
      echo "Use --state-dir PATH with --remove-state." >&2
      exit 1
    fi
    STATE_DIR="$(abspath "${STATE_DIR}")"
  fi
fi

safe_tree() {
  local target="$1"
  case "${target}" in
    ""|"/"|"$(abspath "${HOME}")"|"$(abspath "${BIN_DIR}")"|"$(abspath "${INSTALL_DIR}")")
      return 1
      ;;
  esac
  [[ "${#target}" -ge 5 ]]
}

remove_managed_launcher() {
  local target="$1"
  if [[ ! -e "${target}" && ! -L "${target}" ]]; then
    return
  fi
  if [[ -f "${target}" ]] && grep -Fq "${INSTALL_DIR}/src/" "${target}" 2>/dev/null; then
    rm -f -- "${target}"
    return
  fi
  echo "Preserved launcher not recognized as AgentDock-managed: ${target}" >&2
}

if [[ "${REMOVE_STATE}" -eq 1 ]]; then
  if ! safe_tree "${STATE_DIR}"; then
    echo "Refusing unsafe state removal path: ${STATE_DIR}" >&2
    exit 1
  fi
fi

remove_managed_launcher "${BIN_DIR}/agentdock"
remove_managed_launcher "${BIN_DIR}/agentdock-mcp"

if [[ "${REMOVE_STATE}" -eq 1 && -e "${STATE_DIR}" ]]; then
  rm -rf -- "${STATE_DIR}"
  echo "Removed state: ${STATE_DIR}"
else
  echo "Preserved state."
fi

if [[ "${REMOVE_CONFIG}" -eq 1 && -e "${CONFIG_PATH}" ]]; then
  rm -f -- "${CONFIG_PATH}"
  rmdir --ignore-fail-on-non-empty -- "$(dirname -- "${CONFIG_PATH}")" 2>/dev/null || true
  echo "Removed config: ${CONFIG_PATH}"
else
  echo "Preserved config."
fi

rm -rf -- "${INSTALL_DIR}"
echo "Removed AgentDock installation: ${INSTALL_DIR}"
