import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {targets, connect, patchDir} from './cdp.mjs';
import {readConfig, saveConfig, build, readFallbackContextLimit} from './bundle.mjs';
import {
  DEFAULT_CONTEXT_LIMIT_TOKENS,
  parseSingleMetricRow,
  computeMetricsFromRows,
} from './metrics.mjs';
import {normalizeSshMode} from './routes.mjs';
import {
  ensureRemoteTunnel,
  pollTunnelHealth,
  getSshState,
  setOnSshStateChange,
  syncSidecarAuthorities,
  fetchRemoteConversationRaw,
  isRemotePort,
  isRemoteCascade,
  setEnvFilter,
  pushMergedProjectListToBrowsers,
  discoverLocalMacLsPort,
  stopAllTunnels,
  setSshLogger,
} from './ssh-remote.mjs';

const PATCH_VERSION = '20261118-ssh-v14';
const sessions = new Map();
const logFile = path.join(patchDir, 'logs/patch.log');
const CONVERSATIONS_DIR = path.join(os.homedir(), '.gemini/antigravity/conversations');
const CLI_CONVERSATIONS_DIR = path.join(os.homedir(), '.gemini/antigravity-cli/conversations');
const localMetricsCache = new Map();  // cascadeId -> { sig, fallbackLimit, payload, parsedMap }
const remoteMetricsCache = new Map(); // cascadeId -> { sig, fallbackLimit, payload, parsedMap }

let stopping = false;
let busy = false;
let lastError = '';
let tunnelInitialized = false;
let fallbackContextLimit = DEFAULT_CONTEXT_LIMIT_TOKENS;

async function log(message) {
  try {
    if ((await fs.stat(logFile).catch(() => ({size: 0}))).size > 1024 * 1024)
      await fs.rename(logFile, `${logFile}.1`);
    await fs.appendFile(logFile, `${new Date().toISOString()} ${message}\n`, {mode: 0o600});
  } catch {}
}

function resolveLocalDbPath(cascadeId) {
  const p1 = path.join(CONVERSATIONS_DIR, `${cascadeId}.db`);
  if (fsSync.existsSync(p1)) {
    try { return fsSync.realpathSync(p1); } catch { return p1; }
  }
  const p2 = path.join(CLI_CONVERSATIONS_DIR, `${cascadeId}.db`);
  if (fsSync.existsSync(p2)) return p2;
  return '';
}

function getDbSignature(cascadeId) {
  try {
    const dbPath = resolveLocalDbPath(cascadeId);
    if (!dbPath) return null;
    const st = fsSync.statSync(dbPath);
    const walPath = `${dbPath}-wal`;
    const walSig = fsSync.existsSync(walPath)
      ? `${fsSync.statSync(walPath).mtimeMs}:${fsSync.statSync(walPath).size}`
      : '0:0';
    return `${st.mtimeMs}:${st.size}|${walSig}`;
  } catch { return null; }
}

function readLocalConversationMetrics(cascadeId) {
  if (!cascadeId || !/^[0-9a-f-]{36}$/i.test(cascadeId)) return null;
  const sig = getDbSignature(cascadeId);
  if (!sig) return {cascadeId, hasData: false};
  const cached = localMetricsCache.get(cascadeId);
  if (cached && cached.sig === sig && cached.fallbackLimit === fallbackContextLimit) return cached.payload;

  const dbPath = resolveLocalDbPath(cascadeId);
  let db;
  try {
    const prevParsedMap = cached?.parsedMap ? new Map(cached.parsedMap) : new Map();
    const maxPrevIdx = prevParsedMap.size > 0 ? Math.max(...prevParsedMap.keys()) : -1;
    db = new DatabaseSync(dbPath, {readOnly: true});
    const rows = maxPrevIdx >= 0
      ? db.prepare('SELECT idx, data FROM gen_metadata WHERE idx >= ? ORDER BY idx ASC').all(maxPrevIdx)
      : db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
    for (const r of rows || []) {
      prevParsedMap.set(Number(r.idx), parseSingleMetricRow(r));
    }
    if (prevParsedMap.size === 0) {
      db.close();
      return {cascadeId, hasData: false, sig};
    }
    const userSteps = db.prepare('SELECT idx FROM steps WHERE step_type = 14 ORDER BY idx ASC').all();
    const plannerSteps = db.prepare('SELECT idx FROM steps WHERE step_type = 15 ORDER BY idx ASC').all();
    db.close(); db = null;

    const sortedParsed = [...prevParsedMap.keys()].sort((a, b) => a - b).map(k => prevParsedMap.get(k));
    const payload = computeMetricsFromRows(cascadeId, sig, null, userSteps, plannerSteps, sortedParsed, fallbackContextLimit);
    localMetricsCache.set(cascadeId, {sig, fallbackLimit: fallbackContextLimit, payload, parsedMap: prevParsedMap});
    return payload;
  } catch {
    if (db) { try { db.close(); } catch {} }
    return null;
  }
}

