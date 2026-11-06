#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${HOME}/.antigravity-patch"
PLIST_NAME="local.fei.antigravity-theme.plist"
PLIST_DEST="${HOME}/Library/LaunchAgents/${PLIST_NAME}"
NODE_BIN="${HOME}/.local/bin/node"
if [[ ! -x "${NODE_BIN}" ]]; then
  NODE_BIN="$(command -v node)"
fi

echo "==> Syncing modular files from ${REPO_DIR} to ${TARGET_DIR} ..."
mkdir -p \
  "${TARGET_DIR}/src" \
  "${TARGET_DIR}/ui" \
  "${TARGET_DIR}/remote" \
  "${TARGET_DIR}/assets/fonts" \
  "${TARGET_DIR}/user" \
  "${TARGET_DIR}/logs" \
  "${TARGET_DIR}/backups" \
  "${TARGET_DIR}/cache"

cp "${REPO_DIR}/src/"*.mjs "${TARGET_DIR}/src/"
cp "${REPO_DIR}/ui/"{inject.js,theme.css,zh-CN.json} "${TARGET_DIR}/ui/"
cp "${REPO_DIR}/remote/remote-ctl.py" "${TARGET_DIR}/remote/"
cp "${REPO_DIR}/assets/fonts/"*.woff2 "${TARGET_DIR}/assets/fonts/"

if [[ ! -f "${TARGET_DIR}/config.json" ]]; then
  cp "${REPO_DIR}/config/config.json" "${TARGET_DIR}/config.json"
fi
for ufile in "${REPO_DIR}/config/user/"*; do
  fname="$(basename "${ufile}")"
  if [[ ! -f "${TARGET_DIR}/user/${fname}" ]]; then
    cp "${ufile}" "${TARGET_DIR}/user/${fname}"
  fi
done

# Remove legacy flat files from TARGET_DIR and create compatibility entry shims
rm -f "${TARGET_DIR}"/{bundle.mjs,cdp.mjs,inject.js,remote-ctl.py,ssh-remote.mjs,theme.css,zh-CN.json}
for entry in daemon.mjs patchctl.mjs verify.mjs; do
  printf '#!/usr/bin/env node\nimport "./src/%s";\n' "${entry}" > "${TARGET_DIR}/${entry}"
  chmod 755 "${TARGET_DIR}/${entry}" "${TARGET_DIR}/src/${entry}"
done
chmod 755 "${TARGET_DIR}/remote/remote-ctl.py"

if [[ -f "${REPO_DIR}/config/launchd/${PLIST_NAME}" ]]; then
  mkdir -p "${HOME}/Library/LaunchAgents"
  sed \
    -e "s|__HOME__|${HOME}|g" \
    -e "s|__NODE_BIN__|${NODE_BIN}|g" \
    "${REPO_DIR}/config/launchd/${PLIST_NAME}" > "${PLIST_DEST}"
fi

SERVICE_ID="gui/$(id -u)/local.fei.antigravity-theme"
if launchctl print "${SERVICE_ID}" >/dev/null 2>&1; then
  echo "==> Restarting LaunchAgent ${SERVICE_ID} ..."
  launchctl kickstart -k "${SERVICE_ID}"
else
  echo "==> Bootstrapping LaunchAgent ${SERVICE_ID} ..."
  launchctl bootstrap "gui/$(id -u)" "${PLIST_DEST}"
fi

sleep 3
echo "==> Running end-to-end verification (src/verify.mjs) ..."
"${NODE_BIN}" "${TARGET_DIR}/src/verify.mjs"
