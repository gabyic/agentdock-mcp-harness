#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
VERSION="$(node -p "require('${SOURCE_DIR}/package.json').version")"
ARTIFACT="${1:-${SOURCE_DIR}/dist/agentdock-mcp-harness-v${VERSION}.tar.gz}"
CHECKSUM="${ARTIFACT}.sha256"

for command in node npm tar sha256sum; do
  command -v "${command}" >/dev/null 2>&1 || {
    echo "${command} is required for release smoke." >&2
    exit 1
  }
done

[[ -f "${ARTIFACT}" ]] || {
  echo "Release artifact not found: ${ARTIFACT}" >&2
  exit 1
}
[[ -f "${CHECKSUM}" ]] || {
  echo "Release checksum not found: ${CHECKSUM}" >&2
  exit 1
}

ARTIFACT_DIR="$(cd -- "$(dirname -- "${ARTIFACT}")" && pwd)"
ARTIFACT_NAME="$(basename -- "${ARTIFACT}")"
CHECKSUM_NAME="$(basename -- "${CHECKSUM}")"
(
  cd "${ARTIFACT_DIR}"
  sha256sum -c "${CHECKSUM_NAME}"
)

tmp="$(mktemp -d)"
server_pid=""
cleanup() {
  if [[ -n "${server_pid}" ]]; then
    kill -TERM "${server_pid}" 2>/dev/null || true
    wait "${server_pid}" 2>/dev/null || true
  fi
  rm -rf -- "${tmp}"
}
trap cleanup EXIT

mkdir -p "${tmp}/extract" "${tmp}/home"
tar -xzf "${ARTIFACT}" -C "${tmp}/extract"
extracted="${tmp}/extract/agentdock-mcp-harness-${VERSION}"
[[ -d "${extracted}" ]] || {
  echo "Release top-level directory missing: ${extracted}" >&2
  exit 1
}
[[ ! -e "${extracted}/.git" ]] || {
  echo "Release artifact unexpectedly contains .git metadata." >&2
  exit 1
}

install_dir="${tmp}/home/.local/share/agentdock-mcp-harness"
bin_dir="${tmp}/home/.local/bin"
state_dir="${tmp}/home/.local/state/agentdock"

env -u AGENTDOCK_CONFIG -u AGENTDOCK_POLICY_JSON -u AGENTDOCK_TRANSPORT   HOME="${tmp}/home"   npm_config_registry=https://registry.npmjs.org   "${extracted}/scripts/install.sh"     --skip-tests     --install-dir "${install_dir}"     --bin-dir "${bin_dir}"     --state-dir "${state_dir}" >/dev/null

installed_version="$(
  env -u AGENTDOCK_CONFIG -u AGENTDOCK_POLICY_JSON -u AGENTDOCK_TRANSPORT     HOME="${tmp}/home"     "${bin_dir}/agentdock" version
)"
[[ "${installed_version}" == "${VERSION}" ]] || {
  echo "Installed version mismatch: expected ${VERSION}, got ${installed_version}" >&2
  exit 1
}

doctor_json="$(
  env -u AGENTDOCK_CONFIG -u AGENTDOCK_POLICY_JSON -u AGENTDOCK_TRANSPORT     HOME="${tmp}/home"     "${bin_dir}/agentdock" doctor --json
)"
DOCTOR_JSON="${doctor_json}" node -e '
  const r=JSON.parse(process.env.DOCTOR_JSON);
  if (r.overall_status === "FAIL") process.exit(1);
'

node "${install_dir}/scripts/verify-systemd-unit.mjs"   "${install_dir}/deploy/systemd/agentdock-http.service" >/dev/null

port="$(
  node - <<'NODE'
const net = require("node:net");
const server = net.createServer();
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(String(server.address().port));
  server.close();
});
NODE
)"

env -u AGENTDOCK_CONFIG -u AGENTDOCK_POLICY_JSON   HOME="${tmp}/home"   AGENTDOCK_TRANSPORT=http   AGENTDOCK_HTTP_HOST=127.0.0.1   AGENTDOCK_HTTP_PORT="${port}"   "${bin_dir}/agentdock-mcp"   >"${tmp}/http.out" 2>"${tmp}/http.err" &
server_pid=$!

env -u AGENTDOCK_CONFIG -u AGENTDOCK_POLICY_JSON   HOME="${tmp}/home"   "${bin_dir}/agentdock" health     --url "http://127.0.0.1:${port}/healthz"     --wait-ms 10000     --timeout-ms 500 >/dev/null

kill -TERM "${server_pid}"
wait "${server_pid}"
server_pid=""

grep -q 'SIGTERM' "${tmp}/http.err"

echo "RELEASE_SMOKE=PASS"
echo "VERSION=${VERSION}"
echo "ARTIFACT=${ARTIFACT_NAME}"