// Per-conversation backoff for remote metrics. The first fetch of a long conversation is
// several MB; on a slow relay it used to time out after 3s and be retried every 1.2s, so the
// metrics pill alone could saturate the tunnel and starve the real history/stream traffic.
const remoteMetricsBackoff = new Map(); // cascadeId -> { until, fails }

// One remote metrics fetch per conversation at a time, and at most one full (non-delta)
// download overall. The UI asks for metrics every 1.5s until the first payload arrives; each
// ask used to start another multi-MB download, which on a slow link filled every bridge socket.
const remoteMetricsInFlight = new Map(); // cascadeId -> Promise
let remoteFullMetricsFetches = 0;

function readRemoteConversationMetrics(cascadeId) {
  if (!cascadeId || !/^[0-9a-f-]{36}$/i.test(cascadeId)) return Promise.resolve(null);
  const pending = remoteMetricsInFlight.get(cascadeId);
  if (pending) return pending;
  const p = readRemoteConversationMetricsOnce(cascadeId).finally(() => remoteMetricsInFlight.delete(cascadeId));
  remoteMetricsInFlight.set(cascadeId, p);
  return p;
}

async function readRemoteConversationMetricsOnce(cascadeId) {
  const cached = remoteMetricsCache.get(cascadeId);
  const backoff = remoteMetricsBackoff.get(cascadeId);
  if (backoff && Date.now() < backoff.until) return cached?.payload || null;
  const prevParsedMap = cached?.parsedMap ? new Map(cached.parsedMap) : new Map();
  const maxPrevIdx = prevParsedMap.size > 1 ? Math.max(...prevParsedMap.keys()) - 1 : -1;
  const isFull = !(maxPrevIdx >= 0);
  if (isFull && remoteFullMetricsFetches >= 1) return cached?.payload || null;
  if (isFull) remoteFullMetricsFetches += 1;
  let raw;
  try {
    raw = await fetchRemoteConversationRaw(cascadeId, cached?.sig || '', maxPrevIdx);
  } finally {
    if (isFull) remoteFullMetricsFetches -= 1;
  }
  if (!raw || raw.ok === false) {
    const fails = (backoff?.fails || 0) + 1;
    remoteMetricsBackoff.set(cascadeId, {fails, until: Date.now() + Math.min(60000, 2000 * 2 ** (fails - 1))});
    return cached?.payload || null;
  }
  remoteMetricsBackoff.delete(cascadeId);
  if (!raw.hasData) return {cascadeId, hasData: false, sig: raw.sig || ''};
  if (raw.unchanged && cached && cached.fallbackLimit === fallbackContextLimit) return cached.payload;
  const nextParsedMap = raw.delta ? prevParsedMap : new Map();
  for (const r of raw.rows || []) {
    nextParsedMap.set(Number(r.idx), parseSingleMetricRow(r));
  }
  const sortedParsed = [...nextParsedMap.keys()].sort((a, b) => a - b).map(k => nextParsedMap.get(k));
  const payload = computeMetricsFromRows(
    cascadeId,
    raw.sig,
    null,
    raw.userSteps || [],
    raw.plannerSteps || [],
    sortedParsed,
    fallbackContextLimit
  );
  remoteMetricsCache.set(cascadeId, {sig: raw.sig, fallbackLimit: fallbackContextLimit, payload, parsedMap: nextParsedMap});
  return payload;
}

function isRemoteSession(session) {
  try {
    const u = new URL(session?.targetUrl || 'https://127.0.0.1/');
    return isRemotePort(Number(u.port));
  } catch {
    return false;
  }
}

function rememberSessionPath(session, urlStr) {
  if (!session || !urlStr) return;
  try {
    const u = new URL(urlStr);
    const port = Number(u.port);
    if (!port || port <= 1024) return;
    const relPath = (u.pathname || '/') + (u.search || '');
    if (isRemotePort(port)) {
      session.lastRemotePath = relPath;
    } else {
      session.lastLocalPath = relPath;
    }
  } catch {}
}

