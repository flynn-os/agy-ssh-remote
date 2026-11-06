import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {targets, connect, patchDir} from './cdp.mjs';
import {readConfig, saveConfig, build} from './bundle.mjs';
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

const PATCH_VERSION = '20261104-ssh-v12';
const sessions = new Map();
const logFile = path.join(patchDir, 'logs/patch.log');
const CONVERSATIONS_DIR = path.join(os.homedir(), '.gemini/antigravity/conversations');
const CLI_CONVERSATIONS_DIR = path.join(os.homedir(), '.gemini/antigravity-cli/conversations');
const CONTEXT_LIMIT_TOKENS = 256000;
const localMetricsCache = new Map();  // cascadeId -> { sig, payload }
const remoteMetricsCache = new Map(); // cascadeId -> { sig, payload }

let stopping = false;
let busy = false;
let lastError = '';
let tunnelInitialized = false;

async function log(message) {
  try {
    if ((await fs.stat(logFile).catch(() => ({size: 0}))).size > 1024 * 1024)
      await fs.rename(logFile, `${logFile}.1`);
    await fs.appendFile(logFile, `${new Date().toISOString()} ${message}\n`, {mode: 0o600});
  } catch {}
}

function parseProto(buf) {
  let i = 0;
  const out = new Map();
  while (i < buf.length) {
    let tag = 0, shift = 0;
    while (i < buf.length) {
      const b = buf[i++];
      tag |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const fn = tag >>> 3, wt = tag & 7;
    if (wt === 0) {
      let val = 0, s = 0;
      while (i < buf.length) {
        const b = buf[i++];
        val += (b & 0x7f) * Math.pow(2, s);
        if (!(b & 0x80)) break;
        s += 7;
      }
      out.set(fn, val);
    } else if (wt === 2) {
      let len = 0, s = 0;
      while (i < buf.length) {
        const b = buf[i++];
        len |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7;
      }
      out.set(fn, buf.subarray(i, i + len));
      i += len;
    } else if (wt === 1) {
      out.set(fn, buf.subarray(i, i + 8)); i += 8;
    } else if (wt === 5) {
      out.set(fn, buf.subarray(i, i + 4)); i += 4;
    } else break;
  }
  return out;
}

function fmtTok(n) {
  if (!n || n <= 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n >= 10000) return Math.round(n / 1000) + 'k';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}
const fmtNum = n => (n || 0).toLocaleString('en-US');

function parseSingleMetricRow(r) {
  const rawVal = r.data ?? r.b64 ?? '';
  const rawBuf = Buffer.isBuffer(rawVal)
    ? rawVal
    : (rawVal instanceof Uint8Array ? Buffer.from(rawVal) : Buffer.from(String(rawVal), 'base64'));
  const top = parseProto(rawBuf);
  const chat = top.has(1) ? parseProto(top.get(1)) : new Map();
  const usage = chat.has(4) ? parseProto(chat.get(4)) : new Map();
  const ttftMap = chat.has(11) ? parseProto(chat.get(11)) : new Map();
  const streamMap = chat.has(12) ? parseProto(chat.get(12)) : new Map();

  const inTok = usage.get(2) || 0, outTok = usage.get(3) || 0, cacheRead = usage.get(5) || 0;
  const thinkTok = usage.get(9) || 0, respTok = usage.get(10) || 0;
  const ttft = (ttftMap.get(1) || 0) + (ttftMap.get(2) || 0) / 1e9;
  const stream = (streamMap.get(1) || 0) + (streamMap.get(2) || 0) / 1e9;

  return {idx: r.idx, inTok, outTok, cacheRead, ctx: inTok + cacheRead, thinkTok, respTok, ttft, stream, totDur: ttft + stream};
}

function computeMetricsFromRows(cascadeId, sig, rows, userSteps, plannerSteps, preParsedRows = null) {
  const parsed = preParsedRows || (rows || []).map(parseSingleMetricRow);
  if (!parsed || parsed.length === 0) {
    return {cascadeId, hasData: false, sig};
  }
  const normIdx = item => (typeof item === 'number' ? item : item?.idx ?? 0);
  const lastUserStepIdx = userSteps.length > 0 ? normIdx(userSteps[userSteps.length - 1]) : -1;
  let totalIn = 0, totalCache = 0, totalOut = 0, totalThink = 0, totalResp = 0;
  let rawTurnSteps = 0;
  for (let i = 0; i < plannerSteps.length; i++) {
    if (normIdx(plannerSteps[i]) > lastUserStepIdx) rawTurnSteps++;
  }

  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    totalIn += p.inTok; totalCache += p.cacheRead; totalOut += p.outTok;
    totalThink += p.thinkTok; totalResp += p.respTok;
  }

  // Filter 0-usage metadata snapshot rows (upstream chuanban v5.0.0) so Ctx never drops to 0%
  const valid = parsed.filter(p => p.ctx > 0 || p.outTok > 0);
  if (valid.length === 0) {
    return {cascadeId, hasData: false, sig};
  }

  const turnSlice = rawTurnSteps > 0 ? valid.slice(-rawTurnSteps) : [];
  const turnSteps = turnSlice.length;
  let turnOut = 0, turnThink = 0, turnResp = 0, turnDur = 0;
  for (let i = 0; i < turnSlice.length; i++) {
    turnOut += turnSlice[i].outTok;
    turnThink += turnSlice[i].thinkTok;
    turnResp += turnSlice[i].respTok;
    turnDur += turnSlice[i].totDur;
  }

  const last = valid[valid.length - 1];
  const streamTps = last.stream >= 0.25 ? (last.outTok / last.stream) : 0;
  const e2eTps = last.totDur > 0 ? (last.outTok / last.totDur) : 0;
  const displayTps = (streamTps > 0 && streamTps <= 600) ? streamTps : e2eTps;
  const ctxPct = Math.round((last.ctx / CONTEXT_LIMIT_TOKENS) * 100);
  const ctxClass = ctxPct >= 90 ? 'ag-ctx-crit' : (ctxPct >= 75 ? 'ag-ctx-warn' : 'ag-ctx-ok');
  const lastCacheRate = last.ctx > 0 ? ((last.cacheRead / last.ctx) * 100).toFixed(1) : '0.0';
  const sessionCacheRate = (totalIn + totalCache) > 0 ? ((totalCache / (totalIn + totalCache)) * 100).toFixed(1) : '0.0';
  const remainCtx = Math.max(0, CONTEXT_LIMIT_TOKENS - last.ctx);

  const inlineHtml = [
    `<span>${Math.round(displayTps)} tok/s</span><span class="ag-sep">·</span>`,
    `<span>TTFT ${last.ttft.toFixed(1)}s</span><span class="ag-sep">·</span>`,
    `<span>Ctx ${fmtTok(last.ctx)}/256k <span class="${ctxClass}">(${ctxPct}%)</span></span><span class="ag-sep">·</span>`,
    `<span>Out ${fmtTok(last.outTok)}</span>`,
  ].join('');

  const turnRowHtml = turnSteps > 1
    ? `<div class="ag-tt-row"><span class="ag-tt-lbl">本轮合计 (${turnSteps}步)</span><span class="ag-tt-val">输出 ${fmtNum(turnOut)} (思考 ${fmtNum(turnThink)} + 响应 ${fmtNum(turnResp)}) | 耗时 ${turnDur.toFixed(1)}s</span></div>`
    : '';

  const tooltipHtml = [
    `<div class="ag-tt-hdr">本轮最新调用 (Gen #${last.idx + 1})</div>`,
    `<div class="ag-tt-row"><span class="ag-tt-lbl">生成速度</span><span class="ag-tt-val">${streamTps > 0 && streamTps <= 600 ? `流式 ${streamTps.toFixed(1)} tok/s | ` : ''}端到端 ${e2eTps.toFixed(1)} tok/s</span></div>`,
    `<div class="ag-tt-row"><span class="ag-tt-lbl">响应耗时</span><span class="ag-tt-val">TTFT ${last.ttft.toFixed(2)}s | 流式 ${last.stream.toFixed(2)}s | 总计 ${last.totDur.toFixed(2)}s</span></div>`,
    `<div class="ag-tt-row"><span class="ag-tt-lbl">当前上下文</span><span class="ag-tt-val">${fmtNum(last.ctx)} (新增 ${fmtNum(last.inTok)} + 缓存 ${fmtNum(last.cacheRead)}, ${lastCacheRate}%)</span></div>`,
    `<div class="ag-tt-row"><span class="ag-tt-lbl">本步输出量</span><span class="ag-tt-val">${fmtNum(last.outTok)} (思考链 ${fmtNum(last.thinkTok)} + 正文/工具 ${fmtNum(last.respTok)})</span></div>`,
    turnRowHtml,
    `<div class="ag-tt-hdr ag-tt-sec">当前会话累计 (${userSteps.length} 轮提问 / ${valid.length} 次有效调用)</div>`,
    `<div class="ag-tt-row"><span class="ag-tt-lbl">压缩水位线</span><span class="ag-tt-val">${fmtTok(last.ctx)} / 256k (${ctxPct}%) · 距压缩余 ${fmtTok(remainCtx)}</span></div>`,
    `<div class="ag-tt-row"><span class="ag-tt-lbl">累计输入量</span><span class="ag-tt-val">新增 ${fmtTok(totalIn)} + 缓存读取 ${fmtTok(totalCache)} (命中率 ${sessionCacheRate}%)</span></div>`,
    `<div class="ag-tt-row"><span class="ag-tt-lbl">累计输出量</span><span class="ag-tt-val">总计 ${fmtTok(totalOut)} (思考链 ${fmtTok(totalThink)} + 正文/工具 ${fmtTok(totalResp)})</span></div>`,
  ].join('');

  return {cascadeId, hasData: true, sig, inlineHtml, tooltipHtml};
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
  if (cached && cached.sig === sig) return cached.payload;

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
    const payload = computeMetricsFromRows(cascadeId, sig, null, userSteps, plannerSteps, sortedParsed);
    localMetricsCache.set(cascadeId, {sig, payload, parsedMap: prevParsedMap});
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
  if (raw.unchanged && cached) return cached.payload;
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
    sortedParsed
  );
  remoteMetricsCache.set(cascadeId, {sig: raw.sig, payload, parsedMap: nextParsedMap});
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
    if (!force && session.lastMetricsCascade === cascadeId && session.lastMetricsSig === payload.sig) return;
    session.lastMetricsCascade = cascadeId;
    session.lastMetricsSig = payload.sig || '';
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
          scriptId: null,
          lastMetricsCascade: '',
          lastMetricsSig: '',
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
            for (const delay of [80, 350]) {
              setTimeout(() => {
                if (!session.client.open) return;
                session.client.evaluate(bundle.source).catch(() => {});
                pushSshStateToSession(session, getSshState(), true);
              }, delay);
            }
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