async function captureCurrentSessionPath(session) {
  if (!session?.client?.open) return;
  const href = await session.client.evaluate('location.href').catch(() => session.targetUrl);
  rememberSessionPath(session, href || session.targetUrl);
}

async function pushMetricsToSession(session, cascadeId, force = false) {
  if (!session?.client?.open || !cascadeId) return;
  try {
    let payload = null;
    if (isRemoteCascade(cascadeId)) {
      payload = await readRemoteConversationMetrics(cascadeId);
      if (!payload || !payload.hasData) {
        const localPayload = readLocalConversationMetrics(cascadeId);
        if (localPayload?.hasData || !payload) payload = localPayload;
      }
    } else {
      payload = readLocalConversationMetrics(cascadeId);
      if (!payload || !payload.hasData) {
        const remotePayload = await readRemoteConversationMetrics(cascadeId);
        if (remotePayload?.hasData || !payload) payload = remotePayload;
      }
    }
    if (!payload) return;
    const nextLimit = payload.contextLimit || 0;
    if (
      !force &&
      session.lastMetricsCascade === cascadeId &&
      session.lastMetricsSig === payload.sig &&
      session.lastMetricsLimit === nextLimit
    ) {
      return;
    }
    session.lastMetricsCascade = cascadeId;
    session.lastMetricsSig = payload.sig || '';
    session.lastMetricsLimit = nextLimit;
    await session.client.evaluate(`window.__ag_render_metrics && window.__ag_render_metrics(${JSON.stringify(payload)})`);
  } catch {}
}

let metricsSyncInFlight = false;
async function syncAllMetrics() {
  if (stopping || metricsSyncInFlight) return;
  metricsSyncInFlight = true;
  try {
    await syncAllMetricsOnce();
  } finally {
    metricsSyncInFlight = false;
  }
}

async function syncAllMetricsOnce() {
  for (const session of sessions.values()) {
    if (!session.client.open) continue;
    try {
      let cid = session.watchedCascadeId || '';
      if (!cid) {
        cid = await session.client.evaluate('window.__ag_watched_cascade_id || ""').catch(() => '');
        if (cid) session.watchedCascadeId = cid;
      }
      if (cid) await pushMetricsToSession(session, cid, false);
    } catch {}
  }
}

const localMetricWatchers = [];
let localMetricWatchDebounce = null;
function startLocalMetricsFsWatcher() {
  for (const dir of [CONVERSATIONS_DIR, CLI_CONVERSATIONS_DIR]) {
    if (!fsSync.existsSync(dir)) continue;
    try {
      const watcher = fsSync.watch(dir, (_eventType, filename) => {
        if (!filename || stopping) return;
        const m = String(filename).match(/^([0-9a-f-]{36})\.db(?:-wal)?$/i);
        if (!m) return;
        const changedCid = m[1];
        for (const session of sessions.values()) {
          if (session.client?.open && session.watchedCascadeId === changedCid) {
            if (localMetricWatchDebounce) clearTimeout(localMetricWatchDebounce);
            localMetricWatchDebounce = setTimeout(() => {
              localMetricWatchDebounce = null;
              pushMetricsToSession(session, changedCid, false).catch(() => {});
            }, 60);
            break;
          }
        }
      });
      watcher.on('error', () => {});
      localMetricWatchers.push(watcher);
    } catch {}
  }
}

async function pushSshStateToSession(session, state = getSshState(), force = false) {
  if (!session?.client?.open) return;
  try {
    const {updatedAt: _ignore, ...stableState} = state || {};
    const stateJson = JSON.stringify(state);
    const sig = JSON.stringify(stableState);
    if (!force && session.lastSshStateSig === sig) return;
    session.lastSshStateSig = sig;
    await session.client.evaluate(`window.__ag_update_ssh_state && window.__ag_update_ssh_state(${stateJson})`);
  } catch {}
}

async function broadcastSshState(state = getSshState(), force = false) {
  for (const session of sessions.values()) {
    await pushSshStateToSession(session, state, force);
  }
}

setOnSshStateChange(state => {
  broadcastSshState(state).catch(() => {});
});

async function handleSshAction(session, rawPayload) {
  try {
    const req = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : (rawPayload || {});
    const action = req.action || 'get-state';
    const config = await readConfig();

    if (action === 'get-state') {
      await pushSshStateToSession(session, getSshState(), true);
      return;
    }

    if (action === 'set-env-filter') {
      const st = await setEnvFilter(req.filter || 'all');
      await broadcastSshState(st, true);
      return;
    }

    if (action === 'refresh-projects') {
      await pushMergedProjectListToBrowsers();
      await broadcastSshState(getSshState(), true);
      return;
    }

    if (action === 'set-mode') {
      const nextMode = normalizeSshMode(req.mode);
      if (config.sshMode !== nextMode) {
        await saveConfig({...config, sshMode: nextMode});
      }
      await log(`SSH mode set to ${nextMode}`);
      const st = await ensureRemoteTunnel(nextMode, {forceReconnect: nextMode !== 'local'});
      await broadcastSshState(st);
      if (nextMode === 'local' && isRemoteSession(session)) {
        await captureCurrentSessionPath(session);
        const localPort = (await discoverLocalMacLsPort()) || st.localMacPort;
        if (localPort > 0 && session.client.open) {
          session.targetUrl = `https://127.0.0.1:${localPort}${session.lastLocalPath || '/'}`;
          await session.client.call('Page.navigate', {url: session.targetUrl}).catch(() => {});
          setTimeout(sync, 400);
        }
      }
      return;
    }

    if (action === 'connect-window') {
      await captureCurrentSessionPath(session);
      const requested = req.mode ? normalizeSshMode(req.mode) : '';
      const desiredMode = requested && requested !== 'local'
        ? requested
        : (config.sshMode === 'local' ? 'auto' : config.sshMode);
      if (config.sshMode !== desiredMode) {
        await saveConfig({...config, sshMode: desiredMode});
      }
      const st = await ensureRemoteTunnel(desiredMode);
      await broadcastSshState(st);
      if (st.status === 'connected' && st.localHttpsPort && session.client.open) {
        const remoteUrl = `https://127.0.0.1:${st.localHttpsPort}${session.lastRemotePath || '/'}`;
        session.targetUrl = remoteUrl;
        session.signature = '';
        await log(`Navigating window to SSH remote workspace (${st.activeHost} -> ${remoteUrl})`);
        await session.client.call('Page.navigate', {url: remoteUrl}).catch(() => {});
        setTimeout(sync, 350);
        setTimeout(sync, 1200);
      }
      return;
    }

    if (action === 'switch-local') {
      await captureCurrentSessionPath(session);
      const localPort = (await discoverLocalMacLsPort()) || getSshState().localMacPort;
      if (localPort > 0 && session.client.open) {
        const localUrl = `https://127.0.0.1:${localPort}${session.lastLocalPath || '/'}`;
        session.targetUrl = localUrl;
        session.signature = '';
        await log(`Switching window back to local macOS workspace (${localUrl})`);
        await session.client.call('Page.navigate', {url: localUrl}).catch(() => {});
        setTimeout(sync, 350);
        setTimeout(sync, 1200);
      }
      return;
    }

    if (action === 'reconnect') {
      const mode = config.sshMode === 'local' ? 'auto' : config.sshMode;
      await log(`Reconnecting SSH tunnel (mode=${mode})`);
      const st = await ensureRemoteTunnel(mode, {forceReconnect: true});
      await broadcastSshState(st);
      return;
    }

    if (action === 'restart-remote') {
      const mode = config.sshMode === 'local' ? 'auto' : config.sshMode;
      await log(`Restarting remote language_server daemon (mode=${mode})`);
      const st = await ensureRemoteTunnel(mode, {forceRestart: true});
      await broadcastSshState(st);
      if (isRemoteSession(session) && st.status === 'connected' && session.client.open) {
        await session.client.call('Page.reload', {ignoreCache: true}).catch(() => {});
        setTimeout(sync, 500);
      }
      return;
    }
  } catch (err) {
    await log(`SSH action error: ${err.message}`);
  }
}

async function detach(session, restore = true) {
  if (session.navTimer) {
    clearTimeout(session.navTimer);
    session.navTimer = null;
  }
  if (session.client.open) {
    if (session.scriptId) await session.client.call('Page.removeScriptToEvaluateOnNewDocument', {identifier: session.scriptId}).catch(() => {});
    if (restore) await session.client.evaluate('window.__feiAGPatch?.dispose()').catch(() => {});
  }
  session.client.close();
}

async function backup(client) {
  const backupPath = path.join(patchDir, 'backups/original-appearance.json');
  if (await fs.stat(backupPath).catch(() => null)) return;
  const original = await client.evaluate(`({
    capturedAt: new Date().toISOString(),
    bodyClass: document.body.className,
    variables: Object.fromEntries(['--background','--foreground','--primary','--sidebar','--card','--border'].map(k => [k, getComputedStyle(document.body).getPropertyValue(k)])),
    note: 'Native preferences are not modified. Removing the CSS layer restores these original settings.'
  })`);
  await fs.writeFile(backupPath, JSON.stringify(original, null, 2) + '\n', {mode: 0o600, flag: 'wx'}).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
}

async function sync() {
  if (busy || stopping) return;
  busy = true;
  try {
    const config = await readConfig();
    fallbackContextLimit = await readFallbackContextLimit();
    if (!config.enabled) {
      for (const session of sessions.values()) await detach(session);
      sessions.clear();
      return;
    }

    if (!tunnelInitialized) {
      tunnelInitialized = true;
      ensureRemoteTunnel(config.sshMode).catch(err => log(`Initial SSH tunnel error: ${err.message}`));
    } else if (config.sshMode !== getSshState().mode) {
      ensureRemoteTunnel(config.sshMode, {forceReconnect: config.sshMode !== 'local'}).catch(() => {});
    }

    const found = await targets();
    const ids = new Set(found.map(target => target.id));
    for (const [id, session] of sessions) if (!ids.has(id) || !session.client.open) {
      await detach(session, false); sessions.delete(id);
    }
    const bundle = await build(config);
    for (const target of found) {
      let session = sessions.get(target.id);
      if (!session) {
        const client = await connect(target);
        session = {
          client,
          targetId: target.id,
          targetUrl: target.url,
          lastLocalPath: '/',
          lastRemotePath: '/',
          signature: '',
          bundleSource: '',
          scriptId: null,
          navTimer: null,
          lastMetricsCascade: '',
          lastMetricsSig: '',
          lastMetricsLimit: 0,
          lastSshStateSig: '',
          watchedCascadeId: '',
        };
        rememberSessionPath(session, target.url);
        sessions.set(target.id, session);
        await client.call('Page.enable');
        await client.call('Runtime.enable').catch(() => {});
        await client.call('Runtime.addBinding', {name: '__agRequestMetrics'}).catch(() => {});
        await client.call('Runtime.addBinding', {name: '__agSshAction'}).catch(() => {});
        await client.call('Runtime.addBinding', {name: '__agSyncSidecarAuthorities'}).catch(() => {});
        client.on('Runtime.bindingCalled', params => {
          if (params?.name === '__agRequestMetrics') {
            session.watchedCascadeId = params.payload || '';
            if (session.watchedCascadeId) {
              pushMetricsToSession(session, session.watchedCascadeId, true);
            }
          } else if (params?.name === '__agSshAction') {
            handleSshAction(session, params.payload);
          } else if (params?.name === '__agSyncSidecarAuthorities' && params.payload) {
            syncSidecarAuthorities(params.payload);
          }
        });
        client.on('Page.frameNavigated', params => {
          if (!params?.frame?.parentId) {
            session.targetUrl = params?.frame?.url || session.targetUrl;
            rememberSessionPath(session, session.targetUrl);
            if (!session.scriptId) session.signature = '';
            if (session.navTimer) clearTimeout(session.navTimer);
            session.navTimer = setTimeout(async () => {
              session.navTimer = null;
              if (!session.client.open) return;
              const src = session.bundleSource || bundle.source;
              if (session.scriptId) {
                const hasPatch = await session.client.evaluate('Boolean(window.__feiAGPatch)').catch(() => false);
                if (!hasPatch) {
                  await session.client.evaluate(src).catch(() => {});
                }
              } else {
                await session.client.evaluate(src).catch(() => {});
              }
              await pushSshStateToSession(session, getSshState(), true);
            }, 120);
          }
        });
        await backup(client).catch(() => {});
        if (config.sshMode !== 'local') {
          if (getSshState().status !== 'connected' && getSshState().status !== 'connecting') {
            ensureRemoteTunnel(config.sshMode, {forceReconnect: true}).catch(() => {});
          } else if (getSshState().status === 'connected') {
            pushMergedProjectListToBrowsers().catch(() => {});
          }
        }
      } else {
        session.targetUrl = target.url || session.targetUrl;
        rememberSessionPath(session, session.targetUrl);
      }

      if (session.signature !== bundle.signature) {
        if (session.scriptId) await session.client.call('Page.removeScriptToEvaluateOnNewDocument', {identifier: session.scriptId}).catch(() => {});
        const result = await session.client.call('Page.addScriptToEvaluateOnNewDocument', {source: bundle.source});
        session.scriptId = result.identifier;
        session.bundleSource = bundle.source;
        await session.client.evaluate(bundle.source);
        await pushSshStateToSession(session, getSshState(), true);
        session.signature = bundle.signature;
        session.lastMetricsSig = '';
        const cid = await session.client.evaluate('window.__ag_watched_cascade_id || ""').catch(() => '');
        if (cid) await pushMetricsToSession(session, cid, true);
        await log(`Applied ${config.preset}; localization=${config.localize}; sshMode=${config.sshMode}; version=${PATCH_VERSION}; signature=${bundle.signature}`);
        const bootedBeforeMain = await session.client.evaluate('Boolean(window.__ag_multiplexer_booted_before_main)').catch(() => true);
        if (!bootedBeforeMain && !session.reloadedForMultiplexer && getSshState().status === 'connected') {
          session.reloadedForMultiplexer = true;
          await log('Reloading window once to attach unified Local+SSH stream multiplexer before main.js boot');
          await session.client.call('Page.reload', {ignoreCache: false}).catch(() => {});
        }
      } else {
        const bootedBeforeMain = await session.client.evaluate('Boolean(window.__ag_multiplexer_booted_before_main)').catch(() => true);
        if (!bootedBeforeMain && !session.reloadedForMultiplexer && getSshState().status === 'connected') {
          session.reloadedForMultiplexer = true;
          await log('Reloading window once to attach unified Local+SSH stream multiplexer before main.js boot');
          await session.client.call('Page.reload', {ignoreCache: false}).catch(() => {});
          continue;
        }
        const readyState = await session.client.evaluate('document.readyState').catch(() => 'loading');
        if (readyState === 'loading') continue;
        const health = await session.client.evaluate('window.__feiAGPatch?.health()').catch(() => null);
        if (!health || !health.style || health.signature !== bundle.signature || health.version !== PATCH_VERSION) {
          await session.client.evaluate('window.__feiAGPatch?.dispose()').catch(() => {});
          await session.client.evaluate(bundle.source);
          await pushSshStateToSession(session, getSshState(), true);
          session.lastMetricsSig = '';
          const cid = await session.client.evaluate('window.__ag_watched_cascade_id || ""').catch(() => '');
          if (cid) await pushMetricsToSession(session, cid, true);
          await log('Restored missing runtime patch');
        } else {
          await pushSshStateToSession(session, getSshState(), false);
          if (health.preset !== config.preset || health.localize !== config.localize) {
            const latest = await readConfig();
            if (JSON.stringify(latest) === JSON.stringify(config)) {
              await saveConfig({...config, preset: health.preset, localize: health.localize});
              await log('Saved appearance-panel preference');
            }
            break;
          }
        }
      }
    }
    lastError = '';
  } catch (error) {
    const message = error.code === 'ENOENT' || /fetch failed|ECONNREFUSED/.test(error.message)
      ? 'Waiting for Antigravity' : error.message;
    if (message !== lastError) await log(message);
    lastError = message;
  } finally { busy = false; }
}

const interval = setInterval(sync, 2500);
const metricsInterval = setInterval(syncAllMetrics, 1200);
const tunnelInterval = setInterval(() => {
  if (!stopping) pollTunnelHealth().catch(() => {});
}, 5000);

async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(interval);
  clearInterval(metricsInterval);
  clearInterval(tunnelInterval);
  if (localMetricWatchDebounce) clearTimeout(localMetricWatchDebounce);
  for (const w of localMetricWatchers) {
    try { w.close(); } catch {}
  }
  stopAllTunnels();
  await Promise.race([
    (async () => { for (const session of sessions.values()) await detach(session); })(),
    new Promise(resolve => setTimeout(resolve, 4000)),
  ]);
  await log('Stopped; runtime changes removed');
  process.exit(0);
}
setSshLogger(message => { log(message).catch(() => {}); });
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
startLocalMetricsFsWatcher();
await log('Started; connects only to existing loopback debug port; does not launch Antigravity');
await sync();
await syncAllMetrics();
