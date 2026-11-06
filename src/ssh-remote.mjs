import {execFile, spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import tls from 'node:tls';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.basename(__dirname) === 'src' ? path.dirname(__dirname) : __dirname;
const extraPaths = [
  path.join(os.homedir(), '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/sbin',
  '/sbin',
  '/usr/bin',
  '/bin',
];
const curPathParts = (process.env.PATH || '').split(':').filter(Boolean);
for (const p of extraPaths) {
  if (!curPathParts.includes(p)) curPathParts.push(p);
}
process.env.PATH = curPathParts.join(':');

const REMOTE_CTL_PATH = fs.existsSync(path.join(ROOT_DIR, 'remote/remote-ctl.py'))
  ? path.join(ROOT_DIR, 'remote/remote-ctl.py')
  : path.join(ROOT_DIR, 'remote-ctl.py');
const CACHE_DIR = path.join(ROOT_DIR, 'cache');
const LOCAL_WWW_CACHE_DIR = path.join(CACHE_DIR, 'www');
const LOCAL_WWW_META_PATH = path.join(CACHE_DIR, 'www-meta.json');
const LOCAL_DELETED_TOMBSTONES_PATH = path.join(CACHE_DIR, 'deleted-conversations.json');
const LOCAL_WWW_PATCH_VERSION = '20261103-ssh-v10';
const EXPECTED_BRIDGE_VERSION = '20261107-ssh-v13';
const LOCAL_CONVERSATIONS_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');
const LOCAL_CLI_CONVERSATIONS_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');
const APP_INFO_PLIST_PATH = '/Applications/Antigravity.app/Contents/Info.plist';
const LOCAL_APP_LS_BIN_PATH = '/Applications/Antigravity.app/Contents/Resources/bin/language_server';
const RELEASES_MANIFEST_URL = 'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/releases';
const KNOWN_EXECUTION_IDS = new Map([
  ['2.28.2', '5937220255875072'],
  ['2.28.1', '6709500728705024'],
  ['2.28.0', '6410674700681216'],
]);

let cachedLocalAppVersion = '';
let cachedLocalAppVersionMtimeMs = -1;

export function detectLocalAppVersion() {
  try {
    if (fs.existsSync(APP_INFO_PLIST_PATH)) {
      const st = fs.statSync(APP_INFO_PLIST_PATH);
      if (cachedLocalAppVersion && st.mtimeMs === cachedLocalAppVersionMtimeMs) {
        return cachedLocalAppVersion;
      }
      const xml = fs.readFileSync(APP_INFO_PLIST_PATH, 'utf8');
      const m = xml.match(/<key>CFBundleShortVersionString<\/key>\s*<string>(\d+\.\d+\.\d+)<\/string>/);
      if (m && m[1]) {
        cachedLocalAppVersion = m[1];
        cachedLocalAppVersionMtimeMs = st.mtimeMs;
        return cachedLocalAppVersion;
      }
    }
  } catch {}
  return cachedLocalAppVersion || '2.28.2';
}

export async function resolveExecutionIdForVersion(version) {
  if (!version) return 'auto';
  if (KNOWN_EXECUTION_IDS.has(version)) return KNOWN_EXECUTION_IDS.get(version);
  try {
    const res = await fetch(RELEASES_MANIFEST_URL, {signal: AbortSignal.timeout(4500)});
    if (res.ok) {
      const releases = await res.json();
      if (Array.isArray(releases)) {
        for (const r of releases) {
          if (r?.version && r?.execution_id) {
            KNOWN_EXECUTION_IDS.set(String(r.version), String(r.execution_id));
          }
        }
        if (KNOWN_EXECUTION_IDS.has(version)) {
          return KNOWN_EXECUTION_IDS.get(version);
        }
      }
    }
  } catch {}
  return 'auto';
}

export const REMOTE_DEFAULT_PROJECT_ALIAS = 'ssh-default-cli-project';

const SSH_CONTROL_DIR = `/tmp/ag-mux-${typeof process.getuid === 'function' ? process.getuid() : 0}`;
try {
  fs.mkdirSync(SSH_CONTROL_DIR, {recursive: true, mode: 0o700});
} catch {}

const SSH_COMMON_ARGS = [
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ExitOnForwardFailure=yes',
];

// Short-lived exec / probe calls: fail fast.
const SSH_BASE_ARGS = [
  ...SSH_COMMON_ARGS,
  '-o', 'ServerAliveInterval=5',
  '-o', 'ServerAliveCountMax=2',
];

// Long-lived port-forward tunnel: tolerate transient stalls on relayed / lossy links.
// The old 5s x 2 budget tore the tunnel (and every live stream) down after a 10s hiccup,
// which on a cross-border relay is routine. 15s x 4 = 60s before ssh gives up; the app-level
// health check below detects real outages and decides when to reconnect.
const SSH_TUNNEL_ARGS = [
  ...SSH_COMMON_ARGS,
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=4',
  '-o', 'TCPKeepAlive=no',
];

const SSH_MUX_ARGS = [
  '-o', 'ControlMaster=auto',
  '-o', 'ControlPersist=60',
  '-o', `ControlPath=${SSH_CONTROL_DIR}/%C`,
];

export const sshState = {
  mode: 'auto',
  envFilter: 'all', // 'all' | 'local' | 'remote'
  status: 'disconnected', // 'disconnected' | 'connecting' | 'connected' | 'error'
  activeHost: '',
  latencyMs: 0,
  localHttpsPort: 58282,
  localTunnelHttpsPort: 58285,
  localHttpPort: 58283,
  localBridgePort: 58284,
  remoteHttpsPort: 58282,
  remoteHttpPort: 58283,
  remoteBridgePort: 58284,
  remotePid: 0,
  remoteHostname: 'remote-host',
  remoteArch: 'x86_64',
  remoteHomeDir: '/home/user',
  csrfToken: '',
  localMacPort: 0,
  localMacCsrfToken: '',
  hasAuth: false,
  lastError: '',
  routeLatencies: {
    fei: null,
    'fei-tunnel': null,
  },
  sidecarPorts: [],
  projectEnvMap: {},
  localProjectIds: [],
  remoteProjectIds: [],
  cloudProjectIds: [],
  updatedAt: 0,
};

let mainTunnelProc = null;
let mainTunnelHost = null;
const sidecarTunnels = new Map();
const listeners = new Set();
const openUrlListeners = new Set();
const seenOpenUrls = new Set();
let connectingPromise = null;
let connectingMode = '';
let connectGeneration = 0;
let consecutivePingFailures = 0;

let localProxyServer = null;
let remoteUpstreamH2Session = null;
let remoteUpstreamH2Port = 0;
let localUpstreamH2Session = null;
let localUpstreamH2Port = 0;
let wwwWarmupInFlight = false;

// Federation state
const localProjectsMap = new Map();
const remoteProjectsMap = new Map();
const cloudProjectsMap = new Map();
const localProjectIdsSet = new Set();
const remoteProjectIdsSet = new Set();
const cloudProjectIdsSet = new Set();
const localCascadeIds = new Set();
const localCascadeProjectMap = new Map();
const remoteCascadeIds = new Set();
const remoteTerminalIds = new Set();
const activeProjectUpdateStreams = new Set();
const activeCloudProjectUpdateStreams = new Set();
const deletedProjectIdsSet = new Set();
const activeSummaryStreams = new Set();
let rawRemoteSummaries = {};
let rawLocalSummaries = {};
let cachedRemoteSummaryUpdates = {};
let cachedLocalSummaryUpdates = {};
const remoteCliSummariesMap = new Map();
const localCliSummariesMap = new Map();
const remoteArchivedIdsSet = new Set();
const localArchivedIdsSet = new Set();
const remoteDeletedIdsSet = new Set();
const localDeletedIdsSet = new Set();
const remotePbtxtTitlesMap = new Map();
const localPbtxtTitlesMap = new Map();
const lastPushedRemoteSummarySig = new Map();
const lastPushedLocalSummarySig = new Map();
let cliSummariesSyncInFlight = false;
let cliSummariesIntervalTimer = null;
let lastRemoteCliSummariesBridgeSig = '';
let cachedRemoteAuthStatus = null;
let cachedRemoteAuthStatusTs = 0;
let projectUpstreamStreamStarted = {local: false, remote: false};

export function isRemoteCascade(cascadeId) {
  if (!cascadeId) return false;
  if (remoteCascadeIds.has(cascadeId)) return true;
  if (localCascadeIds.has(cascadeId)) return false;
  try {
    if (
      fs.existsSync(path.join(LOCAL_CONVERSATIONS_DIR, `${cascadeId}.pb`)) ||
      fs.existsSync(path.join(LOCAL_CONVERSATIONS_DIR, `${cascadeId}.db`))
    ) {
      localCascadeIds.add(cascadeId);
      return false;
    }
  } catch {}
  return false;
}

export function onSshStateChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setOnSshStateChange(fn) {
  return onSshStateChange(fn);
}

export function isRemotePort(port) {
  const p = Number(port);
  return p === 58282 || p === 58285 || p === sshState.localHttpsPort || p === sshState.localTunnelHttpsPort;
}

export function stopAllTunnels() {
  connectGeneration += 1;
  connectingPromise = null;
  connectingMode = '';
  if (mainTunnelProc) {
    try { mainTunnelProc.kill('SIGTERM'); } catch {}
    mainTunnelProc = null;
  }
  mainTunnelHost = null;
  resetUpstreamH2();
  for (const proc of sidecarTunnels.values()) {
    try { proc.kill('SIGTERM'); } catch {}
  }
  sidecarTunnels.clear();
}

export function onRemoteOpenUrl(fn) {
  openUrlListeners.add(fn);
  return () => openUrlListeners.delete(fn);
}

function emitState(patch = {}) {
  Object.assign(sshState, patch, {updatedAt: Date.now()});
  const snapshot = getSshState();
  for (const fn of listeners) {
    try {
      fn(snapshot);
    } catch {}
  }
  return snapshot;
}

export function getSshState() {
  const cascadeProjectMap = {};
  for (const [cid, pid] of localCascadeProjectMap.entries()) {
    if (pid) cascadeProjectMap[cid] = pid;
  }
  for (const [cid, norm] of Object.entries(cachedRemoteSummaryUpdates)) {
    const pid = norm?.trajectoryMetadata?.projectId;
    if (pid) cascadeProjectMap[cid] = pid;
  }
  return {
    ...sshState,
    routeLatencies: {...sshState.routeLatencies},
    sidecarPorts: [...sidecarTunnels.keys()],
    projectEnvMap: {...sshState.projectEnvMap},
    localProjectIds: [...localProjectIdsSet],
    remoteProjectIds: [...remoteProjectIdsSet],
    cloudProjectIds: [...cloudProjectIdsSet],
    remoteCascadeIds: [...remoteCascadeIds],
    localCascadeIds: [...localCascadeIds],
    cascadeProjectMap,
  };
}

export async function setEnvFilter(filter) {
  const valid = ['all', 'local', 'remote'].includes(filter) ? filter : 'all';
  emitState({envFilter: valid});
  await pushMergedProjectListToBrowsers();
  return getSshState();
}

function extractCertAndKey() {
  const tlsDir = path.join(CACHE_DIR, 'tls');
  const certPath = path.join(tlsDir, 'cert.pem');
  const keyPath = path.join(tlsDir, 'key.pem');
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return {
      cert: fs.readFileSync(certPath, 'utf8'),
      key: fs.readFileSync(keyPath, 'utf8'),
    };
  }
  const appCert = '/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/dist/languageServer/cert.pem';
  if (fs.existsSync(appCert)) {
    const pem = fs.readFileSync(appCert, 'utf8');
    return {cert: pem, key: pem};
  }
  throw new Error('Cannot find TLS cert.pem/key.pem in cache/tls');
}

function patchMainJsCode(code) {
  let out = code;
  if (!out.includes('(window.__ag_is_ssh_remote?void 0:window.nativeStorage)')) {
    out = out.replaceAll('window.nativeStorage', '(window.__ag_is_ssh_remote?void 0:window.nativeStorage)');
  }
  if (!out.includes('(window.__agWsl||window.wsl)')) {
    out = out.replaceAll('window.wsl', '(window.__agWsl||window.wsl)');
  }
  if (!out.includes('(window.__agExtensions||window.extensions)')) {
    out = out.replaceAll('window.extensions', '(window.__agExtensions||window.extensions)');
  }
  // Dynamic folder picker: uses web folder picker when window.__ag_use_remote_picker is true, else native Finder dialog
  out = out.replaceAll(
    'Ij(yJc(a,d,window.dialog))',
    'Ij(yJc(a,d,(window.__ag_use_remote_picker?void 0:window.dialog)))'
  );
  out = out.replaceAll(
    'Ij(yJc(a,d))',
    'Ij(yJc(a,d,(window.__ag_use_remote_picker?void 0:window.dialog)))'
  );
  if (!out.includes('(window.__ag_use_remote_picker?void 0:window.dialog)')) {
    out = out.replaceAll('window.dialog', '(window.__ag_use_remote_picker?void 0:window.dialog)');
  }
  out = out.replace(
    'const f=await c.client.readDir({uri:e});',
    'const f=await c.client.readDir({uri:e.endsWith("/")?e:e+"/"});'
  );
  // Allow CLI / AgentAPI / SDK trajectory sources in sidebar filter rna(c.source) using non-minified Protobuf enum names
  const jetboxMarker = '.CortexTrajectorySource.JETBOX';
  const jbIdx = out.indexOf(jetboxMarker);
  if (jbIdx > 20 && !out.includes('.CortexTrajectorySource.JETBOX||')) {
    const winStart = Math.max(0, jbIdx - 24);
    const prefixWin = out.slice(winStart, jbIdx + jetboxMarker.length);
    const m = prefixWin.match(/([\w$]+)\s*===\s*([\w$]+\.CortexTrajectorySource)\.JETBOX$/);
    if (m) {
      const [origExpr, varA, enumObj] = m;
      const newExpr = `(${varA}===${enumObj}.JETBOX||${varA}===${enumObj}.CLI||${varA}===${enumObj}.AGENT_API||${varA}===${enumObj}.SDK)`;
      const replaceStart = jbIdx + jetboxMarker.length - origExpr.length;
      out = out.slice(0, replaceStart) + newExpr + out.slice(jbIdx + jetboxMarker.length);
    }
  }
  return out;
}

const staticFileMemoryCache = new Map(); // fullPath -> { mtimeMs, size, buf, contentType }
let lastVerifiedMainJsAppVer = '';
let lastVerifiedMainJsMtimeMs = -1;

function getCachedFileEntry(urlPath) {
  const clean = (urlPath || '/').split('?')[0];
  if (clean === '/' || clean === '/c' || clean.startsWith('/c/')) return null;
  const rel = clean.replace(/^\/+/, '');
  if (!rel || rel.includes('..')) return null;
  const full = path.join(LOCAL_WWW_CACHE_DIR, rel);
  try {
    const st = fs.statSync(full);
    if (!st.isFile()) return null;
    const hit = staticFileMemoryCache.get(full);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      return hit;
    }
    const buf = fs.readFileSync(full);
    const entry = {
      path: full,
      mtimeMs: st.mtimeMs,
      size: st.size,
      buf,
      contentType: guessContentType(full),
    };
    if (staticFileMemoryCache.size > 64) {
      const oldestKey = staticFileMemoryCache.keys().next().value;
      if (oldestKey) staticFileMemoryCache.delete(oldestKey);
    }
    staticFileMemoryCache.set(full, entry);
    return entry;
  } catch {}
  return null;
}

function getCachedFile(urlPath) {
  return getCachedFileEntry(urlPath)?.path || null;
}

function guessContentType(filePath) {
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.json') || filePath.endsWith('.map')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.woff2')) return 'font/woff2';
  if (filePath.endsWith('.ttf')) return 'font/ttf';
  return 'application/octet-stream';
}

function extractEmbeddedWwwFromLocalBinary() {
  if (!fs.existsSync(LOCAL_APP_LS_BIN_PATH)) return false;
  try {
    fs.mkdirSync(LOCAL_WWW_CACHE_DIR, {recursive: true});
    const pyCode = [
      'import io, os, struct, sys, zipfile',
      'bin_path, out_dir = sys.argv[1], sys.argv[2]',
      'with open(bin_path, "rb") as f: data = f.read()',
      'idx = data.find(b"compiled_tailwind.css")',
      'if idx < 0: sys.exit(1)',
      'idx_cd = data.find(b"PK\\x01\\x02", idx)',
      'idx_eocd = data.find(b"PK\\x05\\x06", idx_cd)',
      'cd_size, cd_offset, comment_len = struct.unpack("<IIH", data[idx_eocd+12:idx_eocd+22])',
      'zf = zipfile.ZipFile(io.BytesIO(data[idx_cd - cd_offset : idx_eocd + 22 + comment_len]), "r")',
      'zf.extractall(out_dir)',
    ].join('; ');
    const res = spawnSync('python3', ['-c', pyCode, LOCAL_APP_LS_BIN_PATH, LOCAL_WWW_CACHE_DIR], {timeout: 8000});
    return res.status === 0;
  } catch {
    return false;
  }
}

function ensureLocalPatchedMainJs() {
  const currentAppVersion = detectLocalAppVersion();
  const mainJsPath = path.join(LOCAL_WWW_CACHE_DIR, 'main.js');
  try {
    if (
      lastVerifiedMainJsAppVer === currentAppVersion &&
      lastVerifiedMainJsMtimeMs > 0 &&
      fs.existsSync(mainJsPath) &&
      fs.statSync(mainJsPath).mtimeMs === lastVerifiedMainJsMtimeMs
    ) {
      return true;
    }
    let meta = {};
    if (fs.existsSync(LOCAL_WWW_META_PATH)) {
      meta = JSON.parse(fs.readFileSync(LOCAL_WWW_META_PATH, 'utf8'));
    }
    if (!fs.existsSync(mainJsPath) || (meta.appVersion && meta.appVersion !== currentAppVersion)) {
      extractEmbeddedWwwFromLocalBinary();
      staticFileMemoryCache.clear();
    }
    if (!fs.existsSync(mainJsPath)) return false;
    const raw = fs.readFileSync(mainJsPath, 'utf8');
    if (
      meta.patchVersion === LOCAL_WWW_PATCH_VERSION &&
      meta.appVersion === currentAppVersion &&
      raw.includes('__ag_use_remote_picker')
    ) {
      lastVerifiedMainJsAppVer = currentAppVersion;
      lastVerifiedMainJsMtimeMs = fs.statSync(mainJsPath).mtimeMs;
      return true;
    }
    const patched = patchMainJsCode(raw);
    fs.writeFileSync(mainJsPath, patched, 'utf8');
    staticFileMemoryCache.delete(mainJsPath);
    fs.writeFileSync(
      LOCAL_WWW_META_PATH,
      JSON.stringify({
        ...meta,
        appVersion: currentAppVersion,
        patchVersion: LOCAL_WWW_PATCH_VERSION,
        updatedAt: Date.now(),
      }),
      'utf8'
    );
    lastVerifiedMainJsAppVer = currentAppVersion;
    lastVerifiedMainJsMtimeMs = fs.statSync(mainJsPath).mtimeMs;
    return true;
  } catch {
    return false;
  }
}

async function warmupWwwCacheFromRemote(host) {
  if (wwwWarmupInFlight) return;
  if (ensureLocalPatchedMainJs()) return;
  wwwWarmupInFlight = true;
  try {
    fs.mkdirSync(LOCAL_WWW_CACHE_DIR, {recursive: true});
    const tarStreamCmd = [
      ...SSH_BASE_ARGS,
      host,
      'sh -lc \'D=$(ls -dt ~/.antigravity-server/bin/*/extensions/antigravity/cascade-panel/www 2>/dev/null | head -n 1); if [ -n "$D" ]; then tar -czf - -C "$D" .; fi\'',
    ];
    await new Promise((resolve) => {
      const sshProc = spawn('ssh', tarStreamCmd, {stdio: ['ignore', 'pipe', 'ignore']});
      const tarProc = spawn('tar', ['-xzf', '-', '-C', LOCAL_WWW_CACHE_DIR], {stdio: ['pipe', 'ignore', 'ignore']});
      sshProc.stdout.pipe(tarProc.stdin);
      const timer = setTimeout(() => {
        try { sshProc.kill('SIGTERM'); } catch {}
        try { tarProc.kill('SIGTERM'); } catch {}
        resolve(false);
      }, 25000);
      tarProc.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
      sshProc.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    ensureLocalPatchedMainJs();
  } catch {
  } finally {
    wwwWarmupInFlight = false;
  }
}

function getRemoteUpstreamH2() {
  const targetPort = sshState.localTunnelHttpsPort || 58285;
  if (
    remoteUpstreamH2Session &&
    !remoteUpstreamH2Session.closed &&
    !remoteUpstreamH2Session.destroyed &&
    remoteUpstreamH2Port === targetPort
  ) {
    return remoteUpstreamH2Session;
  }
  if (remoteUpstreamH2Session) {
    try { remoteUpstreamH2Session.destroy(); } catch {}
  }
  remoteUpstreamH2Port = targetPort;
  remoteUpstreamH2Session = http2.connect(`https://127.0.0.1:${targetPort}`, {
    rejectUnauthorized: false,
  });
  remoteUpstreamH2Session.on('error', () => {});
  remoteUpstreamH2Session.on('close', () => {
    if (remoteUpstreamH2Port === targetPort) remoteUpstreamH2Session = null;
  });
  return remoteUpstreamH2Session;
}

function getLocalUpstreamH2() {
  const targetPort = sshState.localMacPort;
  if (!targetPort) return null;
  if (
    localUpstreamH2Session &&
    !localUpstreamH2Session.closed &&
    !localUpstreamH2Session.destroyed &&
    localUpstreamH2Port === targetPort
  ) {
    return localUpstreamH2Session;
  }
  if (localUpstreamH2Session) {
    try { localUpstreamH2Session.destroy(); } catch {}
  }
  localUpstreamH2Port = targetPort;
  localUpstreamH2Session = http2.connect(`https://127.0.0.1:${targetPort}`, {
    rejectUnauthorized: false,
  });
  localUpstreamH2Session.on('error', () => {});
  localUpstreamH2Session.on('close', () => {
    if (localUpstreamH2Port === targetPort) localUpstreamH2Session = null;
  });
  return localUpstreamH2Session;
}

function resetUpstreamH2() {
  lastRemoteCliSummariesBridgeSig = '';
  if (remoteUpstreamH2Session) {
    try { remoteUpstreamH2Session.destroy(); } catch {}
    remoteUpstreamH2Session = null;
  }
  cachedRemoteAuthStatus = null;
  cachedRemoteAuthStatusTs = 0;
  projectUpstreamStreamStarted.remote = false;
  for (const entry of activeSummaryStreams) {
    try { entry.remoteReq?.close(); } catch {}
    entry.remoteReq = null;
  }
}

function resetLocalUpstreamH2() {
  lastLocalLsPortVerifiedTs = 0;
  if (localUpstreamH2Session) {
    try { localUpstreamH2Session.destroy(); } catch {}
    localUpstreamH2Session = null;
  }
  projectUpstreamStreamStarted.local = false;
}

function addCorsHeaders(headers = {}, reqHeaders = {}) {
  const origin = reqHeaders.origin || '*';
  const clean = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!k.startsWith(':')) clean[k] = v;
  }
  return {
    ...clean,
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers':
      reqHeaders['access-control-request-headers'] ||
      'content-type, connect-protocol-version, connect-timeout-ms, x-grpc-web, x-codeium-csrf-token, x-user-agent, x-ag-client, x-ag-target-env, x-ag-active-project, x-ag-force-target, x-ag-local-port, x-ag-local-csrf',
    'access-control-expose-headers':
      'grpc-status, grpc-message, grpc-status-details-bin, content-type, connect-content-encoding',
  };
}

function writeSafeHead(res, status, headers = {}, reqHeaders = {}) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const out = addCorsHeaders(headers, reqHeaders);
  res.writeHead(status, out);
}

function parseFramedMessages(buf) {
  const frames = [];
  if (!buf || buf.length === 0) return {frames, remainder: Buffer.alloc(0)};
  if (buf[0] === 0x7b) {
    const text = buf.toString('utf8');
    try {
      frames.push({flag: 0, text, json: JSON.parse(text), rawJson: true});
      return {frames, remainder: Buffer.alloc(0)};
    } catch {}
  }
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const flag = buf[offset];
    const len = buf.readUInt32BE(offset + 1);
    if (offset + 5 + len > buf.length) break;
    const slice = buf.subarray(offset + 5, offset + 5 + len);
    const text = slice.toString('utf8');
    let json = null;
    if ((flag & 0x80) === 0) {
      try {
        json = JSON.parse(text);
      } catch {}
    }
    frames.push({flag, text, json, rawJson: false});
    offset += 5 + len;
  }
  return {frames, remainder: buf.subarray(offset)};
}

function encodeDataFrame(jsonObj) {
  const payload = Buffer.from(typeof jsonObj === 'string' ? jsonObj : JSON.stringify(jsonObj), 'utf8');
  const hdr = Buffer.alloc(5);
  hdr[0] = 0x00;
  hdr.writeUInt32BE(payload.length, 1);
  return Buffer.concat([hdr, payload]);
}

function encodeGrpcWebTrailerFrame(status = 0, message = '') {
  const lines = [`grpc-status: ${status}\r\n`];
  if (message) lines.push(`grpc-message: ${encodeURIComponent(message)}\r\n`);
  const payload = Buffer.from(lines.join(''), 'utf8');
  const hdr = Buffer.alloc(5);
  hdr[0] = 0x80;
  hdr.writeUInt32BE(payload.length, 1);
  return Buffer.concat([hdr, payload]);
}

function sendUnaryRpcResponse(req, res, jsonObj) {
  if (res.writableEnded || res.destroyed) return;
  const ct = String(req.headers['content-type'] || '');
  const isGrpcWeb = ct.includes('grpc-web') || req.headers['x-grpc-web'] === '1';
  if (isGrpcWeb) {
    const body = Buffer.concat([encodeDataFrame(jsonObj), encodeGrpcWebTrailerFrame(0)]);
    writeSafeHead(
      res,
      200,
      {
        'content-type': 'application/grpc-web+json',
        'content-length': String(body.length),
      },
      req.headers
    );
    res.end(body);
  } else {
    const body = Buffer.from(JSON.stringify(jsonObj), 'utf8');
    writeSafeHead(
      res,
      200,
      {
        'content-type': 'application/json',
        'content-length': String(body.length),
      },
      req.headers
    );
    res.end(body);
  }
}

async function callUpstreamUnaryJson(target, methodName, payloadObj = {}, timeoutMs = 4500) {
  if (target === 'remote' && sshState.status !== 'connected') {
    return null;
  }
  if (target === 'local' && (!sshState.localMacPort || !sshState.localMacCsrfToken)) {
    await discoverLocalMacLsPort();
  }
  const h2 = target === 'local' ? getLocalUpstreamH2() : getRemoteUpstreamH2();
  const csrf = target === 'local' ? sshState.localMacCsrfToken : sshState.csrfToken;
  if (!h2 || !csrf) return null;

  return new Promise((resolve) => {
    let settled = false;
    let uReq = null;
    const done = (val, failed = false) => {
      if (!settled) {
        settled = true;
        if (failed) {
          try { uReq?.close(); } catch {}
          if (target === 'remote') resetUpstreamH2();
          else resetLocalUpstreamH2();
        }
        resolve(val);
      }
    };
    const timer = setTimeout(() => done(null, true), timeoutMs);
    try {
      const bodyBuf = Buffer.from(JSON.stringify(payloadObj), 'utf8');
      uReq = h2.request({
        ':method': 'POST',
        ':path': `/exa.language_server_pb.LanguageServerService/${methodName}`,
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        'x-codeium-csrf-token': csrf,
        'content-length': String(bodyBuf.length),
      });
      const chunks = [];
      uReq.on('data', (c) => chunks.push(c));
      uReq.on('end', () => {
        clearTimeout(timer);
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          done(JSON.parse(text), false);
        } catch {
          done(null, false);
        }
      });
      uReq.on('error', () => {
        clearTimeout(timer);
        done(null, true);
      });
      uReq.end(bodyBuf);
    } catch {
      clearTimeout(timer);
      done(null, true);
    }
  });
}

function getProjectFolderUri(proj) {
  const r0 = proj?.projectResources?.resources?.[0];
  return (
    r0?.folderUri ||
    r0?.gitFolder?.folderUri ||
    r0?.gitWorktree?.worktreeUri ||
    ''
  ).replace(/\/+$/, '');
}

function isCloudBackend(backend) {
  return (
    backend === 2 ||
    backend === 'BACKEND_TYPE_REMOTE_AICODE' ||
    backend === 'PROJECT_BACKEND_CLOUD'
  );
}

function isEnterpriseBackend(backend) {
  return (
    backend === 3 ||
    backend === 'BACKEND_TYPE_REMOTE_ENTERPRISE' ||
    backend === 'PROJECT_BACKEND_ENTERPRISE'
  );
}

function isCloudProject(proj) {
  if (!proj || typeof proj !== 'object') return false;
  const bt = proj.backendType ?? proj.backend;
  return isCloudBackend(bt) || isEnterpriseBackend(bt);
}

function registerCloudProject(proj) {
  if (!proj?.id || proj.id === 'outside-of-project') return;
  deletedProjectIdsSet.delete(proj.id);
  cloudProjectsMap.set(proj.id, proj);
  cloudProjectIdsSet.add(proj.id);
  localProjectIdsSet.delete(proj.id);
  localProjectsMap.delete(proj.id);
  remoteProjectIdsSet.delete(proj.id);
  remoteProjectsMap.delete(proj.id);
  sshState.projectEnvMap = {
    ...(sshState.projectEnvMap || {}),
    [proj.id]: {
      env: 'cloud',
      name: proj.name || proj.id,
      uri: getProjectFolderUri(proj),
      host: 'Cloud',
      backendType: proj.backendType || 'BACKEND_TYPE_REMOTE_AICODE',
    },
  };
  sshState.localProjectIds = [...localProjectIdsSet];
  sshState.remoteProjectIds = [...remoteProjectIdsSet];
  sshState.cloudProjectIds = [...cloudProjectIdsSet];
}

function evictProjectId(id) {
  if (!id) return;
  localProjectsMap.delete(id);
  remoteProjectsMap.delete(id);
  cloudProjectsMap.delete(id);
  localProjectIdsSet.delete(id);
  remoteProjectIdsSet.delete(id);
  cloudProjectIdsSet.delete(id);
  if (sshState.projectEnvMap && sshState.projectEnvMap[id]) {
    const nextEnv = {...sshState.projectEnvMap};
    delete nextEnv[id];
    sshState.projectEnvMap = nextEnv;
  }
  sshState.localProjectIds = [...localProjectIdsSet];
  sshState.remoteProjectIds = [...remoteProjectIdsSet];
  sshState.cloudProjectIds = [...cloudProjectIdsSet];
}

function syncCloudProjectIdsFromUpstreamList(ids) {
  if (!Array.isArray(ids)) return;
  const nextSet = new Set();
  for (const id of ids) {
    if (id && id !== 'outside-of-project' && !deletedProjectIdsSet.has(id)) {
      nextSet.add(id);
    }
  }
  for (const oldId of [...cloudProjectIdsSet]) {
    if (!nextSet.has(oldId)) {
      cloudProjectIdsSet.delete(oldId);
      cloudProjectsMap.delete(oldId);
      if (sshState.projectEnvMap && sshState.projectEnvMap[oldId]?.env === 'cloud') {
        const nextEnv = {...sshState.projectEnvMap};
        delete nextEnv[oldId];
        sshState.projectEnvMap = nextEnv;
      }
    }
  }
  for (const id of nextSet) {
    cloudProjectIdsSet.add(id);
    localProjectIdsSet.delete(id);
    remoteProjectIdsSet.delete(id);
    if (!sshState.projectEnvMap?.[id]) {
      sshState.projectEnvMap = {
        ...(sshState.projectEnvMap || {}),
        [id]: {
          env: 'cloud',
          name: cloudProjectsMap.get(id)?.name || id,
          uri: getProjectFolderUri(cloudProjectsMap.get(id)),
          host: 'Cloud',
          backendType: 'BACKEND_TYPE_REMOTE_AICODE',
        },
      };
    }
  }
  sshState.localProjectIds = [...localProjectIdsSet];
  sshState.remoteProjectIds = [...remoteProjectIdsSet];
  sshState.cloudProjectIds = [...cloudProjectIdsSet];
  emitState({});
}

function mapRemoteProjectObject(proj) {
  if (!proj || typeof proj !== 'object') return proj;
  if (proj.id === 'default-cli-project') {
    const hostname = sshState.remoteHostname || 'remote-host';
    const homeUri = `file://${sshState.remoteHomeDir || '/home/user'}`;
    return {
      ...proj,
      id: REMOTE_DEFAULT_PROJECT_ALIAS,
      name: `${hostname} (home)`,
      projectResources: proj.projectResources?.resources?.length
        ? proj.projectResources
        : {resources: [{folderUri: homeUri}]},
    };
  }
  return proj;
}

function computeMergedProjectIds() {
  const localArr = [...localProjectIdsSet].filter(id => id !== 'outside-of-project' && !cloudProjectIdsSet.has(id));
  const remoteArr = [...remoteProjectIdsSet].filter(id => id !== 'outside-of-project' && !cloudProjectIdsSet.has(id));
  const hasOutside = localProjectIdsSet.has('outside-of-project') || remoteProjectIdsSet.has('outside-of-project');

  const base = [];
  const seen = new Set();
  for (const id of [...localArr, ...remoteArr]) {
    if (!seen.has(id)) {
      seen.add(id);
      base.push(id);
    }
  }
  if (hasOutside && !base.includes('outside-of-project')) {
    base.push('outside-of-project');
  }
  return base;
}

export async function refreshProjectFederation() {
  const cloudTarget = sshState.status === 'connected' ? 'remote' : 'local';
  const [localListRes, remoteListRes, cloudListRes] = await Promise.all([
    callUpstreamUnaryJson('local', 'ListProjects', {}, 3500),
    callUpstreamUnaryJson('remote', 'ListProjects', {}, 4500),
    callUpstreamUnaryJson(cloudTarget, 'ListProjects', {backend: 'BACKEND_TYPE_REMOTE_AICODE'}, 4500),
  ]);

  if (Array.isArray(cloudListRes?.projectIds)) {
    const validCloudIds = cloudListRes.projectIds.filter(
      (id) => id && id !== 'outside-of-project' && !deletedProjectIdsSet.has(id)
    );
    syncCloudProjectIdsFromUpstreamList(validCloudIds);
    const missingCloudReadIds = validCloudIds.filter((id) => !cloudProjectsMap.has(id));
    if (missingCloudReadIds.length > 0) {
      const cReadRes = await callUpstreamUnaryJson(cloudTarget, 'ReadProjects', {ids: missingCloudReadIds}, 4500);
      if (Array.isArray(cReadRes?.projects)) {
        for (const cp of cReadRes.projects) {
          if (cp?.id && !deletedProjectIdsSet.has(cp.id)) {
            registerCloudProject(cp);
          }
        }
      }
    }
  }

  const rawLocalIds = Array.isArray(localListRes?.projectIds)
    ? localListRes.projectIds.filter((id) => !deletedProjectIdsSet.has(id))
    : [];
  const rawRemoteIds = Array.isArray(remoteListRes?.projectIds)
    ? remoteListRes.projectIds.filter((id) => !deletedProjectIdsSet.has(id))
    : [];

  const [localReadRes, remoteReadRes] = await Promise.all([
    rawLocalIds.length ? callUpstreamUnaryJson('local', 'ReadProjects', {ids: rawLocalIds}, 3500) : Promise.resolve({projects: []}),
    rawRemoteIds.length ? callUpstreamUnaryJson('remote', 'ReadProjects', {ids: rawRemoteIds}, 4500) : Promise.resolve({projects: []}),
  ]);

  if (Array.isArray(localListRes?.projectIds)) {
    localProjectIdsSet.clear();
    for (const id of rawLocalIds) {
      if (id !== 'outside-of-project' && !cloudProjectIdsSet.has(id)) localProjectIdsSet.add(id);
    }
    if (Array.isArray(localReadRes?.projects)) {
      localProjectsMap.clear();
    }
  }
  if (Array.isArray(localReadRes?.projects)) {
    for (const p of localReadRes.projects) {
      if (!p?.id) continue;
      if (isCloudProject(p)) {
        registerCloudProject(p);
        continue;
      }
      localProjectsMap.set(p.id, p);
      if (p.id !== 'outside-of-project') localProjectIdsSet.add(p.id);
    }
  }

  if (Array.isArray(remoteListRes?.projectIds)) {
    remoteProjectIdsSet.clear();
    for (const id of rawRemoteIds) {
      if (id === 'outside-of-project' || cloudProjectIdsSet.has(id)) continue;
      remoteProjectIdsSet.add(id === 'default-cli-project' ? REMOTE_DEFAULT_PROJECT_ALIAS : id);
    }
    remoteProjectIdsSet.add(REMOTE_DEFAULT_PROJECT_ALIAS);
    if (Array.isArray(remoteReadRes?.projects)) {
      remoteProjectsMap.clear();
    }
  }
  if (Array.isArray(remoteReadRes?.projects)) {
    for (const rawProj of remoteReadRes.projects) {
      if (!rawProj?.id || rawProj.id === 'outside-of-project') continue;
      if (isCloudProject(rawProj)) {
        registerCloudProject(rawProj);
        continue;
      }
      const mapped = mapRemoteProjectObject(rawProj);
      remoteProjectsMap.set(mapped.id, mapped);
      remoteProjectIdsSet.add(mapped.id);
    }
  }
  if (remoteProjectIdsSet.has(REMOTE_DEFAULT_PROJECT_ALIAS) && !remoteProjectsMap.has(REMOTE_DEFAULT_PROJECT_ALIAS)) {
    remoteProjectsMap.set(REMOTE_DEFAULT_PROJECT_ALIAS, mapRemoteProjectObject({id: 'default-cli-project'}));
  }

  const nextEnvMap = {};
  for (const id of localProjectIdsSet) {
    const p = localProjectsMap.get(id);
    nextEnvMap[id] = {
      env: 'local',
      name: p?.name || id,
      uri: getProjectFolderUri(p),
      host: 'Mac',
    };
  }
  for (const id of remoteProjectIdsSet) {
    const p = remoteProjectsMap.get(id);
    nextEnvMap[id] = {
      env: 'remote',
      name: p?.name || id,
      uri: getProjectFolderUri(p),
      host: sshState.remoteHostname || 'remote-host',
    };
  }
  for (const id of cloudProjectIdsSet) {
    const p = cloudProjectsMap.get(id);
    nextEnvMap[id] = {
      env: 'cloud',
      name: p?.name || id,
      uri: getProjectFolderUri(p),
      host: 'Cloud',
      backendType: p?.backendType || 'BACKEND_TYPE_REMOTE_AICODE',
    };
  }

  sshState.projectEnvMap = nextEnvMap;
  sshState.localProjectIds = [...localProjectIdsSet];
  sshState.remoteProjectIds = [...remoteProjectIdsSet];
  sshState.cloudProjectIds = [...cloudProjectIdsSet];
  emitState({});

  return {
    mergedIds: computeMergedProjectIds(),
  };
}

export async function pushMergedProjectListToBrowsers() {
  const {mergedIds} = await refreshProjectFederation();
  const frame = encodeDataFrame({projectList: {projectIds: mergedIds}});
  for (const clientRes of [...activeProjectUpdateStreams]) {
    if (clientRes.writableEnded || clientRes.destroyed) {
      activeProjectUpdateStreams.delete(clientRes);
      continue;
    }
    try {
      clientRes.write(frame);
    } catch {
      activeProjectUpdateStreams.delete(clientRes);
    }
  }
  const cloudFrame = encodeDataFrame({projectList: {projectIds: [...cloudProjectIdsSet]}});
  for (const clientRes of [...activeCloudProjectUpdateStreams]) {
    if (clientRes.writableEnded || clientRes.destroyed) {
      activeCloudProjectUpdateStreams.delete(clientRes);
      continue;
    }
    try {
      clientRes.write(cloudFrame);
    } catch {
      activeCloudProjectUpdateStreams.delete(clientRes);
    }
  }
  if (!sshState.localMacPort || !sshState.localMacCsrfToken) {
    await discoverLocalMacLsPort();
  }
  ensureUpstreamProjectUpdateWatcher('local');
  ensureUpstreamProjectUpdateWatcher('remote');
  await syncCliSummariesAndPushUpdates().catch(() => {});
  attachPendingRemoteSummaryStreams();

  if (Object.keys(cachedLocalSummaryUpdates).length === 0) {
    const lRes = await callUpstreamUnaryJson('local', 'GetAllCascadeTrajectories', {}, 3500).catch(() => null);
    if (lRes) {
      recordLocalSummariesObject(lRes);
    }
  }

  if (sshState.status === 'connected') {
    if (!cachedRemoteAuthStatus || Date.now() - cachedRemoteAuthStatusTs > 60000) {
      callUpstreamUnaryJson('remote', 'GetAuthStatus', {}, 6500)
        .then((aRes) => {
          if (aRes && aRes.userStatus) {
            cachedRemoteAuthStatus = aRes;
            cachedRemoteAuthStatusTs = Date.now();
          }
        })
        .catch(() => {});
    }
    if (Object.keys(rawRemoteSummaries).length === 0) {
      const rRes = await callUpstreamUnaryJson('remote', 'GetAllCascadeTrajectories', {}, 4500);
      if (rRes) {
        transformRemoteSummariesObject(rRes);
      }
    }
  }

  const combinedCached = dedupeCloudSummaries({
    ...cachedRemoteSummaryUpdates,
    ...cachedLocalSummaryUpdates,
  });
  if (Object.keys(combinedCached).length > 0) {
    const initFrame = encodeDataFrame({updates: combinedCached});
    for (const entry of [...activeSummaryStreams]) {
      if (!entry.res.writableEnded && !entry.res.destroyed) {
        try {
          entry.res.write(initFrame);
        } catch {}
      }
    }
  }

  // Re-evaluate cached remote summaries in case a more specific remote project was added or removed
  const changedUpdates = {};
  for (const [cid, rawSum] of Object.entries(rawRemoteSummaries)) {
    if (shouldOmitSummary(rawSum, cid, true)) {
      delete cachedRemoteSummaryUpdates[cid];
      continue;
    }
    const reNorm = normalizeRemoteSingleSummary(rawSum, cid);
    const prevPid = cachedRemoteSummaryUpdates[cid]?.trajectoryMetadata?.projectId;
    const prevArch = Boolean(cachedRemoteSummaryUpdates[cid]?.annotations?.archived);
    cachedRemoteSummaryUpdates[cid] = reNorm;
    if (
      reNorm?.trajectoryMetadata?.projectId !== prevPid ||
      Boolean(reNorm?.annotations?.archived) !== prevArch
    ) {
      changedUpdates[cid] = reNorm;
    }
  }
  const dedupedChanged = dedupeCloudSummaries(changedUpdates);
  if (Object.keys(dedupedChanged).length > 0) {
    const sumFrame = encodeDataFrame({updates: dedupedChanged});
    for (const entry of [...activeSummaryStreams]) {
      if (!entry.res.writableEnded && !entry.res.destroyed) {
        try {
          entry.res.write(sumFrame);
        } catch {}
      }
    }
  }
  emitState({});
}

function ensureUpstreamProjectUpdateWatcher(target) {
  if (projectUpstreamStreamStarted[target]) return;
  const h2 = target === 'local' ? getLocalUpstreamH2() : getRemoteUpstreamH2();
  const csrf = target === 'local' ? sshState.localMacCsrfToken : sshState.csrfToken;
  if (!h2 || !csrf) return;

  projectUpstreamStreamStarted[target] = true;
  try {
    const uReq = h2.request({
      ':method': 'POST',
      ':path': '/exa.language_server_pb.LanguageServerService/ProjectUpdatesStream',
      'content-type': 'application/grpc-web+json',
      'x-grpc-web': '1',
      'x-codeium-csrf-token': csrf,
    });
    let rem = Buffer.alloc(0);
    uReq.on('data', (chunk) => {
      const parsed = parseFramedMessages(Buffer.concat([rem, chunk]));
      rem = parsed.remainder;
      for (const f of parsed.frames) {
        if (f.json?.projectList) {
          pushMergedProjectListToBrowsers().catch(() => {});
        } else if (f.json?.projectUpdatedId) {
          const updId =
            target === 'remote' && f.json.projectUpdatedId === 'default-cli-project'
              ? REMOTE_DEFAULT_PROJECT_ALIAS
              : f.json.projectUpdatedId;
          refreshProjectFederation()
            .then(() => {
              const updFrame = encodeDataFrame({projectUpdatedId: updId});
              for (const clientRes of [...activeProjectUpdateStreams]) {
                if (!clientRes.writableEnded && !clientRes.destroyed) {
                  try { clientRes.write(updFrame); } catch {}
                }
              }
            })
            .catch(() => {});
        }
      }
    });
    uReq.on('end', () => {
      projectUpstreamStreamStarted[target] = false;
    });
    uReq.on('error', () => {
      projectUpstreamStreamStarted[target] = false;
    });
    uReq.end(encodeDataFrame({}));
  } catch {
    projectUpstreamStreamStarted[target] = false;
  }
}

function expandRemoteWorkspaceUriVariants(uriStr) {
  const clean = String(uriStr || '').replace(/\/+$/, '');
  if (!clean) return [];
  const variants = new Set([clean]);
  const homePrefix = `file://${(sshState.remoteHomeDir || '/home/user').replace(/\/+$/, '')}/`;
  if (clean.startsWith(homePrefix)) {
    variants.add('file:///develop/' + clean.slice(homePrefix.length));
  } else if (clean.startsWith('file:///develop/')) {
    variants.add(homePrefix + clean.slice('file:///develop/'.length));
  }
  return [...variants];
}

function extractAllWorkspaceUris(summaryObj) {
  if (!summaryObj || typeof summaryObj !== 'object') return [];
  const rawList = [];
  if (Array.isArray(summaryObj.trajectoryMetadata?.workspaceUris)) {
    rawList.push(...summaryObj.trajectoryMetadata.workspaceUris);
  }
  if (Array.isArray(summaryObj.workspaceUris)) {
    rawList.push(...summaryObj.workspaceUris);
  }
  if (Array.isArray(summaryObj.workspaces)) {
    for (const w of summaryObj.workspaces) {
      if (w?.workspaceFolderAbsoluteUri) rawList.push(w.workspaceFolderAbsoluteUri);
    }
  }
  if (Array.isArray(summaryObj.trajectoryMetadata?.workspaces)) {
    for (const w of summaryObj.trajectoryMetadata.workspaces) {
      if (w?.workspaceFolderAbsoluteUri) rawList.push(w.workspaceFolderAbsoluteUri);
    }
  }
  const seen = new Set();
  const out = [];
  for (const u of rawList) {
    const clean = String(u || '').replace(/\/+$/, '');
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

function resolveRemoteSummaryProjectId(summaryObj) {
  if (!summaryObj || typeof summaryObj !== 'object') return REMOTE_DEFAULT_PROJECT_ALIAS;
  const existingPid = summaryObj.trajectoryMetadata?.projectId;
  if (
    existingPid &&
    existingPid !== 'default-cli-project' &&
    existingPid !== 'outside-of-project' &&
    remoteProjectIdsSet.has(existingPid)
  ) {
    return existingPid;
  }

  const wsUris = extractAllWorkspaceUris(summaryObj);
  if (wsUris.length > 0) {
    let bestPid = '';
    let bestLen = -1;

    // Pick the longest matching remote project folderUri prefix across all workspace URIs
    for (const wsUri of wsUris) {
      const wsVariants = expandRemoteWorkspaceUriVariants(wsUri);
      for (const [pid, proj] of remoteProjectsMap.entries()) {
        if (pid === REMOTE_DEFAULT_PROJECT_ALIAS) continue;
        const folderUri = getProjectFolderUri(proj);
        if (!folderUri) continue;
        for (const candidateWs of wsVariants) {
          if (candidateWs === folderUri || candidateWs.startsWith(folderUri + '/')) {
            if (folderUri.length > bestLen) {
              bestLen = folderUri.length;
              bestPid = pid;
            }
          }
        }
      }
    }
    if (bestPid) {
      return bestPid;
    }
  }

  if (existingPid && existingPid !== 'default-cli-project' && existingPid !== 'outside-of-project') {
    return existingPid;
  }
  return REMOTE_DEFAULT_PROJECT_ALIAS;
}

function resolveLocalSummaryProjectId(summaryObj) {
  if (!summaryObj || typeof summaryObj !== 'object') return 'default-cli-project';
  const existingPid = summaryObj.trajectoryMetadata?.projectId;
  if (existingPid === 'outside-of-project') {
    return 'outside-of-project';
  }
  if (
    existingPid &&
    existingPid !== 'default-cli-project' &&
    localProjectIdsSet.has(existingPid)
  ) {
    return existingPid;
  }

  const wsUris = extractAllWorkspaceUris(summaryObj);
  if (wsUris.length > 0) {
    let bestPid = '';
    let bestLen = -1;
    for (const wsUri of wsUris) {
      for (const [pid, proj] of localProjectsMap.entries()) {
        if (pid === 'default-cli-project') continue;
        const folderUri = getProjectFolderUri(proj);
        if (!folderUri) continue;
        if (wsUri === folderUri || wsUri.startsWith(folderUri + '/')) {
          if (folderUri.length > bestLen) {
            bestLen = folderUri.length;
            bestPid = pid;
          }
        }
      }
    }
    if (bestPid) {
      return bestPid;
    }
  }

  if (existingPid) {
    return existingPid;
  }
  return 'default-cli-project';
}

function sqlTimeToIso(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s || s.startsWith('0001-01-01')) return '';
  if (s.endsWith('Z') && s.includes('T')) return s;
  return s
    .replace(' ', 'T')
    .replace(/\+00:00$/, 'Z')
    .replace(/\+00$/, 'Z');
}

function buildSummaryFromCliMeta(cid, cliMeta, isRemote = true) {
  const defaultUri = isRemote
    ? `file://${sshState.remoteHomeDir || '/home/user'}`
    : `file://${os.homedir()}`;
  const wsUris = Array.isArray(cliMeta?.workspaceUris) && cliMeta.workspaceUris.length
    ? cliMeta.workspaceUris
    : [defaultUri];
  const modIso = sqlTimeToIso(cliMeta?.lastModifiedTime) || new Date().toISOString();
  const inputIso = sqlTimeToIso(cliMeta?.lastUserInputTime) || modIso;
  const titleText = String(cliMeta?.title || '').trim();
  const previewText = String(cliMeta?.preview || '').trim();
  const summaryText = titleText || previewText || `Session ${String(cid).slice(0, 8)}`;

  const base = {
    summary: summaryText,
    stepCount: Number(cliMeta?.stepCount || 1),
    lastModifiedTime: modIso,
    trajectoryId: cid,
    status: cliMeta?.status || 'CASCADE_RUN_STATUS_IDLE',
    createdTime: inputIso,
    workspaces: wsUris.map((u) => ({
      workspaceFolderAbsoluteUri: u,
      repository: {},
    })),
    lastUserInputTime: inputIso,
    lastUserInputStepIndex: cliMeta?.lastUserInputStepIndex >= 0 ? cliMeta.lastUserInputStepIndex : 0,
    annotations: {
      ...(titleText ? {title: titleText} : {}),
    },
    trajectoryMetadata: {
      workspaces: wsUris.map((u) => ({
        workspaceFolderAbsoluteUri: u,
        repository: {},
      })),
      createdAt: inputIso,
      rootConversationId: cliMeta?.parentConversationId || cid,
      workspaceUris: wsUris,
      projectId: cliMeta?.projectId || (isRemote ? REMOTE_DEFAULT_PROJECT_ALIAS : 'default-cli-project'),
      ...(cliMeta?.parentConversationId ? {parentConversationId: cliMeta.parentConversationId} : {}),
    },
    trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE',
    latestExecutorTerminationReason: 'EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL',
  };
  if (cliMeta?.notFullyIdle) base.notFullyIdle = true;
  if (cliMeta?.killed) base.killed = true;
  return base;
}

function enrichSummaryWithCliMeta(summary, cid, cliMeta, isRemote = true) {
  if (!summary || typeof summary !== 'object') return summary;
  const out = {...summary};
  const pbtxtTitle = cid
    ? (isRemote ? remotePbtxtTitlesMap.get(cid) : localPbtxtTitlesMap.get(cid)) || ''
    : '';
  const isArchived =
    Boolean(out.annotations?.archived) ||
    (cid ? (isRemote ? remoteArchivedIdsSet.has(cid) : localArchivedIdsSet.has(cid)) : false);

  const titleText = String(cliMeta?.title || pbtxtTitle || '').trim();
  if (titleText) {
    const finalTitle = out.annotations?.title || titleText;
    out.annotations = {
      ...(out.annotations || {}),
      title: finalTitle,
    };
    if (
      !out.summary ||
      summary.source === 'CORTEX_TRAJECTORY_SOURCE_CLI' ||
      (cliMeta?.preview && out.summary === cliMeta.preview)
    ) {
      out.summary = finalTitle;
    }
  } else if (!out.summary && cliMeta?.preview) {
    out.summary = cliMeta.preview;
  }

  if (isArchived) {
    out.annotations = {
      ...(out.annotations || {}),
      archived: true,
    };
  }

  if (!cliMeta) return out;
  if (Number(cliMeta.stepCount || 0) > Number(out.stepCount || 0)) {
    out.stepCount = Number(cliMeta.stepCount);
  }
  const cliModIso = sqlTimeToIso(cliMeta.lastModifiedTime);
  if (cliModIso && (!out.lastModifiedTime || cliModIso > out.lastModifiedTime)) {
    out.lastModifiedTime = cliModIso;
  }
  const cliInputIso = sqlTimeToIso(cliMeta.lastUserInputTime);
  if (cliInputIso && (!out.lastUserInputTime || cliInputIso > out.lastUserInputTime)) {
    out.lastUserInputTime = cliInputIso;
  }
  if (cliMeta.status && (out.status === 'CASCADE_RUN_STATUS_UNSPECIFIED' || !out.status || cliMeta.notFullyIdle)) {
    out.status = cliMeta.status;
  }
  if (cliMeta.parentConversationId && !out.trajectoryMetadata?.parentConversationId) {
    out.trajectoryMetadata = {
      ...(out.trajectoryMetadata || {}),
      parentConversationId: cliMeta.parentConversationId,
    };
  }
  return out;
}

function shouldOmitSummary(summary, cid = '', isRemote = true) {
  if (!summary || typeof summary !== 'object') return true;
  const resolvedCid = cid || summary?.trajectoryMetadata?.rootConversationId || summary?.trajectoryId || '';
  if (!resolvedCid) return false;
  const deletedSet = isRemote ? remoteDeletedIdsSet : localDeletedIdsSet;
  if (deletedSet.has(resolvedCid)) return true;

  const isSubagent =
    Boolean(summary?.trajectoryMetadata?.parentConversationId) ||
    Number(summary?.trajectoryMetadata?.nestingDepth || 0) > 0;
  if (isSubagent) return false;

  const cliMeta = isRemote ? remoteCliSummariesMap.get(resolvedCid) : localCliSummariesMap.get(resolvedCid);
  const pbtxtTitle = (isRemote ? remotePbtxtTitlesMap.get(resolvedCid) : localPbtxtTitlesMap.get(resolvedCid)) || '';
  const stepCount = Math.max(Number(summary?.stepCount || 0), Number(cliMeta?.stepCount || 0));
  const hasAnyTitleOrPreview = Boolean(
    String(summary?.summary || '').trim() ||
    String(summary?.annotations?.title || '').trim() ||
    String(pbtxtTitle || '').trim() ||
    String(cliMeta?.title || '').trim() ||
    String(cliMeta?.preview || '').trim()
  );
  // Drop empty/untitled CLI stubs (e.g., stepCount === 0 or no title/preview) so "Untitled Conversation" never pollutes the sidebar
  if (stepCount <= 0 && !hasAnyTitleOrPreview) return true;
  if (summary?.source && ALLOWED_NON_JETBOX_SOURCES.has(summary.source) && !hasAnyTitleOrPreview) return true;
  return false;
}

function normalizeRemoteSingleSummary(summary, cid = '') {
  if (!summary || typeof summary !== 'object') return summary;
  const resolvedCid = cid || summary?.trajectoryMetadata?.rootConversationId || summary?.trajectoryId || '';
  const cliMeta = resolvedCid ? remoteCliSummariesMap.get(resolvedCid) : null;
  const enriched = enrichSummaryWithCliMeta(summary, resolvedCid, cliMeta, true);
  const targetPid = resolveRemoteSummaryProjectId(enriched);
  const proj = remoteProjectsMap.get(targetPid);
  const fallbackUri =
    getProjectFolderUri(proj) ||
    `file://${sshState.remoteHomeDir || '/home/user'}`;
  const existingUris =
    Array.isArray(enriched?.trajectoryMetadata?.workspaceUris) &&
    enriched.trajectoryMetadata.workspaceUris.length
      ? enriched.trajectoryMetadata.workspaceUris
      : Array.isArray(cliMeta?.workspaceUris) && cliMeta.workspaceUris.length
        ? cliMeta.workspaceUris
        : enriched?.workspaces?.[0]?.workspaceFolderAbsoluteUri
          ? [enriched.workspaces[0].workspaceFolderAbsoluteUri]
          : [fallbackUri];

  const out = {
    ...enriched,
    trajectoryMetadata: {
      ...(enriched?.trajectoryMetadata || {}),
      projectId: targetPid,
      workspaceUris: existingUris,
    },
  };
  // Always strip source (including CORTEX_TRAJECTORY_SOURCE_CLI) so Antigravity Desktop's
  // rna(c.source) treats CLI-spawned sessions as indexed sidebar sessions rather than hidden external ones.
  if ('source' in out) {
    delete out.source;
  }
  if (out.trajectoryMetadata?.sourceMetadata?.hideFromConversationList) {
    delete out.trajectoryMetadata.sourceMetadata.hideFromConversationList;
  }
  return out;
}

function normalizeLocalSingleSummary(summary, cid = '') {
  if (!summary || typeof summary !== 'object') return summary;
  const resolvedCid = cid || summary?.trajectoryMetadata?.rootConversationId || summary?.trajectoryId || '';
  const cliMeta = resolvedCid ? localCliSummariesMap.get(resolvedCid) : null;
  const enriched = enrichSummaryWithCliMeta(summary, resolvedCid, cliMeta, false);
  const targetPid = resolveLocalSummaryProjectId(enriched);
  const proj = localProjectsMap.get(targetPid);
  const fallbackUri = getProjectFolderUri(proj) || `file://${os.homedir()}`;
  const existingUris =
    Array.isArray(enriched?.trajectoryMetadata?.workspaceUris) &&
    enriched.trajectoryMetadata.workspaceUris.length
      ? enriched.trajectoryMetadata.workspaceUris
      : Array.isArray(cliMeta?.workspaceUris) && cliMeta.workspaceUris.length
        ? cliMeta.workspaceUris
        : enriched?.workspaces?.[0]?.workspaceFolderAbsoluteUri
          ? [enriched.workspaces[0].workspaceFolderAbsoluteUri]
          : [fallbackUri];

  const out = {
    ...enriched,
    trajectoryMetadata: {
      ...(enriched?.trajectoryMetadata || {}),
      projectId: targetPid,
      workspaceUris: existingUris,
    },
  };
  if ('source' in out) {
    delete out.source;
  }
  if (out.trajectoryMetadata?.sourceMetadata?.hideFromConversationList) {
    delete out.trajectoryMetadata.sourceMetadata.hideFromConversationList;
  }
  return out;
}

function computeSummarySig(norm) {
  if (!norm || typeof norm !== 'object') return '';
  return JSON.stringify([
    norm.summary || '',
    norm.annotations?.title || '',
    Boolean(norm.annotations?.archived),
    norm.stepCount || 0,
    norm.status || '',
    norm.lastModifiedTime || '',
    norm.trajectoryMetadata?.projectId || '',
    norm.trajectoryMetadata?.parentConversationId || '',
  ]);
}

function isShadowCloudCid(cid) {
  const s = String(cid || '');
  return s.startsWith('v1/') || s.includes('jetski_remote_agents_3p/');
}

function isCloudSummary(summary, cid = '') {
  if (!summary || typeof summary !== 'object') return false;
  return (
    summary.cloud === true ||
    summary.trajectoryMetadata?.cloud === true ||
    isShadowCloudCid(cid) ||
    isShadowCloudCid(summary.trajectoryId)
  );
}

function getSummaryCreatedKey(summary) {
  if (!summary || typeof summary !== 'object') return '';
  const pid = String(summary.trajectoryMetadata?.projectId || '').trim();
  const ctime = String(summary.createdTime || summary.trajectoryMetadata?.createdAt || '').trim();
  if (!pid || !ctime) return '';
  return `${pid}|${ctime}`;
}

function dedupeCloudSummaries(summariesMap) {
  if (!summariesMap || typeof summariesMap !== 'object') return summariesMap;
  const out = {...summariesMap};

  const clientKeyToUuid = new Map();
  const knownClientUuids = new Set();
  const allSources = [cachedLocalSummaryUpdates, cachedRemoteSummaryUpdates, out];
  for (const src of allSources) {
    if (!src || typeof src !== 'object') continue;
    for (const [cid, sum] of Object.entries(src)) {
      if (!sum || isShadowCloudCid(cid)) continue;
      if (isCloudSummary(sum, cid)) {
        knownClientUuids.add(cid);
        const key = getSummaryCreatedKey(sum);
        if (key && !clientKeyToUuid.has(key)) {
          clientKeyToUuid.set(key, cid);
        }
      }
    }
  }

  for (const [cid, sum] of Object.entries(out)) {
    if (!isShadowCloudCid(cid)) continue;
    const suffixUuid = String(cid).split('/').pop() || '';
    const key = getSummaryCreatedKey(sum);
    const matchedClientCid =
      (suffixUuid && knownClientUuids.has(suffixUuid) ? suffixUuid : '') ||
      (key && clientKeyToUuid.get(key)) ||
      '';
    if (matchedClientCid && matchedClientCid !== cid) {
      const existingClient =
        out[matchedClientCid] ||
        cachedLocalSummaryUpdates[matchedClientCid] ||
        cachedRemoteSummaryUpdates[matchedClientCid];
      if (existingClient && sum) {
        const mergedClient = {
          ...existingClient,
          summary: existingClient.summary || sum.summary,
          stepCount: Math.max(Number(existingClient.stepCount || 0), Number(sum.stepCount || 0)),
          lastModifiedTime:
            (sum.lastModifiedTime || '') > (existingClient.lastModifiedTime || '')
              ? sum.lastModifiedTime
              : existingClient.lastModifiedTime,
        };
        if (matchedClientCid in out) out[matchedClientCid] = mergedClient;
        if (matchedClientCid in cachedLocalSummaryUpdates) cachedLocalSummaryUpdates[matchedClientCid] = mergedClient;
        if (matchedClientCid in cachedRemoteSummaryUpdates) cachedRemoteSummaryUpdates[matchedClientCid] = mergedClient;
      }
      delete out[cid];
      delete cachedRemoteSummaryUpdates[cid];
      delete cachedLocalSummaryUpdates[cid];
      lastPushedRemoteSummarySig.delete(cid);
      lastPushedLocalSummarySig.delete(cid);
    }
  }
  return out;
}

function transformRemoteSummariesObject(jsonObj) {
  if (!jsonObj || typeof jsonObj !== 'object') return jsonObj;
  const clone = {...jsonObj};
  if (clone.updates && typeof clone.updates === 'object') {
    const newUpdates = {};
    for (const [cid, summary] of Object.entries(clone.updates)) {
      remoteCascadeIds.add(cid);
      rawRemoteSummaries[cid] = summary;
      if (shouldOmitSummary(summary, cid, true)) {
        delete cachedRemoteSummaryUpdates[cid];
        lastPushedRemoteSummarySig.delete(cid);
        continue;
      }
      const norm = normalizeRemoteSingleSummary(summary, cid);
      newUpdates[cid] = norm;
      cachedRemoteSummaryUpdates[cid] = norm;
      lastPushedRemoteSummarySig.set(cid, computeSummarySig(norm));
    }
    clone.updates = dedupeCloudSummaries(newUpdates);
  }
  if (clone.trajectorySummaries && typeof clone.trajectorySummaries === 'object') {
    const newMap = {};
    for (const [cid, summary] of Object.entries(clone.trajectorySummaries)) {
      remoteCascadeIds.add(cid);
      rawRemoteSummaries[cid] = summary;
      if (shouldOmitSummary(summary, cid, true)) {
        delete cachedRemoteSummaryUpdates[cid];
        lastPushedRemoteSummarySig.delete(cid);
        continue;
      }
      const norm = normalizeRemoteSingleSummary(summary, cid);
      newMap[cid] = norm;
      cachedRemoteSummaryUpdates[cid] = norm;
      lastPushedRemoteSummarySig.set(cid, computeSummarySig(norm));
    }
    clone.trajectorySummaries = dedupeCloudSummaries(newMap);
  }
  return clone;
}

function recordLocalSummariesObject(jsonObj) {
  if (!jsonObj || typeof jsonObj !== 'object') return jsonObj;
  if (jsonObj.updates && typeof jsonObj.updates === 'object') {
    const newUpdates = {};
    for (const [cid, summary] of Object.entries(jsonObj.updates)) {
      localCascadeIds.add(cid);
      rawLocalSummaries[cid] = summary;
      if (shouldOmitSummary(summary, cid, false)) {
        delete cachedLocalSummaryUpdates[cid];
        lastPushedLocalSummarySig.delete(cid);
        continue;
      }
      const norm = normalizeLocalSingleSummary(summary, cid);
      newUpdates[cid] = norm;
      cachedLocalSummaryUpdates[cid] = norm;
      lastPushedLocalSummarySig.set(cid, computeSummarySig(norm));
      const pid = norm?.trajectoryMetadata?.projectId;
      if (pid) localCascadeProjectMap.set(cid, pid);
    }
    jsonObj.updates = dedupeCloudSummaries(newUpdates);
  }
  if (jsonObj.trajectorySummaries && typeof jsonObj.trajectorySummaries === 'object') {
    const newMap = {};
    for (const [cid, summary] of Object.entries(jsonObj.trajectorySummaries)) {
      localCascadeIds.add(cid);
      rawLocalSummaries[cid] = summary;
      if (shouldOmitSummary(summary, cid, false)) {
        delete cachedLocalSummaryUpdates[cid];
        lastPushedLocalSummarySig.delete(cid);
        continue;
      }
      const norm = normalizeLocalSingleSummary(summary, cid);
      newMap[cid] = norm;
      cachedLocalSummaryUpdates[cid] = norm;
      lastPushedLocalSummarySig.set(cid, computeSummarySig(norm));
      const pid = norm?.trajectoryMetadata?.projectId;
      if (pid) localCascadeProjectMap.set(cid, pid);
    }
    jsonObj.trajectorySummaries = dedupeCloudSummaries(newMap);
  }
  return jsonObj;
}

function decodePbtxtTitle(rawTxt) {
  if (!rawTxt) return '';
  const m = rawTxt.match(/title:\s*"((?:\\.|[^"\\])*)"/);
  if (!m) return '';
  const raw = m[1];
  const bytes = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length) {
      const nxt = raw[i + 1];
      if (nxt >= '0' && nxt <= '7' && i + 3 < raw.length && /^[0-7]{3}$/.test(raw.slice(i + 1, i + 4))) {
        bytes.push(parseInt(raw.slice(i + 1, i + 4), 8));
        i += 3;
        continue;
      }
      if (nxt === 'n') bytes.push(10);
      else if (nxt === 'r') bytes.push(13);
      else if (nxt === 't') bytes.push(9);
      else bytes.push(...Buffer.from(nxt, 'utf8'));
      i += 1;
    } else {
      bytes.push(...Buffer.from(ch, 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8').trim();
}

function loadLocalDeletedConversations() {
  try {
    if (fs.existsSync(LOCAL_DELETED_TOMBSTONES_PATH)) {
      const arr = JSON.parse(fs.readFileSync(LOCAL_DELETED_TOMBSTONES_PATH, 'utf8'));
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch {}
  return new Set();
}

function deleteLocalCliConversation(cid) {
  if (!cid || !/^[0-9a-f-]{36}$/i.test(String(cid))) return;
  lastLocalCliSummariesSig = '';
  cachedLocalCliSummariesResult = null;
  const deleted = loadLocalDeletedConversations();
  deleted.add(cid);
  try {
    fs.mkdirSync(CACHE_DIR, {recursive: true});
    fs.writeFileSync(LOCAL_DELETED_TOMBSTONES_PATH, JSON.stringify([...deleted]), 'utf8');
  } catch {}
  const home = os.homedir();
  for (const storeName of ['antigravity-cli', 'antigravity']) {
    const root = path.join(home, '.gemini', storeName);
    for (const ext of ['.db', '.db-wal', '.db-shm', '.pb']) {
      const p = path.join(root, 'conversations', `${cid}${ext}`);
      try {
        if (fs.lstatSync(p)) fs.unlinkSync(p);
      } catch {}
    }
    const dbPath = path.join(root, 'conversation_summaries.db');
    if (fs.existsSync(dbPath)) {
      let db = null;
      try {
        db = new DatabaseSync(dbPath);
        db.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(cid);
      } catch {} finally {
        try { db?.close(); } catch {}
      }
    }
  }
}

const pbtxtTitleCache = new Map(); // filePath -> { mtimeMs, title, archived }
const realpathMemoCache = new Map(); // fsPath -> realP
let lastLocalCliSummariesSig = '';
let cachedLocalCliSummariesResult = null;

function expandLocalWorkspaceUris(wsUris) {
  const out = [];
  const seen = new Set();
  for (const rawU of wsUris || []) {
    if (typeof rawU !== 'string') continue;
    const clean = rawU.replace(/\/+$/, '');
    if (!clean) continue;
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
    if (clean.startsWith('file:///')) {
      try {
        const fsPath = decodeURIComponent(clean.slice(7));
        let realP = realpathMemoCache.get(fsPath);
        if (realP === undefined) {
          realP = fs.realpathSync(fsPath).replace(/\/+$/, '');
          if (realpathMemoCache.size > 512) realpathMemoCache.clear();
          realpathMemoCache.set(fsPath, realP);
        }
        if (realP && realP !== fsPath) {
          const realU = `file://${realP}`;
          if (!seen.has(realU)) {
            seen.add(realU);
            out.push(realU);
          }
        }
      } catch {}
    }
  }
  return out;
}

const ALLOWED_NON_JETBOX_SOURCES = new Set([
  'CORTEX_TRAJECTORY_SOURCE_CLI',
  'CORTEX_TRAJECTORY_SOURCE_AGENT_API',
  'CORTEX_TRAJECTORY_SOURCE_SDK',
  'CORTEX_TRAJECTORY_SOURCE_INTERACTIVE_CASCADE',
]);

function statSigFast(p) {
  try {
    const st = fs.statSync(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '0';
  }
}

export function syncLocalCliStoreAndReadSummaries() {
  const home = os.homedir();
  const cliRoot = path.join(home, '.gemini', 'antigravity-cli');
  const appRoot = path.join(home, '.gemini', 'antigravity');
  const summaries = {};
  if (!fs.existsSync(cliRoot) && !fs.existsSync(appRoot)) return summaries;

  const cliConv = path.join(cliRoot, 'conversations');
  const appConv = path.join(appRoot, 'conversations');
  const cliBrain = path.join(cliRoot, 'brain');
  const appBrain = path.join(appRoot, 'brain');
  const cliAnn = path.join(cliRoot, 'annotations');
  const appAnn = path.join(appRoot, 'annotations');
  const cliDb = path.join(cliRoot, 'conversation_summaries.db');
  const appDb = path.join(appRoot, 'conversation_summaries.db');

  const currentStoreSig = [
    statSigFast(cliConv),
    statSigFast(appConv),
    statSigFast(cliBrain),
    statSigFast(cliAnn),
    statSigFast(appAnn),
    statSigFast(cliDb),
    statSigFast(`${cliDb}-wal`),
    statSigFast(appDb),
    statSigFast(`${appDb}-wal`),
    statSigFast(LOCAL_DELETED_TOMBSTONES_PATH),
  ].join('|');

  if (cachedLocalCliSummariesResult && currentStoreSig === lastLocalCliSummariesSig) {
    return cachedLocalCliSummariesResult;
  }

  const deletedSet = loadLocalDeletedConversations();

  // 1. Symlink .db/.pb files one-way from antigravity-cli/conversations -> antigravity/conversations & prune broken symlinks
  for (const convDir of [cliConv, appConv]) {
    if (!fs.existsSync(convDir)) continue;
    try {
      for (const name of fs.readdirSync(convDir)) {
        const p = path.join(convDir, name);
        try {
          const st = fs.lstatSync(p);
          if (st.isSymbolicLink() && !fs.existsSync(p)) {
            fs.unlinkSync(p);
          }
        } catch {}
      }
    } catch {}
  }
  const existingConvIds = new Set();
  if (fs.existsSync(cliConv)) {
    try { fs.mkdirSync(appConv, {recursive: true}); } catch {}
    try {
      const dstNames = fs.readdirSync(appConv);
      const dstSet = new Set(dstNames);
      for (const n of dstNames) {
        if (n.endsWith('.db') || n.endsWith('.pb')) existingConvIds.add(n.slice(0, -3));
      }
      for (const name of fs.readdirSync(cliConv)) {
        if (!(name.endsWith('.db') || name.endsWith('.pb')) || name.startsWith('conversation_summaries.')) continue;
        const stem = name.slice(0, -3);
        if (deletedSet.has(stem)) continue;
        const srcPath = path.join(cliConv, name);
        if (!fs.existsSync(srcPath)) continue;
        existingConvIds.add(stem);
        if (!dstSet.has(name)) {
          const dstPath = path.join(appConv, name);
          try { fs.symlinkSync(srcPath, dstPath); } catch {}
        }
      }
    } catch {}
  } else if (fs.existsSync(appConv)) {
    try {
      for (const n of fs.readdirSync(appConv)) {
        if (n.endsWith('.db') || n.endsWith('.pb')) existingConvIds.add(n.slice(0, -3));
      }
    } catch {}
  }

  // 2. Symlink brain/<cid> directories one-way from antigravity-cli -> antigravity
  if (fs.existsSync(cliBrain)) {
    try { fs.mkdirSync(appBrain, {recursive: true}); } catch {}
    try {
      const dstSet = new Set(fs.readdirSync(appBrain));
      for (const name of fs.readdirSync(cliBrain)) {
        if (deletedSet.has(name)) continue;
        if (!dstSet.has(name) && /^[0-9a-f-]{36}$/i.test(name)) {
          const srcPath = path.join(cliBrain, name);
          if (fs.existsSync(srcPath)) {
            try { fs.symlinkSync(srcPath, path.join(appBrain, name)); } catch {}
          }
        }
      }
    } catch {}
  }

  // 3. Sync annotations/<cid>.pbtxt and collect titles & archived status (appAnn takes precedence over cliAnn)
  const pbtxtTitles = {};
  const pbtxtArchived = new Set();
  for (const [storeIdx, annDir] of [cliAnn, appAnn].entries()) {
    if (!fs.existsSync(annDir)) continue;
    try {
      for (const name of fs.readdirSync(annDir)) {
        if (!name.endsWith('.pbtxt')) continue;
        const cid = name.slice(0, -6);
        const fullAnnPath = path.join(annDir, name);
        try {
          const st = fs.statSync(fullAnnPath);
          let cachedAnn = pbtxtTitleCache.get(fullAnnPath);
          if (!cachedAnn || cachedAnn.mtimeMs !== st.mtimeMs) {
            const txt = fs.readFileSync(fullAnnPath, 'utf8');
            cachedAnn = {
              mtimeMs: st.mtimeMs,
              title: decodePbtxtTitle(txt),
              archivedTrue: /\barchived:\s*true\b/.test(txt),
              archivedFalse: /\barchived:\s*false\b/.test(txt),
            };
            pbtxtTitleCache.set(fullAnnPath, cachedAnn);
          }
          if (cachedAnn.title) pbtxtTitles[cid] = cachedAnn.title;
          if (cachedAnn.archivedTrue) pbtxtArchived.add(cid);
          else if (storeIdx === 1 && cachedAnn.archivedFalse) pbtxtArchived.delete(cid);
        } catch {}
      }
    } catch {}
  }
  if (fs.existsSync(cliAnn)) {
    try { fs.mkdirSync(appAnn, {recursive: true}); } catch {}
    try {
      for (const name of fs.readdirSync(cliAnn)) {
        if (!name.endsWith('.pbtxt')) continue;
        if (deletedSet.has(name.slice(0, -6))) continue;
        const srcPath = path.join(cliAnn, name);
        const dstPath = path.join(appAnn, name);
        try {
          const srcTxt = fs.readFileSync(srcPath, 'utf8');
          if (!fs.existsSync(dstPath)) {
            fs.copyFileSync(srcPath, dstPath);
          } else {
            const dstTxt = fs.readFileSync(dstPath, 'utf8');
            const mTitleLine = srcTxt.match(/^(title:\s*"(?:\\.|[^"\\])*")/m);
            if (mTitleLine && !dstTxt.includes('title:')) {
              fs.writeFileSync(dstPath, `${mTitleLine[1]}\n${dstTxt}`, 'utf8');
            }
          }
        } catch {}
      }
    } catch {}
  }

  localArchivedIdsSet.clear();
  for (const cid of pbtxtArchived) localArchivedIdsSet.add(cid);
  localDeletedIdsSet.clear();
  for (const cid of deletedSet) localDeletedIdsSet.add(cid);
  localPbtxtTitlesMap.clear();
  for (const [cid, t] of Object.entries(pbtxtTitles)) localPbtxtTitlesMap.set(cid, t);

  // 4. Read CLI conversation_summaries.db using SELECT * so future schema changes never break queries
  for (const storeName of ['antigravity-cli', 'antigravity']) {
    const dbPath = path.join(home, '.gemini', storeName, 'conversation_summaries.db');
    if (!fs.existsSync(dbPath)) continue;
    let db = null;
    try {
      db = new DatabaseSync(dbPath, {open: true, readOnly: true});
      const rows = db.prepare('SELECT * FROM conversation_summaries').all();
      for (const r of rows) {
        const cid = String(r.conversation_id || r.id || '').trim();
        if (!cid) continue;
        if (Boolean(r.archived)) {
          localArchivedIdsSet.add(cid);
          continue;
        }
        if (pbtxtArchived.has(cid) || deletedSet.has(cid)) continue;
        const hasFile =
          existingConvIds.has(cid) ||
          [appConv, cliConv].some(
            (cdir) =>
              fs.existsSync(path.join(cdir, `${cid}.db`)) ||
              fs.existsSync(path.join(cdir, `${cid}.pb`))
          );
        if (!hasFile) continue;
        const stepCount = Number(r.step_count ?? 1);
        if (stepCount <= 0) continue;
        const source = String(r.source || '');
        if (storeName !== 'antigravity-cli' && !ALLOWED_NON_JETBOX_SOURCES.has(source)) continue;
        if (source === 'CORTEX_TRAJECTORY_SOURCE_SUBAGENT') continue;
        const parentConversationId = String(r.parent_conversation_id || '').trim();
        const nestingDepth = Number(r.nesting_depth || 0);
        if (parentConversationId || nestingDepth > 0) continue;

        const title = pbtxtTitles[cid] || String(r.title || '').trim() || '';
        const preview = String(r.preview || r.summary || '').trim();
        if (!title && !preview) continue;
        const lastModifiedTime = String(r.last_modified_time || '');
        let workspaceUris = [];
        try {
          const parsed = JSON.parse(r.workspace_uris || '[]');
          if (Array.isArray(parsed)) workspaceUris = parsed;
        } catch {}
        workspaceUris = expandLocalWorkspaceUris(workspaceUris);
        const status = String(r.status || 'CASCADE_RUN_STATUS_IDLE');
        const projectId = String(r.project_id || '');
        const agentName = String(r.agent_name || '');
        const notFullyIdle = Boolean(r.not_fully_idle);
        const killed = Boolean(r.killed);
        const lastUserInputTime = String(r.last_user_input_time || '');
        const lastUserInputStepIndex = Number(r.last_user_input_step_index ?? -1);
        const isCli = storeName === 'antigravity-cli' || ALLOWED_NON_JETBOX_SOURCES.has(source);

        const prev = summaries[cid];
        if (prev) {
          summaries[cid] = {
            conversationId: cid,
            title: title || prev.title,
            preview: (storeName === 'antigravity-cli' && preview) ? preview : (prev.preview || preview),
            stepCount: Math.max(stepCount, prev.stepCount),
            lastModifiedTime: lastModifiedTime > prev.lastModifiedTime ? lastModifiedTime : prev.lastModifiedTime,
            workspaceUris: workspaceUris.length ? workspaceUris : prev.workspaceUris,
            status: status || prev.status,
            source: source || prev.source,
            projectId: (projectId && projectId !== 'default-cli-project') ? projectId : (prev.projectId || projectId),
            agentName: agentName || prev.agentName,
            parentConversationId: parentConversationId || prev.parentConversationId,
            nestingDepth: Math.max(nestingDepth, prev.nestingDepth),
            notFullyIdle: notFullyIdle || prev.notFullyIdle,
            killed: killed || prev.killed,
            lastUserInputTime: lastUserInputTime > prev.lastUserInputTime ? lastUserInputTime : prev.lastUserInputTime,
            lastUserInputStepIndex: Math.max(lastUserInputStepIndex, prev.lastUserInputStepIndex),
            isCli: isCli || prev.isCli,
          };
        } else {
          summaries[cid] = {
            conversationId: cid,
            title,
            preview,
            stepCount,
            lastModifiedTime,
            workspaceUris,
            status,
            source,
            projectId,
            agentName,
            parentConversationId,
            nestingDepth,
            notFullyIdle,
            killed,
            lastUserInputTime,
            lastUserInputStepIndex,
            isCli,
          };
        }
      }
    } catch {} finally {
      try { db?.close(); } catch {}
    }
  }
  lastLocalCliSummariesSig = [
    statSigFast(cliConv),
    statSigFast(appConv),
    statSigFast(cliBrain),
    statSigFast(cliAnn),
    statSigFast(appAnn),
    statSigFast(cliDb),
    statSigFast(`${cliDb}-wal`),
    statSigFast(appDb),
    statSigFast(`${appDb}-wal`),
    statSigFast(LOCAL_DELETED_TOMBSTONES_PATH),
  ].join('|');
  cachedLocalCliSummariesResult = summaries;
  return summaries;
}

export async function syncCliSummariesAndPushUpdates() {
  if (cliSummariesSyncInFlight) return;
  cliSummariesSyncInFlight = true;
  try {
    const changedUpdates = {};

    // 1. Local CLI + App store sync
    const localMap = syncLocalCliStoreAndReadSummaries();
    localCliSummariesMap.clear();
    for (const [cid, meta] of Object.entries(localMap)) {
      localCliSummariesMap.set(cid, meta);
      localCascadeIds.add(cid);
      const baseSummary = rawLocalSummaries[cid] || cachedLocalSummaryUpdates[cid] || buildSummaryFromCliMeta(cid, meta, false);
      const norm = normalizeLocalSingleSummary(baseSummary, cid);
      const sig = computeSummarySig(norm);
      if (lastPushedLocalSummarySig.get(cid) !== sig) {
        lastPushedLocalSummarySig.set(cid, sig);
        cachedLocalSummaryUpdates[cid] = norm;
        const pid = norm?.trajectoryMetadata?.projectId;
        if (pid) localCascadeProjectMap.set(cid, pid);
        changedUpdates[cid] = norm;
      }
    }
    for (const [cid, cached] of Object.entries(cachedLocalSummaryUpdates)) {
      if (localDeletedIdsSet.has(cid)) {
        delete cachedLocalSummaryUpdates[cid];
        lastPushedLocalSummarySig.delete(cid);
        continue;
      }
      if (localArchivedIdsSet.has(cid) && !cached?.annotations?.archived) {
        const updated = {
          ...cached,
          annotations: {
            ...(cached.annotations || {}),
            archived: true,
          },
        };
        cachedLocalSummaryUpdates[cid] = updated;
        lastPushedLocalSummarySig.set(cid, computeSummarySig(updated));
        changedUpdates[cid] = updated;
      }
    }

        // 2. Remote CLI + App store sync via bridge /cli-summaries
    if (sshState.status === 'connected') {
      const remoteRes = await fetchBridgeJson(`/cli-summaries?sig=${encodeURIComponent(lastRemoteCliSummariesBridgeSig)}`, 3000);
      if (remoteRes?.ok && !remoteRes.unchanged) {
        if (remoteRes.sig) lastRemoteCliSummariesBridgeSig = remoteRes.sig;
        if (Array.isArray(remoteRes.archivedIds)) {
          remoteArchivedIdsSet.clear();
          for (const cid of remoteRes.archivedIds) remoteArchivedIdsSet.add(cid);
        }
        if (Array.isArray(remoteRes.deletedIds)) {
          remoteDeletedIdsSet.clear();
          for (const cid of remoteRes.deletedIds) remoteDeletedIdsSet.add(cid);
        }
        if (remoteRes.titles && typeof remoteRes.titles === 'object') {
          remotePbtxtTitlesMap.clear();
          for (const [cid, t] of Object.entries(remoteRes.titles)) remotePbtxtTitlesMap.set(cid, t);
        }
        if (remoteRes.summaries && typeof remoteRes.summaries === 'object') {
          remoteCliSummariesMap.clear();
          for (const [cid, meta] of Object.entries(remoteRes.summaries)) {
            remoteCliSummariesMap.set(cid, meta);
            remoteCascadeIds.add(cid);
            const baseSummary = rawRemoteSummaries[cid] || cachedRemoteSummaryUpdates[cid] || buildSummaryFromCliMeta(cid, meta, true);
            const norm = normalizeRemoteSingleSummary(baseSummary, cid);
            const sig = computeSummarySig(norm);
            if (lastPushedRemoteSummarySig.get(cid) !== sig) {
              lastPushedRemoteSummarySig.set(cid, sig);
              cachedRemoteSummaryUpdates[cid] = norm;
              changedUpdates[cid] = norm;
            }
          }
        }
        for (const [cid, cached] of Object.entries(cachedRemoteSummaryUpdates)) {
          if (remoteDeletedIdsSet.has(cid)) {
            delete cachedRemoteSummaryUpdates[cid];
            lastPushedRemoteSummarySig.delete(cid);
            continue;
          }
          if (remoteArchivedIdsSet.has(cid) && !cached?.annotations?.archived) {
            const updated = {
              ...cached,
              annotations: {
                ...(cached.annotations || {}),
                archived: true,
              },
            };
            cachedRemoteSummaryUpdates[cid] = updated;
            lastPushedRemoteSummarySig.set(cid, computeSummarySig(updated));
            changedUpdates[cid] = updated;
          }
        }
      }
    }

    // 3. Push live updates to all connected JetboxSubscribeToSummaries streams
    if (Object.keys(changedUpdates).length > 0 && activeSummaryStreams.size > 0) {
      const frame = encodeDataFrame({updates: changedUpdates});
      for (const entry of [...activeSummaryStreams]) {
        if (!entry.res.writableEnded && !entry.res.destroyed) {
          try { entry.res.write(frame); } catch {}
        }
      }
    }
  } catch {} finally {
    cliSummariesSyncInFlight = false;
  }
}

function ensureCliSummariesWatcher() {
  if (cliSummariesIntervalTimer) return;
  cliSummariesIntervalTimer = setInterval(() => {
    if (activeSummaryStreams.size > 0) {
      syncCliSummariesAndPushUpdates().catch(() => {});
    }
  }, 3000);
  if (typeof cliSummariesIntervalTimer.unref === 'function') {
    cliSummariesIntervalTimer.unref();
  }
}

async function handleFederatedListProjects(req, res, parsedJson) {
  const backend = parsedJson?.backend;
  if (isEnterpriseBackend(backend)) {
    sendUnaryRpcResponse(req, res, {projectIds: []});
    return;
  }
  if (isCloudBackend(backend)) {
    const target = sshState.status === 'connected' ? 'remote' : 'local';
    const cRes = await callUpstreamUnaryJson(target, 'ListProjects', {backend}, 6500);
    const ids = Array.isArray(cRes?.projectIds)
      ? cRes.projectIds.filter((id) => id && !deletedProjectIdsSet.has(id))
      : [];
    syncCloudProjectIdsFromUpstreamList(ids);
    sendUnaryRpcResponse(req, res, {projectIds: ids});
    return;
  }
  const {mergedIds} = await refreshProjectFederation();
  sendUnaryRpcResponse(req, res, {projectIds: mergedIds});
}

async function handleFederatedReadProjects(req, res, parsedJson) {
  const requestedIds = Array.isArray(parsedJson?.ids) ? parsedJson.ids : [];
  if (localProjectsMap.size === 0 || remoteProjectsMap.size === 0) {
    await refreshProjectFederation();
  }

  const queryLocal = [];
  const queryRemote = [];
  for (const id of requestedIds) {
    if (deletedProjectIdsSet.has(id)) {
      evictProjectId(id);
      continue;
    }
    if (id === REMOTE_DEFAULT_PROJECT_ALIAS) {
      queryRemote.push('default-cli-project');
    } else if (cloudProjectIdsSet.has(id) || cloudProjectsMap.has(id)) {
      if (sshState.status === 'connected') queryRemote.push(id);
      else queryLocal.push(id);
    } else if (localProjectIdsSet.has(id) || localProjectsMap.has(id)) {
      queryLocal.push(id);
    } else if (remoteProjectIdsSet.has(id) || remoteProjectsMap.has(id)) {
      queryRemote.push(id);
    } else {
      queryLocal.push(id);
      queryRemote.push(id);
    }
  }

  let cloudUpdated = false;
  if (queryLocal.length || queryRemote.length) {
    const [lRes, rRes] = await Promise.all([
      queryLocal.length ? callUpstreamUnaryJson('local', 'ReadProjects', {ids: queryLocal}, 3500) : Promise.resolve(null),
      queryRemote.length ? callUpstreamUnaryJson('remote', 'ReadProjects', {ids: queryRemote}, 4500) : Promise.resolve(null),
    ]);
    if (Array.isArray(lRes?.notFoundIds)) {
      for (const nfId of lRes.notFoundIds) {
        localProjectsMap.delete(nfId);
        localProjectIdsSet.delete(nfId);
        if (!queryRemote.includes(nfId)) {
          cloudProjectsMap.delete(nfId);
          cloudProjectIdsSet.delete(nfId);
        }
      }
    }
    if (Array.isArray(rRes?.notFoundIds)) {
      for (const nfId of rRes.notFoundIds) {
        remoteProjectsMap.delete(nfId);
        remoteProjectIdsSet.delete(nfId);
        if (!queryLocal.includes(nfId)) {
          cloudProjectsMap.delete(nfId);
          cloudProjectIdsSet.delete(nfId);
        }
      }
    }
    if (Array.isArray(lRes?.projects)) {
      for (const p of lRes.projects) {
        if (p?.id && !deletedProjectIdsSet.has(p.id)) {
          if (isCloudProject(p) || cloudProjectIdsSet.has(p.id)) {
            registerCloudProject(p);
            cloudUpdated = true;
          } else {
            localProjectsMap.set(p.id, p);
            localProjectIdsSet.add(p.id);
          }
        }
      }
    }
    if (Array.isArray(rRes?.projects)) {
      for (const rawProj of rRes.projects) {
        if (rawProj?.id && !deletedProjectIdsSet.has(rawProj.id)) {
          if (isCloudProject(rawProj) || cloudProjectIdsSet.has(rawProj.id)) {
            registerCloudProject(rawProj);
            cloudUpdated = true;
          } else {
            const mapped = mapRemoteProjectObject(rawProj);
            remoteProjectsMap.set(mapped.id, mapped);
            remoteProjectIdsSet.add(mapped.id);
          }
        }
      }
    }
  }
  if (cloudUpdated) {
    emitState({});
  }

  const projects = [];
  const notFoundIds = [];
  for (const id of requestedIds) {
    if (deletedProjectIdsSet.has(id)) {
      notFoundIds.push(id);
    } else if (cloudProjectsMap.has(id)) {
      projects.push(cloudProjectsMap.get(id));
    } else if (localProjectsMap.has(id)) {
      projects.push(localProjectsMap.get(id));
    } else if (remoteProjectsMap.has(id)) {
      projects.push(remoteProjectsMap.get(id));
    } else {
      notFoundIds.push(id);
    }
  }
  sendUnaryRpcResponse(req, res, {projects, notFoundIds});
}

async function fetchLocalGitRepoInfosFallback(uris) {
  const repos = [];
  for (const rawUri of uris || []) {
    const uri = String(rawUri || '').replace(/\/+$/, '');
    if (!uri) continue;
    const repoPath = uri.startsWith('file://') ? decodeURIComponent(uri.slice(7)) : uri;
    try {
      const [{stdout: headOut}, {stdout: refsOut}] = await Promise.all([
        execFileAsync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {timeout: 3000}),
        execFileAsync('git', ['-C', repoPath, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'], {timeout: 3000}),
      ]);
      const curBranch = headOut.trim();
      const branches = [];
      let hasCur = false;
      for (const line of refsOut.split(/\r?\n/)) {
        const bname = line.trim();
        if (!bname) continue;
        if (bname === curBranch) {
          branches.push({name: bname, isCurrentBranch: true});
          hasCur = true;
        } else {
          branches.push({name: bname});
        }
      }
      if (curBranch && curBranch !== 'HEAD' && !hasCur) {
        branches.unshift({name: curBranch, isCurrentBranch: true});
      }
      repos.push({
        name: path.basename(repoPath) || repoPath,
        repoPath,
        branches,
        scmType: 'SCM_TYPE_GIT',
        repoUri: uri.startsWith('file://') ? uri : `file://${repoPath}`,
      });
    } catch {}
  }
  return repos;
}

let lastBridgeRepoInfosCache = new Map(); // uri -> { ts, repo }
const bridgeHttpAgent = new http.Agent({keepAlive: true, maxSockets: 8});

function fetchBridgeJson(urlPath, timeoutMs = 3500) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port: sshState.localBridgePort || 58284,
        path: urlPath,
        agent: bridgeHttpAgent,
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d.toString(); });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

function postBridgeJson(urlPath, payload = {}, timeoutMs = 3500) {
  return new Promise((resolve) => {
    const bodyBuf = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = http.request(
      {
        method: 'POST',
        hostname: '127.0.0.1',
        port: sshState.localBridgePort || 58284,
        path: urlPath,
        agent: bridgeHttpAgent,
        headers: {
          'content-type': 'application/json',
          'content-length': String(bodyBuf.length),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d.toString(); });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.end(bodyBuf);
  });
}

async function fetchRemoteGitRepoInfosFallback(uris) {
  if (!uris || uris.length === 0) return [];
  const q = uris.map(u => `uri=${encodeURIComponent(u)}`).join('&');
  const bridgeRes = await fetchBridgeJson(`/repo-infos?${q}`, 3500);
  if (Array.isArray(bridgeRes?.repos) && bridgeRes.repos.length > 0) {
    return bridgeRes.repos;
  }
  const host = sshState.activeHost || 'fei';
  const repos = [];
  for (const rawUri of uris) {
    const uri = String(rawUri || '').replace(/\/+$/, '');
    if (!uri) continue;
    const repoPath = uri.startsWith('file://') ? decodeURIComponent(uri.slice(7)) : uri;
    try {
      const pyScript = `import json, os, subprocess, sys; p = sys.argv[1]; u = sys.argv[2]; h = subprocess.run(["git", "-C", p, "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True, text=True, timeout=3); r = subprocess.run(["git", "-C", p, "for-each-ref", "--format=%(refname:short)", "refs/heads"], capture_output=True, text=True, timeout=3); cur = h.stdout.strip(); bs = [{"name": b.strip(), **({"isCurrentBranch": True} if b.strip() == cur else {})} for b in r.stdout.splitlines() if b.strip()]; print(json.dumps({"name": os.path.basename(p), "repoPath": p, "branches": bs, "scmType": "SCM_TYPE_GIT", "repoUri": u} if h.returncode == 0 else {}))`;
      const {stdout} = await execFileAsync(
        'ssh',
        ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', host, `python3 -c '${pyScript}' '${repoPath.replace(/'/g, "'\\''")}' '${uri.replace(/'/g, "'\\''")}'`],
        {timeout: 5000}
      );
      const parsed = JSON.parse(stdout.trim());
      if (parsed?.repoUri && Array.isArray(parsed.branches)) {
        repos.push(parsed);
      }
    } catch {}
  }
  return repos;
}

// Wait (bounded) for the SSH tunnel + remote language_server to become reachable. Right after an
// Antigravity update / window reload the frontend fires ResolveFolder/GetRepoInfos within ~3s, while the
// remote language_server may still be re-provisioning for the new version. Failing fast there poisons
// the frontend's per-project RTK cache (2.29.0+ caches resolveProjectResources by projectId, no refetch).
async function waitForRemoteConnected(maxMs = 15000) {
  const t0 = Date.now();
  while (sshState.status !== 'connected' && Date.now() - t0 < maxMs) {
    await new Promise((r) => setTimeout(r, 250));
  }
  return sshState.status === 'connected';
}

// Federated ResolveFolder for remote folders: wait for the tunnel, retry, and fall back to the bridge's
// git probe. Never answer a remote folder with a fabricated non-git type (the frontend would downgrade the
// persisted gitFolder resource via UpdateProject); on total failure we fall through to the plain forward.
async function handleFederatedResolveFolder(req, res, parsedJson, rawText) {
  const uri = String(parsedJson?.folderUri || '').replace(/\/+$/, '');
  if (!uri) return false;
  if (decideRpcTarget('ResolveFolder', req.headers, parsedJson, rawText) !== 'remote') return false;
  await waitForRemoteConnected(15000);
  let r = null;
  for (let i = 0; i < 3 && !(r && r.resourceType); i++) {
    if (i > 0) await new Promise((ok) => setTimeout(ok, 800));
    r = await callUpstreamUnaryJson('remote', 'ResolveFolder', {folderUri: uri}, 4500);
  }
  if (r && r.resourceType) {
    sendUnaryRpcResponse(req, res, r);
    return true;
  }
  const repos = await fetchRemoteGitRepoInfosFallback([uri]).catch(() => []);
  if (Array.isArray(repos) && repos.length > 0) {
    sendUnaryRpcResponse(req, res, {resourceType: 'FOLDER_TYPE_GIT_FOLDER', vcsType: 'VCS_TYPE_GIT'});
    return true;
  }
  return false;
}

async function handleFederatedGetRepoInfos(req, res, parsedJson) {
  const repoUris = Array.isArray(parsedJson?.repoUris) ? parsedJson.repoUris : [];
  if (repoUris.length === 0) {
    sendUnaryRpcResponse(req, res, {repos: []});
    return;
  }
  const localUris = [];
  const remoteUris = [];
  for (const rawUri of repoUris) {
    const u = String(rawUri || '').replace(/\/+$/, '');
    if (!u) continue;
    const target = decideRpcTarget('GetRepoInfos', req.headers, {folderUri: u}, u);
    if (target === 'local') localUris.push(u);
    else remoteUris.push(u);
  }
  if (remoteUris.length && sshState.status !== 'connected') {
    await waitForRemoteConnected(15000);
  }

  const [lRes, rRes] = await Promise.all([
    localUris.length ? callUpstreamUnaryJson('local', 'GetRepoInfos', {repoUris: localUris}, 3500) : Promise.resolve(null),
    remoteUris.length ? callUpstreamUnaryJson('remote', 'GetRepoInfos', {repoUris: remoteUris}, 4500) : Promise.resolve(null),
  ]);

  const reposMap = new Map();
  for (const r of [...(Array.isArray(lRes?.repos) ? lRes.repos : []), ...(Array.isArray(rRes?.repos) ? rRes.repos : [])]) {
    const key = String(r?.repoUri || '').replace(/\/+$/, '');
    if (key && Array.isArray(r?.branches) && r.branches.length > 0) {
      reposMap.set(key, r);
    }
  }

  const missingLocal = localUris.filter(u => !reposMap.has(u));
  const missingRemote = remoteUris.filter(u => !reposMap.has(u));
  if (missingLocal.length || missingRemote.length) {
    const [fbLocal, fbRemote] = await Promise.all([
      missingLocal.length ? fetchLocalGitRepoInfosFallback(missingLocal) : Promise.resolve([]),
      missingRemote.length ? fetchRemoteGitRepoInfosFallback(missingRemote) : Promise.resolve([]),
    ]);
    for (const r of [...fbLocal, ...fbRemote]) {
      const key = String(r?.repoUri || '').replace(/\/+$/, '');
      if (key && !reposMap.has(key)) {
        reposMap.set(key, r);
      }
    }
  }

  sendUnaryRpcResponse(req, res, {repos: [...reposMap.values()]});
}

async function handleFederatedReadProject(req, res, parsedJson) {
  const reqId = parsedJson?.id;
  if (!reqId) {
    sendUnaryRpcResponse(req, res, {notFoundOnDisk: true});
    return;
  }
  if (deletedProjectIdsSet.has(reqId)) {
    evictProjectId(reqId);
    emitState({});
    sendUnaryRpcResponse(req, res, {notFoundOnDisk: true});
    return;
  }
  if (reqId === REMOTE_DEFAULT_PROJECT_ALIAS) {
    const rRes = await callUpstreamUnaryJson('remote', 'ReadProject', {id: 'default-cli-project'}, 4500);
    if (rRes?.project) {
      const mapped = mapRemoteProjectObject(rRes.project);
      remoteProjectsMap.set(mapped.id, mapped);
      remoteProjectIdsSet.add(mapped.id);
      sendUnaryRpcResponse(req, res, {project: mapped});
      return;
    }
    if (remoteProjectsMap.has(reqId)) {
      sendUnaryRpcResponse(req, res, {project: remoteProjectsMap.get(reqId)});
      return;
    }
  }
  if (cloudProjectIdsSet.has(reqId) || cloudProjectsMap.has(reqId)) {
    const prefTarget = sshState.status === 'connected' ? 'remote' : 'local';
    const cRes = await callUpstreamUnaryJson(prefTarget, 'ReadProject', {id: reqId}, 4500);
    if (cRes?.project) {
      registerCloudProject(cRes.project);
      emitState({});
      sendUnaryRpcResponse(req, res, {project: cRes.project});
      return;
    }
    if (cRes?.notFoundOnDisk) {
      evictProjectId(reqId);
      emitState({});
      sendUnaryRpcResponse(req, res, {notFoundOnDisk: true});
      return;
    }
    if (!cRes && cloudProjectsMap.has(reqId)) {
      sendUnaryRpcResponse(req, res, {project: cloudProjectsMap.get(reqId)});
      return;
    }
  }
  if (localProjectIdsSet.has(reqId) || localProjectsMap.has(reqId)) {
    const lRes = await callUpstreamUnaryJson('local', 'ReadProject', {id: reqId}, 3500);
    if (lRes?.project) {
      if (isCloudProject(lRes.project)) {
        registerCloudProject(lRes.project);
        emitState({});
      } else {
        localProjectsMap.set(reqId, lRes.project);
        localProjectIdsSet.add(reqId);
      }
      sendUnaryRpcResponse(req, res, {project: lRes.project});
      return;
    }
    if (lRes?.notFoundOnDisk) {
      localProjectsMap.delete(reqId);
      localProjectIdsSet.delete(reqId);
    } else if (!lRes && localProjectsMap.has(reqId)) {
      sendUnaryRpcResponse(req, res, {project: localProjectsMap.get(reqId)});
      return;
    }
  }
  if (remoteProjectIdsSet.has(reqId) || remoteProjectsMap.has(reqId)) {
    const rRes = await callUpstreamUnaryJson('remote', 'ReadProject', {id: reqId}, 4500);
    if (rRes?.project) {
      if (isCloudProject(rRes.project)) {
        registerCloudProject(rRes.project);
        emitState({});
        sendUnaryRpcResponse(req, res, {project: rRes.project});
        return;
      }
      const mapped = mapRemoteProjectObject(rRes.project);
      remoteProjectsMap.set(mapped.id, mapped);
      remoteProjectIdsSet.add(mapped.id);
      sendUnaryRpcResponse(req, res, {project: mapped});
      return;
    }
    if (rRes?.notFoundOnDisk) {
      remoteProjectsMap.delete(reqId);
      remoteProjectIdsSet.delete(reqId);
    } else if (!rRes && remoteProjectsMap.has(reqId)) {
      sendUnaryRpcResponse(req, res, {project: remoteProjectsMap.get(reqId)});
      return;
    }
  }
  const [lRes, rRes] = await Promise.all([
    callUpstreamUnaryJson('local', 'ReadProject', {id: reqId}, 3500),
    callUpstreamUnaryJson('remote', 'ReadProject', {id: reqId}, 4500),
  ]);
  const cloudCandidate =
    (rRes?.project && isCloudProject(rRes.project) ? rRes.project : null) ||
    (lRes?.project && isCloudProject(lRes.project) ? lRes.project : null);
  if (cloudCandidate) {
    registerCloudProject(cloudCandidate);
    emitState({});
    sendUnaryRpcResponse(req, res, {project: cloudCandidate});
    return;
  }
  if (lRes?.project) {
    localProjectsMap.set(reqId, lRes.project);
    localProjectIdsSet.add(reqId);
    sendUnaryRpcResponse(req, res, {project: lRes.project});
    return;
  }
  if (rRes?.project) {
    const mapped = mapRemoteProjectObject(rRes.project);
    remoteProjectsMap.set(mapped.id, mapped);
    remoteProjectIdsSet.add(mapped.id);
    sendUnaryRpcResponse(req, res, {project: mapped});
    return;
  }
  evictProjectId(reqId);
  emitState({});
  sendUnaryRpcResponse(req, res, {notFoundOnDisk: true});
}

async function handleFederatedDeleteProject(req, res, parsedJson) {
  const reqId = parsedJson?.id || parsedJson?.projectId || '';
  if (!reqId) {
    sendUnaryRpcResponse(req, res, {});
    return;
  }
  const wasCloud = cloudProjectIdsSet.has(reqId) || cloudProjectsMap.has(reqId);
  const wasRemote = reqId === REMOTE_DEFAULT_PROJECT_ALIAS || remoteProjectIdsSet.has(reqId) || remoteProjectsMap.has(reqId);
  const wasLocal = localProjectIdsSet.has(reqId) || localProjectsMap.has(reqId);

  deletedProjectIdsSet.add(reqId);
  evictProjectId(reqId);
  emitState({});

  const upstreamId = reqId === REMOTE_DEFAULT_PROJECT_ALIAS ? 'default-cli-project' : reqId;
  const deleteCalls = [];
  if (wasRemote && !wasLocal && !wasCloud) {
    if (sshState.status === 'connected') {
      deleteCalls.push(callUpstreamUnaryJson('remote', 'DeleteProject', {id: upstreamId}, 5000));
    }
  } else if (wasLocal && !wasRemote && !wasCloud) {
    deleteCalls.push(callUpstreamUnaryJson('local', 'DeleteProject', {id: upstreamId}, 4000));
  } else {
    deleteCalls.push(callUpstreamUnaryJson('local', 'DeleteProject', {id: upstreamId}, 4000));
    if (sshState.status === 'connected') {
      deleteCalls.push(callUpstreamUnaryJson('remote', 'DeleteProject', {id: upstreamId}, 5000));
    }
  }
  await Promise.allSettled(deleteCalls);

  sendUnaryRpcResponse(req, res, {});

  const updFrame = encodeDataFrame({projectUpdatedId: reqId});
  const cloudListFrame = encodeDataFrame({projectList: {projectIds: [...cloudProjectIdsSet]}});
  for (const clientRes of [...activeCloudProjectUpdateStreams]) {
    if (clientRes.writableEnded || clientRes.destroyed) {
      activeCloudProjectUpdateStreams.delete(clientRes);
      continue;
    }
    try {
      clientRes.write(updFrame);
      clientRes.write(cloudListFrame);
    } catch {
      activeCloudProjectUpdateStreams.delete(clientRes);
    }
  }
  for (const clientRes of [...activeProjectUpdateStreams]) {
    if (!clientRes.writableEnded && !clientRes.destroyed) {
      try {
        clientRes.write(updFrame);
      } catch {}
    }
  }
  await pushMergedProjectListToBrowsers().catch(() => {});
}

async function handleFederatedProjectUpdatesStream(req, res, parsedJson) {
  const ct = String(req.headers['content-type'] || '');
  const outCt = ct.includes('connect') ? 'application/connect+json' : 'application/grpc-web+json';
  writeSafeHead(res, 200, {'content-type': outCt}, req.headers);

  // If client is subscribing to Enterprise (backend=3), return empty project list
  const backend = parsedJson?.backend;
  if (isEnterpriseBackend(backend)) {
    if (!res.writableEnded && !res.destroyed) {
      res.write(encodeDataFrame({projectList: {projectIds: []}}));
    }
    return;
  }

  // If client is subscribing to Cloud / Remote Agent projects (backend=2), forward stream to single upstream
  if (isCloudBackend(backend)) {
    activeCloudProjectUpdateStreams.add(res);
    res.on('close', () => activeCloudProjectUpdateStreams.delete(res));
    const useRemote = sshState.status === 'connected' && Boolean(getRemoteUpstreamH2() && sshState.csrfToken);
    if (!useRemote && (!sshState.localMacPort || !sshState.localMacCsrfToken)) {
      await discoverLocalMacLsPort();
    }
    const h2 = useRemote ? getRemoteUpstreamH2() : getLocalUpstreamH2();
    const csrf = useRemote ? sshState.csrfToken : sshState.localMacCsrfToken;
    if (!h2 || !csrf) {
      if (!res.writableEnded && !res.destroyed) {
        res.write(encodeDataFrame({projectList: {projectIds: []}}));
      }
      return;
    }
    try {
      const uReq = h2.request({
        ':method': 'POST',
        ':path': '/exa.language_server_pb.LanguageServerService/ProjectUpdatesStream',
        'content-type': 'application/grpc-web+json',
        'x-grpc-web': '1',
        'x-codeium-csrf-token': csrf,
      });
      let rem = Buffer.alloc(0);
      uReq.on('data', (chunk) => {
        try {
          const parsed = parseFramedMessages(Buffer.concat([rem, chunk]));
          rem = parsed.remainder;
          for (const f of parsed.frames) {
            const ids = f.json?.projectList?.projectIds;
            if (Array.isArray(ids)) {
              syncCloudProjectIdsFromUpstreamList(ids);
            }
          }
        } catch {}
        if (!res.writableEnded && !res.destroyed) {
          try { res.write(chunk); } catch {}
        }
      });
      uReq.on('end', () => {
        if (!res.writableEnded && !res.destroyed) res.end();
      });
      uReq.on('error', () => {
        if (!res.writableEnded && !res.destroyed) res.end();
      });
      res.on('close', () => {
        try { uReq.close(); } catch {}
      });
      uReq.end(encodeDataFrame({backend: 2}));
    } catch {
      if (!res.writableEnded && !res.destroyed) {
        res.write(encodeDataFrame({projectList: {projectIds: []}}));
      }
    }
    return;
  }

  activeProjectUpdateStreams.add(res);
  res.on('close', () => activeProjectUpdateStreams.delete(res));

  const {mergedIds} = await refreshProjectFederation();
  if (!res.writableEnded && !res.destroyed) {
    res.write(encodeDataFrame({projectList: {projectIds: mergedIds}}));
  }

  ensureUpstreamProjectUpdateWatcher('local');
  ensureUpstreamProjectUpdateWatcher('remote');
}

async function handleFederatedSubscribeToSidecars(req, res, reqBody) {
  if (!sshState.localMacPort || !sshState.localMacCsrfToken) {
    await discoverLocalMacLsPort();
  }
  const h2 = getLocalUpstreamH2() || getRemoteUpstreamH2();
  const csrf = getLocalUpstreamH2() ? sshState.localMacCsrfToken : sshState.csrfToken;
  if (!h2 || !csrf) {
    const ct = String(req.headers['content-type'] || '');
    const outCt = ct.includes('connect') ? 'application/connect+json' : 'application/grpc-web+json';
    writeSafeHead(res, 200, {'content-type': outCt}, req.headers);
    res.write(encodeDataFrame({sidecars: []}));
    res.end();
    return;
  }

  const outHeaders = {
    ':method': 'POST',
    ':path': '/exa.language_server_pb.LanguageServerService/SubscribeToSidecars',
    ':authority': req.headers[':authority'] || req.headers.host || '127.0.0.1:58282',
    'content-type': req.headers['content-type'] || 'application/grpc-web+json',
    'x-grpc-web': req.headers['x-grpc-web'] || '1',
    'x-codeium-csrf-token': csrf,
  };
  const uReq = h2.request(outHeaders);
  uReq.on('response', (uHeaders) => {
    if (res.writableEnded || res.destroyed) return;
    const status = Number(uHeaders[':status'] || 200);
    writeSafeHead(res, status, uHeaders, req.headers);
  });

  let rem = Buffer.alloc(0);
  uReq.on('data', (chunk) => {
    if (res.writableEnded || res.destroyed) return;
    const parsed = parseFramedMessages(Buffer.concat([rem, chunk]));
    rem = parsed.remainder;
    for (const f of parsed.frames) {
      if ((f.flag & 0x80) === 0 && f.json && Array.isArray(f.json.sidecars)) {
        for (const sc of f.json.sidecars) {
          if (sc?.userConfig?.projectId) {
            delete sc.userConfig.projectId;
          }
        }
        res.write(encodeDataFrame(f.json));
      } else {
        const raw = Buffer.from(f.text, 'utf8');
        const out = Buffer.allocUnsafe(5 + raw.length);
        out[0] = f.flag;
        out.writeUInt32BE(raw.length, 1);
        raw.copy(out, 5);
        res.write(out);
      }
    }
  });
  uReq.on('end', () => {
    if (!res.writableEnded && !res.destroyed) res.end();
  });
  uReq.on('error', () => {
    if (!res.writableEnded && !res.destroyed) res.end();
  });
  res.on('close', () => {
    try { uReq.close(); } catch {}
  });
  uReq.end(reqBody);
}

async function handleFederatedGetAllCascadeTrajectories(req, res, parsedJson) {
  const backend = parsedJson?.backend;
  if (isEnterpriseBackend(backend)) {
    sendUnaryRpcResponse(req, res, {trajectorySummaries: {}});
    return;
  }
  if (isCloudBackend(backend)) {
    const target = sshState.status === 'connected' ? 'remote' : 'local';
    const cRes = await callUpstreamUnaryJson(target, 'GetAllCascadeTrajectories', parsedJson || {}, 6500);
    const summaries = dedupeCloudSummaries(cRes?.trajectorySummaries || {});
    sendUnaryRpcResponse(req, res, {...(cRes || {}), trajectorySummaries: summaries});
    return;
  }

  await refreshProjectFederation();
  await syncCliSummariesAndPushUpdates().catch(() => {});
  const [lRes, rRes] = await Promise.all([
    callUpstreamUnaryJson('local', 'GetAllCascadeTrajectories', parsedJson || {}, 4500),
    callUpstreamUnaryJson('remote', 'GetAllCascadeTrajectories', parsedJson || {}, 5500),
  ]);
  if (lRes) recordLocalSummariesObject(lRes);
  const rTransformed = rRes ? transformRemoteSummariesObject(rRes) : null;

  const merged = {
    ...(lRes || {}),
    ...(rTransformed || {}),
    trajectorySummaries: dedupeCloudSummaries({
      ...cachedRemoteSummaryUpdates,
      ...cachedLocalSummaryUpdates,
      ...(rTransformed?.trajectorySummaries || {}),
      ...(lRes?.trajectorySummaries || {}),
    }),
  };
  sendUnaryRpcResponse(req, res, merged);
}

function attachSummaryStreamTarget(entry, target) {
  if (!entry || entry.res.writableEnded || entry.res.destroyed) return;
  if (target === 'local' && entry.localReq) return;
  if (target === 'remote' && entry.remoteReq) return;

  const h2 = target === 'local' ? getLocalUpstreamH2() : getRemoteUpstreamH2();
  const csrf = target === 'local' ? sshState.localMacCsrfToken : sshState.csrfToken;
  if (!h2 || !csrf) return;

  try {
    const uReq = h2.request({
      ':method': 'POST',
      ':path': '/exa.language_server_pb.LanguageServerService/JetboxSubscribeToSummaries',
      'content-type': 'application/grpc-web+json',
      'x-grpc-web': '1',
      'x-codeium-csrf-token': csrf,
    });
    if (target === 'local') entry.localReq = uReq;
    else entry.remoteReq = uReq;

    let rem = Buffer.alloc(0);
    let isFirst = true;
    uReq.on('data', (chunk) => {
      if (entry.res.writableEnded || entry.res.destroyed) return;
      const parsed = parseFramedMessages(Buffer.concat([rem, chunk]));
      rem = parsed.remainder;
      for (const f of parsed.frames) {
        if ((f.flag & 0x80) !== 0) continue;
        if (f.json) {
          if (target === 'local') {
            recordLocalSummariesObject(f.json);
            const payload = isFirst && f.json.updates
              ? {
                  ...f.json,
                  updates: dedupeCloudSummaries({
                    ...cachedRemoteSummaryUpdates,
                    ...cachedLocalSummaryUpdates,
                    ...f.json.updates,
                  }),
                }
              : {...f.json, ...(f.json.updates ? {updates: dedupeCloudSummaries(f.json.updates)} : {})};
            isFirst = false;
            entry.res.write(encodeDataFrame(payload));
          } else {
            const transformed = transformRemoteSummariesObject(f.json);
            const payload = isFirst && transformed.updates
              ? {
                  ...transformed,
                  updates: dedupeCloudSummaries({
                    ...cachedLocalSummaryUpdates,
                    ...cachedRemoteSummaryUpdates,
                    ...transformed.updates,
                  }),
                }
              : {...transformed, ...(transformed.updates ? {updates: dedupeCloudSummaries(transformed.updates)} : {})};
            isFirst = false;
            entry.res.write(encodeDataFrame(payload));
          }
        }
      }
    });
    uReq.on('end', () => {
      if (target === 'local') entry.localReq = null;
      else entry.remoteReq = null;
    });
    uReq.on('error', () => {
      if (target === 'local') entry.localReq = null;
      else entry.remoteReq = null;
    });
    uReq.end(entry.upstreamPayload);
  } catch {
    if (target === 'local') entry.localReq = null;
    else entry.remoteReq = null;
  }
}

function attachPendingRemoteSummaryStreams() {
  for (const entry of [...activeSummaryStreams]) {
    if (entry.res.writableEnded || entry.res.destroyed) {
      activeSummaryStreams.delete(entry);
      continue;
    }
    if (!entry.localReq) {
      attachSummaryStreamTarget(entry, 'local');
    }
    if (!entry.remoteReq) {
      attachSummaryStreamTarget(entry, 'remote');
    }
  }
}

async function handleFederatedSummariesStream(req, res, reqBody, parsedJson) {
  const ct = String(req.headers['content-type'] || '');
  const outCt = ct.includes('connect') ? 'application/connect+json' : 'application/grpc-web+json';
  writeSafeHead(res, 200, {'content-type': outCt}, req.headers);

  // If client is subscribing to Enterprise (backend=3), return empty updates
  const backend = parsedJson?.backend;
  if (isEnterpriseBackend(backend)) {
    if (!res.writableEnded && !res.destroyed) {
      res.write(encodeDataFrame({updates: {}}));
    }
    return;
  }

  // If client is subscribing to Cloud / Remote Agent summaries (backend=2 / BACKEND_TYPE_REMOTE_AICODE),
  // route to a single upstream (preferring remote LS with --remote_agent_fastpush_override=false) and deduplicate shadow records.
  if (isCloudBackend(backend)) {
    const useRemote = sshState.status === 'connected' && Boolean(getRemoteUpstreamH2() && sshState.csrfToken);
    if (!useRemote && (!sshState.localMacPort || !sshState.localMacCsrfToken)) {
      await discoverLocalMacLsPort();
    }
    const h2 = useRemote ? getRemoteUpstreamH2() : getLocalUpstreamH2();
    const csrf = useRemote ? sshState.csrfToken : sshState.localMacCsrfToken;
    if (!h2 || !csrf) {
      if (!res.writableEnded && !res.destroyed) {
        res.write(encodeDataFrame({updates: {}}));
      }
      return;
    }
    try {
      const uReq = h2.request({
        ':method': 'POST',
        ':path': '/exa.language_server_pb.LanguageServerService/JetboxSubscribeToSummaries',
        'content-type': 'application/grpc-web+json',
        'x-grpc-web': '1',
        'x-codeium-csrf-token': csrf,
      });
      let rem = Buffer.alloc(0);
      uReq.on('data', (chunk) => {
        if (res.writableEnded || res.destroyed) return;
        const parsed = parseFramedMessages(Buffer.concat([rem, chunk]));
        rem = parsed.remainder;
        for (const f of parsed.frames) {
          if ((f.flag & 0x80) !== 0) continue;
          if (f.json) {
            const payload = f.json.updates
              ? {...f.json, updates: dedupeCloudSummaries(f.json.updates)}
              : f.json;
            try {
              res.write(encodeDataFrame(payload));
            } catch {}
          }
        }
      });
      uReq.on('end', () => {
        if (!res.writableEnded && !res.destroyed) res.end();
      });
      uReq.on('error', () => {
        if (!res.writableEnded && !res.destroyed) res.end();
      });
      res.on('close', () => {
        try { uReq.close(); } catch {}
      });
      uReq.end(encodeDataFrame({backend: 2}));
    } catch {
      if (!res.writableEnded && !res.destroyed) {
        res.write(encodeDataFrame({updates: {}}));
      }
    }
    return;
  }

  if (!sshState.localMacPort || !sshState.localMacCsrfToken) {
    await discoverLocalMacLsPort();
  }
  await refreshProjectFederation();
  await syncCliSummariesAndPushUpdates().catch(() => {});
  ensureCliSummariesWatcher();

  if (Object.keys(cachedLocalSummaryUpdates).length === 0) {
    const lRes = await callUpstreamUnaryJson('local', 'GetAllCascadeTrajectories', {}, 3500).catch(() => null);
    if (lRes) recordLocalSummariesObject(lRes);
  }

  const upstreamPayload = reqBody && reqBody.length >= 5 ? reqBody : encodeDataFrame({});
  const entry = {
    res,
    upstreamPayload,
    localReq: null,
    remoteReq: null,
  };
  activeSummaryStreams.add(entry);

  const initialCombined = dedupeCloudSummaries({
    ...cachedRemoteSummaryUpdates,
    ...cachedLocalSummaryUpdates,
  });
  if (Object.keys(initialCombined).length > 0 && !res.writableEnded && !res.destroyed) {
    try {
      res.write(encodeDataFrame({updates: initialCombined}));
    } catch {}
  }

  attachSummaryStreamTarget(entry, 'local');
  attachSummaryStreamTarget(entry, 'remote');

  const cleanup = () => {
    activeSummaryStreams.delete(entry);
    try { entry.localReq?.close(); } catch {}
    try { entry.remoteReq?.close(); } catch {}
  };
  res.on('close', cleanup);
}

function extractFirstUriFromObject(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const directKeys = [
    'uri',
    'folderUri',
    'workspaceUri',
    'rootUri',
    'directoryUri',
    'filePath',
    'path',
    'targetUri',
    'sourceUri',
    'armWorkspaceUri',
    'parentWorkspaceUri',
    'agentWorkspaceUri',
  ];
  for (const k of directKeys) {
    if (typeof obj[k] === 'string' && obj[k].length > 1) return obj[k];
  }
  const arrayKeys = ['workspaceUris', 'overrideWorkspaceUris', 'repoUris', 'fileUris'];
  for (const ak of arrayKeys) {
    if (Array.isArray(obj[ak]) && typeof obj[ak][0] === 'string' && obj[ak][0].length > 1) {
      return obj[ak][0];
    }
  }
  if (Array.isArray(obj.workspaces) && obj.workspaces[0]?.workspaceFolderAbsoluteUri) {
    return obj.workspaces[0].workspaceFolderAbsoluteUri;
  }
  if (obj.document && typeof obj.document.uri === 'string') {
    return obj.document.uri;
  }
  if (obj.metadata && typeof obj.metadata === 'object') {
    const nested = extractFirstUriFromObject(obj.metadata);
    if (nested) return nested;
  }
  if (obj.projectResources?.resources?.[0]?.folderUri) {
    return obj.projectResources.resources[0].folderUri;
  }
  if (obj.project?.projectResources?.resources?.[0]?.folderUri) {
    return obj.project.projectResources.resources[0].folderUri;
  }
  return '';
}

function decideRpcTarget(methodName, reqHeaders, parsedJson, rawText) {
  const forced = reqHeaders['x-ag-force-target'];
  if (forced === 'remote') return 'remote';
  if (forced === 'local') return 'local';

  // Route Cloud / Remote Agent (aicode.googleapis.com/v1alpha/remote:*) RPCs to remote LS when connected,
  // because remote-ctl.py launches remote LS with --remote_agent_fastpush_override=false to avoid the
  // 2.29.0 newFastpushTransport HTTP proxy dialer bug (dial tcp 172.253.120.126:10808).
  if (
    sshState.status === 'connected' &&
    (methodName === 'ListResourceProviders' ||
      methodName === 'ListRemotePlugins' ||
      methodName === 'ListAvailableResources' ||
      methodName === 'DisconnectRemotePlugin' ||
      isCloudBackend(parsedJson?.backend) ||
      isCloudProject(parsedJson?.project))
  ) {
    return 'remote';
  }

  // 1. Check cascadeId / conversationId / trajectoryId / cascadeIds[0] / sourceConversationId
  const cid =
    parsedJson?.cascadeId ||
    parsedJson?.conversationId ||
    parsedJson?.trajectoryId ||
    (Array.isArray(parsedJson?.cascadeIds) ? parsedJson.cascadeIds[0] : '') ||
    parsedJson?.sourceConversationId ||
    parsedJson?.parentCascadeId ||
    parsedJson?.baseTrajectoryIdentifier?.cascadeId ||
    parsedJson?.baseTrajectoryIdentifier?.identifier?.value ||
    parsedJson?.metadata?.cascadeId ||
    '';
  if (cid) {
    if (isShadowCloudCid(cid) && sshState.status === 'connected') return 'remote';
    if (remoteCascadeIds.has(cid)) return 'remote';
    if (localCascadeIds.has(cid)) return 'local';
    try {
      if (
        fs.existsSync(path.join(LOCAL_CONVERSATIONS_DIR, `${cid}.pb`)) ||
        fs.existsSync(path.join(LOCAL_CONVERSATIONS_DIR, `${cid}.db`))
      ) {
        localCascadeIds.add(cid);
        return 'local';
      }
    } catch {}
  }

  // 2. Check projectId / projectEnvConfig.projectId / project.id
  const pid =
    parsedJson?.projectId ||
    parsedJson?.projectEnvConfig?.projectId ||
    parsedJson?.project?.id ||
    parsedJson?.metadata?.projectId ||
    (methodName.includes('Project') ? parsedJson?.id : '') ||
    '';
  if (pid) {
    if ((String(pid).includes('/jetski_remote_agents_3p/') || cloudProjectIdsSet.has(pid)) && sshState.status === 'connected') {
      return 'remote';
    }
    if (pid === REMOTE_DEFAULT_PROJECT_ALIAS || remoteProjectIdsSet.has(pid)) return 'remote';
    if (localProjectIdsSet.has(pid)) return 'local';
  }

  // 3. Check terminalId
  const tid = parsedJson?.terminalId || parsedJson?.id || '';
  if (tid && methodName.includes('Terminal') && remoteTerminalIds.has(tid)) {
    return 'remote';
  }

  // 4. Check file/folder URI in payload or rawText
  const uri = extractFirstUriFromObject(parsedJson) || '';
  if (uri) {
    const cleanUri = uri.replace(/\/+$/, '');
    for (const proj of remoteProjectsMap.values()) {
      const fUri = getProjectFolderUri(proj);
      if (fUri && (cleanUri === fUri || cleanUri.startsWith(fUri + '/'))) {
        return 'remote';
      }
    }
    for (const proj of localProjectsMap.values()) {
      const fUri = getProjectFolderUri(proj);
      if (fUri && (cleanUri === fUri || cleanUri.startsWith(fUri + '/'))) {
        return 'local';
      }
    }
  }
  const checkStr = uri || rawText || '';
  if (
    checkStr.includes('file:///Users/') ||
    checkStr.includes('file:///Applications/') ||
    checkStr.includes('file:///Library/') ||
    checkStr.includes('file:///Volumes/') ||
    checkStr.startsWith('/Users/') ||
    checkStr.startsWith('/Applications/') ||
    checkStr.startsWith('/Volumes/')
  ) {
    return 'local';
  }
  if (
    checkStr.includes('file:///home/') ||
    checkStr.includes('file:///develop') ||
    checkStr.includes('file:///data') ||
    checkStr.includes('file:///root') ||
    checkStr.includes('file:///opt/') ||
    checkStr.includes('file:///srv/') ||
    checkStr.includes('file:///mnt/') ||
    checkStr.startsWith('/home/') ||
    checkStr.startsWith('/develop') ||
    checkStr.startsWith('/data') ||
    checkStr.startsWith('/root') ||
    checkStr.startsWith('/opt/') ||
    checkStr.startsWith('/srv/') ||
    checkStr.startsWith('/mnt/')
  ) {
    return 'remote';
  }

  // 5. Check active project header and active UI context header
  const activeProjHeader = reqHeaders['x-ag-active-project'];
  if (activeProjHeader) {
    if (
      (activeProjHeader === REMOTE_DEFAULT_PROJECT_ALIAS || remoteProjectIdsSet.has(activeProjHeader)) &&
      sshState.status === 'connected'
    ) {
      return 'remote';
    }
    if (localProjectIdsSet.has(activeProjHeader)) {
      return 'local';
    }
  }

  const uiTarget = reqHeaders['x-ag-target-env'];
  if (uiTarget === 'remote' && sshState.status === 'connected') {
    return 'remote';
  }
  if (uiTarget === 'local') {
    return 'local';
  }

  // 6. Fallback for headerless requests with a cascade UUID that does not exist on local Mac disk
  if (cid && sshState.status === 'connected' && methodName !== 'StartCascade' && /^[0-9a-f-]{36}$/i.test(String(cid))) {
    return 'remote';
  }

  return sshState.localMacPort ? 'local' : 'remote';
}

function rewriteBodyForRemote(reqBody) {
  if (!reqBody || reqBody.length === 0) return reqBody;
  const aliasBytes = Buffer.from(REMOTE_DEFAULT_PROJECT_ALIAS, 'utf8');
  if (!reqBody.includes(aliasBytes)) return reqBody;

  const parsed = parseFramedMessages(reqBody);
  if (parsed.frames.length > 0 && !parsed.frames[0].rawJson) {
    const outChunks = [];
    for (const f of parsed.frames) {
      if ((f.flag & 0x80) === 0) {
        const replaced = f.text.replaceAll(REMOTE_DEFAULT_PROJECT_ALIAS, 'default-cli-project');
        outChunks.push(encodeDataFrame(replaced));
      }
    }
    return Buffer.concat(outChunks);
  }
  const replacedText = reqBody.toString('utf8').replaceAll(REMOTE_DEFAULT_PROJECT_ALIAS, 'default-cli-project');
  return Buffer.from(replacedText, 'utf8');
}

function ensureLocalHttpsProxy() {
  if (localProxyServer) return;
  try {
    const {cert, key} = extractCertAndKey();
    ensureLocalPatchedMainJs();
    localProxyServer = http2.createSecureServer({cert, key, allowHTTP1: true}, (req, res) => {
      const reqPath = req.url || '/';

      // Learn local Mac port & CSRF token from browser headers if provided
      const headerLocalPort = Number(req.headers['x-ag-local-port'] || 0);
      const headerLocalCsrf = String(req.headers['x-ag-local-csrf'] || '');
      if (headerLocalPort > 0 && headerLocalPort !== 58282 && headerLocalPort !== sshState.localMacPort) {
        sshState.localMacPort = headerLocalPort;
      }
      if (headerLocalCsrf && headerLocalCsrf !== sshState.localMacCsrfToken) {
        sshState.localMacCsrfToken = headerLocalCsrf;
      }

      // Handle CORS preflight
      if (req.method === 'OPTIONS') {
        writeSafeHead(res, 204, {}, req.headers);
        res.end();
        return;
      }

      // Serve static files from local patched www cache when requested via GET
      if (req.method === 'GET' || req.method === 'HEAD') {
        const cachedEntry = getCachedFileEntry(reqPath);
        if (cachedEntry) {
          try {
            writeSafeHead(
              res,
              200,
              {
                'content-type': cachedEntry.contentType,
                'content-length': String(cachedEntry.buf.length),
                'cache-control': 'no-cache',
              },
              req.headers
            );
            res.end(req.method === 'HEAD' ? undefined : cachedEntry.buf);
            return;
          } catch {}
        }

        // Serve index.html for SPA routes on 58282
        if (!reqPath.startsWith('/exa.') && !reqPath.startsWith('/mcp')) {
          const indexEntry = getCachedFileEntry('/index.html');
          if (indexEntry) {
            try {
              const rawHtml = indexEntry.buf.toString('utf8');
              const appConfig = JSON.stringify({
                productName: 'antigravity',
                csrfToken: sshState.csrfToken || '',
                appVersion: '1.23.6',
                releaseChannel: 'stable',
                devMode: false,
              });
              const initialSshState = JSON.stringify(getSshState());
              const scriptTag = `<script>window.__ag_is_ssh_remote=true;window.__APP_CONFIG__=${appConfig};window.__ag_ssh_state=${initialSshState};if(typeof window.__ag_update_ssh_state==="function"){try{window.__ag_update_ssh_state(window.__ag_ssh_state);}catch{}}</script>`;
              const html = rawHtml.includes('__AG_APP_CONFIG_SCRIPT__')
                ? rawHtml.replace('__AG_APP_CONFIG_SCRIPT__', scriptTag)
                : rawHtml.replace('<head>', `<head>${scriptTag}`);
              const buf = Buffer.from(html, 'utf8');
              writeSafeHead(
                res,
                200,
                {
                  'content-type': 'text/html; charset=utf-8',
                  'content-length': String(buf.length),
                  'cache-control': 'no-store',
                },
                req.headers
              );
              res.end(req.method === 'HEAD' ? undefined : buf);
              return;
            } catch {}
          }
        }
      }

      const rpcPrefix = '/exa.language_server_pb.LanguageServerService/';
      if (req.method === 'POST' && reqPath.startsWith(rpcPrefix)) {
        const methodName = reqPath.slice(rpcPrefix.length).split('?')[0];
        const reqChunks = [];
        req.on('data', (c) => reqChunks.push(c));
        req.on('end', async () => {
          const reqBody = Buffer.concat(reqChunks);
          const parsed = parseFramedMessages(reqBody);
          const firstFrame = parsed.frames[0] || null;
          const parsedJson = firstFrame?.json || null;
          const rawText = firstFrame?.text || reqBody.toString('utf8');

          try {
            // Federated project & summary RPCs
            if (methodName === 'ListProjects') {
              await handleFederatedListProjects(req, res, parsedJson);
              return;
            }
            if (methodName === 'ReadProjects') {
              await handleFederatedReadProjects(req, res, parsedJson);
              return;
            }
            if (methodName === 'ReadProject') {
              await handleFederatedReadProject(req, res, parsedJson);
              return;
            }
            if (methodName === 'DeleteProject') {
              await handleFederatedDeleteProject(req, res, parsedJson);
              return;
            }
            if (methodName === 'GetRepoInfos') {
              await handleFederatedGetRepoInfos(req, res, parsedJson);
              return;
            }
            if (methodName === 'ResolveFolder') {
              if (await handleFederatedResolveFolder(req, res, parsedJson, rawText)) return;
            }
            if (methodName === 'ProjectUpdatesStream') {
              await handleFederatedProjectUpdatesStream(req, res, parsedJson);
              return;
            }
            if (methodName === 'GetAllCascadeTrajectories') {
              await handleFederatedGetAllCascadeTrajectories(req, res, parsedJson);
              return;
            }
            if (methodName === 'JetboxSubscribeToSummaries') {
              await handleFederatedSummariesStream(req, res, reqBody, parsedJson);
              return;
            }
            if (methodName === 'SubscribeToSidecars') {
              await handleFederatedSubscribeToSidecars(req, res, reqBody);
              return;
            }

            // Route individual RPC to local or remote language_server
            const target = decideRpcTarget(methodName, req.headers, parsedJson, rawText);
            if (
              methodName === 'GetAuthStatus' &&
              target === 'remote' &&
              cachedRemoteAuthStatus &&
              Date.now() - cachedRemoteAuthStatusTs < 120000
            ) {
              if (Date.now() - cachedRemoteAuthStatusTs > 30000) {
                callUpstreamUnaryJson('remote', 'GetAuthStatus', {}, 6500)
                  .then((aRes) => {
                    if (aRes && aRes.userStatus) {
                      cachedRemoteAuthStatus = aRes;
                      cachedRemoteAuthStatusTs = Date.now();
                    }
                  })
                  .catch(() => {});
              }
              sendUnaryRpcResponse(req, res, cachedRemoteAuthStatus);
              return;
            }
            if (
              methodName === 'StartCascade' ||
              methodName === 'SendUserCascadeMessage'
            ) {
              const newCid = parsedJson?.cascadeId || parsedJson?.conversationId || '';
              if (newCid && !remoteCascadeIds.has(newCid) && !localCascadeIds.has(newCid)) {
                if (target === 'remote') remoteCascadeIds.add(newCid);
                else localCascadeIds.add(newCid);
                emitState({});
              }
            } else if (
              methodName === 'DeleteCascadeTrajectory' ||
              methodName === 'JetboxDeleteSummary'
            ) {
              const delCid = parsedJson?.cascadeId || parsedJson?.id || '';
              if (delCid) {
                lastRemoteCliSummariesBridgeSig = '';
                delete cachedRemoteSummaryUpdates[delCid];
                delete rawRemoteSummaries[delCid];
                delete cachedLocalSummaryUpdates[delCid];
                delete rawLocalSummaries[delCid];
                remoteCliSummariesMap.delete(delCid);
                localCliSummariesMap.delete(delCid);
                lastPushedRemoteSummarySig.delete(delCid);
                lastPushedLocalSummarySig.delete(delCid);
                remoteCascadeIds.delete(delCid);
                localCascadeIds.delete(delCid);
                localCascadeProjectMap.delete(delCid);
                deleteLocalCliConversation(delCid);
                if (sshState.status === 'connected') {
                  postBridgeJson('/delete-cli-summary', {cascadeId: delCid}, 2500).catch(() => {});
                }
              }
            } else if (methodName === 'UpdateConversationAnnotations') {
              const cids = Array.isArray(parsedJson?.cascadeIds)
                ? parsedJson.cascadeIds
                : parsedJson?.cascadeId
                  ? [parsedJson.cascadeId]
                  : [];
              const ann = parsedJson?.annotations;
              if (cids.length > 0 && ann && typeof ann === 'object') {
                const liveUpd = {};
                for (const cid of cids) {
                  if (!cid) continue;
                  const isRem = isRemoteCascade(cid) || target === 'remote';
                  if (ann.archived === true) {
                    if (isRem) remoteArchivedIdsSet.add(cid);
                    else localArchivedIdsSet.add(cid);
                  } else if (ann.archived === false) {
                    if (isRem) remoteArchivedIdsSet.delete(cid);
                    else localArchivedIdsSet.delete(cid);
                  }
                  if (typeof ann.title === 'string') {
                    const cleanTitle = ann.title.trim();
                    if (cleanTitle) {
                      if (isRem) remotePbtxtTitlesMap.set(cid, cleanTitle);
                      else localPbtxtTitlesMap.set(cid, cleanTitle);
                    }
                  }
                  const cacheObj = isRem ? cachedRemoteSummaryUpdates : cachedLocalSummaryUpdates;
                  if (cacheObj[cid]) {
                    const updated = {
                      ...cacheObj[cid],
                      ...(typeof ann.title === 'string' && ann.title.trim() ? {summary: ann.title.trim()} : {}),
                      annotations: {
                        ...(cacheObj[cid].annotations || {}),
                        ...ann,
                      },
                    };
                    cacheObj[cid] = updated;
                    if (isRem) lastPushedRemoteSummarySig.set(cid, computeSummarySig(updated));
                    else lastPushedLocalSummarySig.set(cid, computeSummarySig(updated));
                    liveUpd[cid] = updated;
                  }
                }
                if (Object.keys(liveUpd).length > 0 && activeSummaryStreams.size > 0) {
                  const frame = encodeDataFrame({updates: liveUpd});
                  for (const entry of [...activeSummaryStreams]) {
                    if (!entry.res.writableEnded && !entry.res.destroyed) {
                      try { entry.res.write(frame); } catch {}
                    }
                  }
                }
              }
            }
            if (target === 'local' && (!sshState.localMacPort || !sshState.localMacCsrfToken)) {
              await discoverLocalMacLsPort();
            }
            const h2 = target === 'local' ? getLocalUpstreamH2() : getRemoteUpstreamH2();
            const targetCsrf = target === 'local' ? sshState.localMacCsrfToken : sshState.csrfToken;

            if (!h2) {
              writeSafeHead(res, 502, {'content-type': 'text/plain'}, req.headers);
              res.end(`Upstream ${target} unavailable`);
              return;
            }

            const forwardBody = target === 'remote' ? rewriteBodyForRemote(reqBody) : reqBody;
            const outHeaders = {
              ':method': req.method,
              ':path': reqPath,
              ':authority': req.headers[':authority'] || req.headers.host || '127.0.0.1:58282',
            };
            for (const [k, v] of Object.entries(req.headers)) {
              if (k.startsWith(':')) continue;
              const lk = k.toLowerCase();
              if (
                lk === 'connection' ||
                lk === 'keep-alive' ||
                lk === 'transfer-encoding' ||
                lk === 'host' ||
                lk === 'upgrade' ||
                lk === 'content-length' ||
                lk.startsWith('x-ag-')
              ) {
                continue;
              }
              outHeaders[lk] = v;
            }
            if (targetCsrf) {
              outHeaders['x-codeium-csrf-token'] = targetCsrf;
            }

            const uReq = h2.request(outHeaders);
            uReq.on('response', (uHeaders) => {
              if (res.writableEnded || res.destroyed) return;
              const status = Number(uHeaders[':status'] || 200);
              writeSafeHead(res, status, uHeaders, req.headers);
            });

            const respChunks = [];
            const shouldInspectResponse =
              methodName === 'StartCascade' ||
              (methodName === 'GetAuthStatus' && target === 'remote') ||
              methodName === 'CreateProject' ||
              methodName === 'UpdateProject' ||
              methodName === 'AddEnvironmentToProject' ||
              methodName === 'DeleteProject' ||
              methodName === 'CreateTerminal';

            uReq.on('data', (chunk) => {
              if (shouldInspectResponse && respChunks.length < 16) {
                respChunks.push(chunk);
                if (methodName === 'StartCascade') {
                  try {
                    const pResp = parseFramedMessages(Buffer.concat(respChunks));
                    for (const rf of pResp.frames) {
                      if (rf.json?.cascadeId) {
                        if (target === 'remote') remoteCascadeIds.add(rf.json.cascadeId);
                        else {
                          localCascadeIds.add(rf.json.cascadeId);
                          const activePid = parsedJson?.projectId || req.headers['x-ag-active-project'] || '';
                          if (activePid && localProjectIdsSet.has(activePid)) {
                            localCascadeProjectMap.set(rf.json.cascadeId, activePid);
                          }
                        }
                        emitState({});
                      }
                    }
                  } catch {}
                }
              }
              if (!res.writableEnded && !res.destroyed) res.write(chunk);
            });

            uReq.on('end', async () => {
              if (shouldInspectResponse) {
                try {
                  if (respChunks.length > 0) {
                    const pResp = parseFramedMessages(Buffer.concat(respChunks));
                    for (const rf of pResp.frames) {
                      if (rf.json) {
                        if (methodName === 'GetAuthStatus' && target === 'remote' && rf.json.userStatus) {
                          cachedRemoteAuthStatus = rf.json;
                          cachedRemoteAuthStatusTs = Date.now();
                        }
                        if (methodName === 'StartCascade' && rf.json.cascadeId) {
                          if (target === 'remote') remoteCascadeIds.add(rf.json.cascadeId);
                          else localCascadeIds.add(rf.json.cascadeId);
                        }
                        if (methodName === 'CreateTerminal' && rf.json.terminalId && target === 'remote') {
                          remoteTerminalIds.add(rf.json.terminalId);
                        }
                        if (methodName === 'CreateProject' && rf.json.project?.id) {
                          deletedProjectIdsSet.delete(rf.json.project.id);
                          if (
                            isCloudProject(rf.json.project) ||
                            isCloudProject(parsedJson?.project) ||
                            isCloudBackend(parsedJson?.backend)
                          ) {
                            registerCloudProject(rf.json.project);
                          } else if (target === 'remote') {
                            remoteProjectsMap.set(rf.json.project.id, rf.json.project);
                            remoteProjectIdsSet.add(rf.json.project.id);
                          } else {
                            localProjectsMap.set(rf.json.project.id, rf.json.project);
                            localProjectIdsSet.add(rf.json.project.id);
                          }
                        }
                      }
                    }
                  }
                  if (methodName === 'DeleteProject' && parsedJson?.id) {
                    localProjectsMap.delete(parsedJson.id);
                    remoteProjectsMap.delete(parsedJson.id);
                    cloudProjectsMap.delete(parsedJson.id);
                    localProjectIdsSet.delete(parsedJson.id);
                    remoteProjectIdsSet.delete(parsedJson.id);
                    cloudProjectIdsSet.delete(parsedJson.id);
                  }
                  if (
                    methodName === 'CreateProject' ||
                    methodName === 'UpdateProject' ||
                    methodName === 'AddEnvironmentToProject' ||
                    methodName === 'DeleteProject'
                  ) {
                    await pushMergedProjectListToBrowsers().catch(() => {});
                  }
                } catch {}
              }
              if (!res.writableEnded && !res.destroyed) res.end();
            });

            uReq.on('error', () => {
              writeSafeHead(res, 502, {}, req.headers);
              if (!res.writableEnded) res.end();
            });

            res.on('close', () => {
              if (!res.writableEnded) {
                try { uReq.close(); } catch {}
              }
            });

            uReq.end(forwardBody);
          } catch (err) {
            writeSafeHead(res, 500, {'content-type': 'text/plain'}, req.headers);
            if (!res.writableEnded) res.end(String(err));
          }
        });
        return;
      }

      // Non-RPC request -> forward to remote upstream H2
      const h2 = getRemoteUpstreamH2();
      const outHeaders = {
        ':method': req.method,
        ':path': reqPath,
        ':authority': req.headers[':authority'] || req.headers.host || '127.0.0.1:58282',
      };
      for (const [k, v] of Object.entries(req.headers)) {
        if (k.startsWith(':')) continue;
        const lk = k.toLowerCase();
        if (
          lk === 'connection' ||
          lk === 'keep-alive' ||
          lk === 'transfer-encoding' ||
          lk === 'host' ||
          lk === 'upgrade'
        ) {
          continue;
        }
        outHeaders[lk] = v;
      }
      if (sshState.csrfToken && !outHeaders['x-codeium-csrf-token']) {
        outHeaders['x-codeium-csrf-token'] = sshState.csrfToken;
      }

      let uReq;
      try {
        uReq = h2.request(outHeaders);
      } catch {
        resetUpstreamH2();
        try {
          uReq = getRemoteUpstreamH2().request(outHeaders);
        } catch {
          writeSafeHead(res, 502, {}, req.headers);
          res.end('Upstream tunnel unavailable');
          return;
        }
      }

      uReq.on('response', (uHeaders) => {
        if (res.writableEnded || res.destroyed) return;
        const status = Number(uHeaders[':status'] || 200);
        writeSafeHead(res, status, uHeaders, req.headers);
      });

      uReq.on('data', (chunk) => {
        if (!res.writableEnded && !res.destroyed) res.write(chunk);
      });
      uReq.on('end', () => {
        if (!res.writableEnded && !res.destroyed) res.end();
      });
      uReq.on('error', () => {
        resetUpstreamH2();
        writeSafeHead(res, 502, {}, req.headers);
        if (!res.writableEnded) res.end();
      });

      req.pipe(uReq);
      req.on('error', () => {
        try { uReq.close(); } catch {}
      });
    });

    localProxyServer.on('error', () => {});
    localProxyServer.listen(58282, '127.0.0.1');
  } catch {}
}

function handleOpenUrls(urls, host) {
  if (!Array.isArray(urls)) return;
  for (const rawUrl of urls) {
    if (!rawUrl || seenOpenUrls.has(rawUrl)) continue;
    seenOpenUrls.add(rawUrl);
    try {
      const parsed = new URL(rawUrl);
      const port = Number(parsed.port);
      if (
        (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
        port > 1024 &&
        port !== sshState.remoteHttpsPort &&
        port !== sshState.remoteHttpPort &&
        port !== sshState.remoteBridgePort
      ) {
        ensureSidecarTunnel(host, port).then(() => {
          for (const fn of openUrlListeners) {
            try { fn(rawUrl); } catch {}
          }
        });
      } else {
        for (const fn of openUrlListeners) {
          try { fn(rawUrl); } catch {}
        }
      }
    } catch {}
  }
}

export async function ensureSidecarTunnel(host, port) {
  if (!host || !port || sidecarTunnels.has(port)) return;
  const args = [
    ...SSH_TUNNEL_ARGS,
    '-N',
    '-L', `127.0.0.1:${port}:127.0.0.1:${port}`,
    host,
  ];
  const proc = spawn('ssh', args, {stdio: 'ignore'});
  sidecarTunnels.set(port, proc);
  proc.on('exit', () => {
    if (sidecarTunnels.get(port) === proc) {
      sidecarTunnels.delete(port);
      emitState({});
    }
  });
  await new Promise(r => setTimeout(r, 250));
  emitState({});
}

export async function syncSidecarAuthorities(portMap = {}) {
  const host = mainTunnelHost || sshState.activeHost || 'fei';
  if (!host || sshState.status !== 'connected') return;
  let parsedMap = portMap;
  if (typeof portMap === 'string') {
    try {
      parsedMap = JSON.parse(portMap);
    } catch {
      return;
    }
  }
  if (!parsedMap || typeof parsedMap !== 'object') return;
  for (const urlStr of Object.values(parsedMap)) {
    try {
      const u = new URL(urlStr);
      const port = Number(u.port);
      if (
        port > 1024 &&
        port !== sshState.localHttpsPort &&
        port !== sshState.localTunnelHttpsPort &&
        port !== sshState.localHttpPort &&
        port !== sshState.localBridgePort &&
        port !== sshState.localMacPort
      ) {
        await ensureSidecarTunnel(host, port);
      }
    } catch {}
  }
}

function findLocalAuthStatusDb() {
  const candidates = [
    path.join(os.homedir(), 'Library/Application Support/Antigravity/User/globalStorage/state.vscdb'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function findLocalStandaloneTokenFile() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.gemini/jetski-standalone-oauth-token'),
    path.join(home, '.gemini/antigravity-cli/antigravity-oauth-token'),
    path.join(home, '.gemini/antigravity/antigravity-oauth-token'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).size > 0) return p;
    } catch {}
  }
  return null;
}

let cachedAuthPayloadB64 = '';
let cachedAuthPayloadSig = '';

export async function readLocalAuthPayload() {
  const tokPath = findLocalStandaloneTokenFile();
  const dbPath = findLocalAuthStatusDb();
  const sig = `${tokPath ? statSigFast(tokPath) : '0'}|${dbPath ? statSigFast(dbPath) : '0'}|${dbPath ? statSigFast(`${dbPath}-wal`) : '0'}`;
  if (cachedAuthPayloadB64 && cachedAuthPayloadSig === sig) {
    return cachedAuthPayloadB64;
  }

  let standaloneTokenB64 = '';
  if (tokPath) {
    try {
      standaloneTokenB64 = fs.readFileSync(tokPath).toString('base64');
    } catch {}
  }

  const encodePayloadObj = (obj) => {
    if (!obj || (!obj.standaloneTokenB64 && !obj.authStatusJson && !obj.oauthTokenB64)) return '';
    return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
  };

  if (!dbPath) {
    cachedAuthPayloadB64 = encodePayloadObj({standaloneTokenB64});
    cachedAuthPayloadSig = sig;
    return cachedAuthPayloadB64;
  }
  let db = null;
  try {
    db = new DatabaseSync(dbPath, {readOnly: true});
    const rows = db
      .prepare("SELECT key, value FROM ItemTable WHERE key IN ('antigravityAuthStatus', 'antigravityUnifiedStateSync.oauthToken')")
      .all();
    const map = {};
    for (const r of rows || []) {
      if (r?.key) map[String(r.key)] = String(r.value ?? '');
    }
    cachedAuthPayloadB64 = encodePayloadObj({
      standaloneTokenB64,
      authStatusJson: map.antigravityAuthStatus || '',
      oauthTokenB64: map['antigravityUnifiedStateSync.oauthToken'] || '',
    });
    cachedAuthPayloadSig = sig;
    return cachedAuthPayloadB64;
  } catch {
    cachedAuthPayloadB64 = encodePayloadObj({standaloneTokenB64});
    cachedAuthPayloadSig = sig;
    return cachedAuthPayloadB64;
  } finally {
    try { db?.close(); } catch {}
  }
}

export function probeHostRtt(host, timeoutMs = 4500) {
  const ms = timeoutMs <= 60 ? timeoutMs * 1000 : timeoutMs;
  return new Promise((resolve) => {
    const t0 = Date.now();
    const proc = spawn(
      'ssh',
      [
        ...SSH_BASE_ARGS,
        ...SSH_MUX_ARGS,
        '-o', 'ConnectionAttempts=2',
        '-o', `ConnectTimeout=${Math.max(2, Math.ceil(ms / 1000))}`,
        host,
        'printf ok',
      ],
      {stdio: ['ignore', 'pipe', 'pipe']}
    );
    let out = '';
    let errOut = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      resolve({host, ok: false, latencyMs: Infinity, error: 'timeout'});
    }, ms);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { errOut += d.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.includes('ok')) {
        resolve({host, ok: true, latencyMs: Date.now() - t0});
      } else {
        resolve({host, ok: false, latencyMs: Infinity, error: errOut.trim() || `exit ${code}`});
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({host, ok: false, latencyMs: Infinity, error: err.message});
    });
  });
}
export const probeSshHost = probeHostRtt;

export async function selectBestHost(mode = 'auto', probeFn = probeHostRtt) {
  if (mode === 'fei' || mode === 'fei-tunnel') {
    const fallback = mode === 'fei' ? 'fei-tunnel' : 'fei';
    const primaryTimeoutMs = mode === 'fei-tunnel' ? 9000 : 6000;
    const fallbackTimeoutMs = fallback === 'fei-tunnel' ? 9000 : 6000;
    const primaryPromise = probeFn(mode, primaryTimeoutMs).then((res) => {
      sshState.routeLatencies[mode] = res.ok ? res.latencyMs : null;
      emitState({});
      return res;
    }).catch(() => ({host: mode, ok: false, latencyMs: Infinity}));

    const quickPrimary = await Promise.race([
      primaryPromise,
      new Promise((r) => setTimeout(() => r(null), 350)),
    ]);
    if (quickPrimary && quickPrimary.ok) {
      return quickPrimary;
    }

    const fbPromise = probeFn(fallback, fallbackTimeoutMs).then((res) => {
      sshState.routeLatencies[fallback] = res.ok ? res.latencyMs : null;
      emitState({});
      return res;
    }).catch(() => ({host: fallback, ok: false, latencyMs: Infinity}));

    const probe = quickPrimary || (await primaryPromise);
    if (probe.ok) return probe;

    const fbProbe = await fbPromise;
    if (fbProbe.ok) return fbProbe;
    throw new Error(`Both ${mode} and ${fallback} are unreachable`);
  }

  const directPromise = probeFn('fei', 6000).then((res) => {
    sshState.routeLatencies.fei = res.ok ? res.latencyMs : null;
    emitState({});
    return res;
  }).catch(() => ({host: 'fei', ok: false, latencyMs: Infinity}));

  // If direct route ('fei') responds within 250ms, return immediately without spawning fei-tunnel
  const directImmediate = await Promise.race([
    directPromise,
    new Promise((r) => setTimeout(() => r(null), 250)),
  ]);
  if (directImmediate && directImmediate.ok) {
    return directImmediate;
  }

  const tunnelPromise = probeFn('fei-tunnel', 9000).then((res) => {
    sshState.routeLatencies['fei-tunnel'] = res.ok ? res.latencyMs : null;
    emitState({});
    return res;
  }).catch(() => ({host: 'fei-tunnel', ok: false, latencyMs: Infinity}));

  if (!directImmediate) {
    // Give direct route ('fei') up to 900ms total head-start window if still in-flight
    const directFast = await Promise.race([
      directPromise,
      new Promise((r) => setTimeout(() => r(null), 650)),
    ]);
    if (directFast && directFast.ok && directFast.latencyMs <= 950) {
      return directFast;
    }
  }

  // Otherwise, return whichever route succeeds first without blocking on a timing-out route
  const firstOk = await new Promise((resolve) => {
    let remaining = 2;
    let settled = false;
    const onResult = (res) => {
      if (settled) return;
      if (res && res.ok) {
        settled = true;
        resolve(res);
      } else if (--remaining === 0) {
        settled = true;
        resolve(null);
      }
    };
    directPromise.then(onResult);
    tunnelPromise.then(onResult);
  });

  if (firstOk) return firstOk;
  throw new Error('Cannot reach remote server via primary or fallback SSH tunnel');
}

async function runRemoteCtl(host, action = 'ensure') {
  const authPayload = await readLocalAuthPayload();
  const payloadB64 = authPayload
    ? (typeof authPayload === 'string' ? authPayload : Buffer.from(JSON.stringify(authPayload), 'utf8').toString('base64'))
    : '';
  const remoteScript = fs.readFileSync(REMOTE_CTL_PATH, 'utf8');
  const appVersion = detectLocalAppVersion();
  const execId = await resolveExecutionIdForVersion(appVersion);

  return new Promise((resolve, reject) => {
    const safeAction = ['ensure', 'restart', 'status'].includes(action) ? action : 'ensure';
    const remoteCmd = `mkdir -p ~/.antigravity-server/bin && cat > ~/.antigravity-server/bin/.ag-remote-ctl.py.tmp.$$ && chmod 755 ~/.antigravity-server/bin/.ag-remote-ctl.py.tmp.$$ && mv -f ~/.antigravity-server/bin/.ag-remote-ctl.py.tmp.$$ ~/.antigravity-server/bin/ag-remote-ctl.py && AG_AUTH_PAYLOAD_B64='${payloadB64}' exec python3 ~/.antigravity-server/bin/ag-remote-ctl.py ${safeAction} ${appVersion} ${execId}`;
    const proc = spawn('ssh', [...SSH_BASE_ARGS, ...SSH_MUX_ARGS, host, remoteCmd], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error(`remote-ctl ${action} timed out on ${host}`));
    }, 22000);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const lines = stdout.trim().split('\n').filter(Boolean);
      const lastLine = lines[lines.length - 1] || '';
      try {
        const parsed = JSON.parse(lastLine);
        if (parsed.ok) {
          resolve(parsed);
        } else {
          reject(new Error(parsed.error || `remote-ctl failed (${code}): ${stderr}`));
        }
      } catch {
        reject(new Error(`Invalid JSON from remote-ctl (${code}): ${stderr || stdout}`));
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.stdin.write(remoteScript);
    proc.stdin.end();
  });
}

function checkHttpsLocal(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = https.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/',
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d.toString(); });
        res.on('end', () => {
          const csrfMatch = body.match(/"csrfToken"\s*:\s*"([^"]+)"/);
          resolve({
            ok: res.statusCode === 200 && body.includes('csrfToken'),
            body,
            csrfToken: csrfMatch ? csrfMatch[1] : '',
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ok: false});
    });
    req.on('error', () => resolve({ok: false}));
  });
}

let lastLocalLsPortVerifiedTs = 0;

export async function discoverLocalMacLsPort() {
  if (sshState.localMacPort && sshState.localMacPort !== 58282 && sshState.localMacPort !== 58285) {
    if (sshState.localMacCsrfToken && Date.now() - lastLocalLsPortVerifiedTs < 15000) {
      return sshState.localMacPort;
    }
    const chk = await checkHttpsLocal(sshState.localMacPort, 1000);
    if (chk.ok) {
      lastLocalLsPortVerifiedTs = Date.now();
      if (chk.csrfToken && chk.csrfToken !== sshState.localMacCsrfToken) {
        sshState.localMacCsrfToken = chk.csrfToken;
      }
      return sshState.localMacPort;
    }
  }
  return new Promise((resolve) => {
    const proc = spawn('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('close', async () => {
      const ports = new Set();
      for (const line of out.split('\n')) {
        if (!line.includes('language_')) continue;
        const m = line.match(/127\.0\.0\.1:(\d+)\s+\(LISTEN\)/);
        if (m) {
          const p = Number(m[1]);
          if (p !== 58282 && p !== 58285 && p !== 58283 && p !== 58284) ports.add(p);
        }
      }
      for (const p of ports) {
        const chk = await checkHttpsLocal(p, 1200);
        if (chk.ok) {
          sshState.localMacPort = p;
          if (chk.csrfToken) sshState.localMacCsrfToken = chk.csrfToken;
          lastLocalLsPortVerifiedTs = Date.now();
          resolve(p);
          return;
        }
      }
      resolve(sshState.localMacPort || 0);
    });
    proc.on('error', () => resolve(sshState.localMacPort || 0));
  });
}

function fetchBridgeStatus(bridgePort, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port: bridgePort,
        path: '/status',
        agent: bridgeHttpAgent,
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d.toString(); });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

function pingBridge(bridgePort, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port: bridgePort,
        path: '/ping',
        agent: bridgeHttpAgent,
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d.toString(); });
        res.on('end', () => {
          resolve({ok: res.statusCode === 200, latencyMs: Date.now() - t0});
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ok: false, latencyMs: Infinity});
    });
    req.on('error', () => resolve({ok: false, latencyMs: Infinity}));
  });
}

export async function stopRemoteTunnel(nextMode = 'local') {
  connectGeneration += 1;
  connectingPromise = null;
  connectingMode = '';
  if (mainTunnelProc) {
    try { mainTunnelProc.kill('SIGTERM'); } catch {}
    mainTunnelProc = null;
  }
  mainTunnelHost = null;
  resetUpstreamH2();
  for (const proc of sidecarTunnels.values()) {
    try { proc.kill('SIGTERM'); } catch {}
  }
  sidecarTunnels.clear();
  await discoverLocalMacLsPort();
  const st = emitState({
    mode: nextMode,
    status: 'disconnected',
    activeHost: '',
    latencyMs: 0,
    lastError: '',
  });
  pushMergedProjectListToBrowsers().catch(() => {});
  return st;
}

function isLocalPortListening(port, timeoutMs = 120) {
  return new Promise((resolve) => {
    const sock = net.connect({host: '127.0.0.1', port});
    let done = false;
    const finish = (val) => {
      if (!done) {
        done = true;
        sock.destroy();
        resolve(val);
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on('connect', () => {
      clearTimeout(timer);
      finish(true);
    });
    sock.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

async function killStaleSshForwards() {
  const checkPorts = [58283, 58284, 58285];
  const busyCheck = await Promise.all(checkPorts.map((p) => isLocalPortListening(p)));
  if (!busyCheck.some(Boolean)) return;

  await new Promise((resolve) => {
    const proc = spawn('pkill', ['-f', '127\\.0\\.0\\.1:(58282|58283|58284|58285):127\\.0\\.0\\.1:']);
    proc.on('close', () => resolve());
    proc.on('error', () => resolve());
  });

  const deadline = Date.now() + 600;
  let escalated = false;
  while (Date.now() < deadline) {
    const states = await Promise.all(checkPorts.map((p) => isLocalPortListening(p)));
    if (!states.some(Boolean)) return;
    if (!escalated && Date.now() + 300 >= deadline) {
      escalated = true;
      await new Promise((resolve) => {
        const proc = spawn('pkill', ['-9', '-f', '127\\.0\\.0\\.1:(58282|58283|58284|58285):127\\.0\\.0\\.1:']);
        proc.on('close', () => resolve());
        proc.on('error', () => resolve());
      });
    }
    await new Promise((r) => setTimeout(r, 40));
  }
}

export async function ensureRemoteTunnel(requestedMode = sshState.mode, options = {}) {
  const {forceRestart = false, forceReconnect = false} = options;
  const targetMode = requestedMode || 'auto';
  sshState.mode = targetMode;

  ensureLocalHttpsProxy();
  await discoverLocalMacLsPort();

  if (targetMode === 'local') {
    return stopRemoteTunnel('local');
  }

  // If an identical connection attempt is already in flight and no remote server restart was requested, reuse it
  if (connectingPromise && connectingMode === targetMode && !forceRestart) {
    return connectingPromise;
  }

  if (
    !forceReconnect &&
    !forceRestart &&
    mainTunnelProc &&
    mainTunnelProc.exitCode === null &&
    sshState.status === 'connected' &&
    (targetMode === 'auto' || mainTunnelHost === targetMode)
  ) {
    const ping = await pingBridge(sshState.localBridgePort, 2000);
    if (ping.ok) {
      if (mainTunnelHost) sshState.routeLatencies[mainTunnelHost] = ping.latencyMs;
      return emitState({latencyMs: ping.latencyMs, status: 'connected'});
    }
  }

  const myGen = ++connectGeneration;
  connectingMode = targetMode;
  const isStale = () => myGen !== connectGeneration;

  connectingPromise = (async () => {
    try {
      emitState({mode: targetMode, status: 'connecting', lastError: ''});
      const best = await selectBestHost(targetMode);
      if (isStale()) return getSshState();

      const establishOnHost = async (host, initialRtt = 0) => {
        warmupWwwCacheFromRemote(host).catch(() => {});
        const isTunnelRoute = host.includes('tunnel');
        const tHttps = 58285;
        const lHttp = 58283;
        const lBridge = 58284;

        const startTunnelProcess = async (rHttps = 58282, rHttp = 58283, rBridge = 58284, isFastProbe = false) => {
          if (isStale()) return {ok: false, error: 'Superseded by newer connection request'};
          if (mainTunnelProc) {
            try { mainTunnelProc.kill('SIGTERM'); } catch {}
            mainTunnelProc = null;
          }
          resetUpstreamH2();
          await killStaleSshForwards();
          if (isStale()) return {ok: false, error: 'Superseded by newer connection request'};

          const forwardArgs = [
            ...SSH_TUNNEL_ARGS,
            '-N',
            '-L', `127.0.0.1:${tHttps}:127.0.0.1:${rHttps}`,
            '-L', `127.0.0.1:${lHttp}:127.0.0.1:${rHttp}`,
            '-L', `127.0.0.1:${lBridge}:127.0.0.1:${rBridge}`,
            host,
          ];
          const proc = spawn('ssh', forwardArgs, {stdio: ['ignore', 'pipe', 'pipe']});
          mainTunnelProc = proc;
          mainTunnelHost = host;

          let stderrText = '';
          proc.stderr.on('data', (d) => { stderrText += d.toString(); });
          proc.on('exit', () => {
            if (mainTunnelProc === proc) {
              mainTunnelProc = null;
              mainTunnelHost = null;
              resetUpstreamH2();
            }
          });

          const maxWaitMs = isFastProbe
            ? (isTunnelRoute ? 11000 : 6000)
            : (isTunnelRoute ? 16000 : 12000);
          const probeTimeoutMs = isTunnelRoute ? 6500 : 3000;
          const deadline = Date.now() + maxWaitMs;

          await new Promise((r) => setTimeout(r, 120));

          while (Date.now() < deadline) {
            if (isStale()) {
              try { proc.kill('SIGTERM'); } catch {}
              return {ok: false, error: 'Superseded by newer connection request'};
            }
            if (proc.exitCode !== null) {
              return {ok: false, error: `SSH port-forward exited (${proc.exitCode}): ${stderrText.trim()}`};
            }
            const [st, httpsChk] = await Promise.all([
              fetchBridgeStatus(lBridge, probeTimeoutMs),
              checkHttpsLocal(tHttps, probeTimeoutMs),
            ]);
            if (st?.ok && st?.running && httpsChk.ok) {
              const ping = await pingBridge(lBridge, 2500);
              return {ok: true, statusInfo: st, pingRtt: ping.ok ? ping.latencyMs : (initialRtt || 0)};
            }
            if (
              isFastProbe &&
              (stderrText.includes('Connection refused') ||
                stderrText.includes('connect failed') ||
                stderrText.includes('open failed') ||
                (st && st.running === false))
            ) {
              break;
            }
            await new Promise((r) => setTimeout(r, 140));
          }
          try { proc.kill('SIGTERM'); } catch {}
          return {ok: false, error: `Timed out waiting for forwarded ports (${tHttps}/${lBridge}) on ${host}`};
        };

        let remoteInfo = null;
        let pingRtt = initialRtt || 0;
        let rHttps = 58282, rHttp = 58283, rBridge = 58284;

        const desiredAppVersion = detectLocalAppVersion();
        if (!forceRestart) {
          const fastTry = await startTunnelProcess(rHttps, rHttp, rBridge, true);
          if (isStale()) throw new Error('Superseded');
          if (
            fastTry.ok &&
            fastTry.statusInfo?.bridgeVersion === EXPECTED_BRIDGE_VERSION &&
            (!fastTry.statusInfo?.version || fastTry.statusInfo.version === desiredAppVersion)
          ) {
            remoteInfo = fastTry.statusInfo;
            pingRtt = fastTry.pingRtt;
            rHttps = Number(remoteInfo.httpsPort) || 58282;
            rHttp = Number(remoteInfo.httpPort) || 58283;
            rBridge = Number(remoteInfo.bridgePort) || 58284;
          } else if (fastTry.ok) {
            try { mainTunnelProc?.kill('SIGTERM'); } catch {}
            mainTunnelProc = null;
          }
        }

        if (!remoteInfo) {
          if (isStale()) throw new Error('Superseded');
          remoteInfo = await runRemoteCtl(host, forceRestart ? 'restart' : 'ensure');
          if (isStale()) throw new Error('Superseded');
          rHttps = Number(remoteInfo.httpsPort) || 58282;
          rHttp = Number(remoteInfo.httpPort) || 58283;
          rBridge = Number(remoteInfo.bridgePort) || 58284;
          const secondTry = await startTunnelProcess(rHttps, rHttp, rBridge, false);
          if (!secondTry.ok) {
            throw new Error(secondTry.error);
          }
          pingRtt = secondTry.pingRtt;
        }

        return {host, remoteInfo, pingRtt, rHttps, rHttp, rBridge, tHttps, lHttp, lBridge};
      };

      let established;
      try {
        established = await establishOnHost(best.host, best.latencyMs);
      } catch (primaryErr) {
        if (isStale()) return getSshState();
        const altHost = best.host === 'fei' ? 'fei-tunnel' : 'fei';
        const altProbe = await probeHostRtt(altHost, 8500);
        sshState.routeLatencies[altHost] = altProbe.ok ? altProbe.latencyMs : null;
        if (altProbe.ok && !isStale()) {
          established = await establishOnHost(altHost, altProbe.latencyMs);
        } else {
          throw primaryErr;
        }
      }

      if (isStale()) return getSshState();
      const {host, remoteInfo, pingRtt, rHttps, rHttp, rBridge, tHttps, lHttp, lBridge} = established;
      consecutivePingFailures = 0;
      if (host !== sshState.activeHost) lastRouteSwitchTs = Date.now();
      rttEwmaMs = 0;
      noteRtt(pingRtt);
      logSsh(`SSH tunnel up via ${host} (rtt=${pingRtt}ms)`);
      sshState.csrfToken = remoteInfo.csrfToken || sshState.csrfToken;
      if (pingRtt > 0) sshState.routeLatencies[host] = pingRtt;
      handleOpenUrls(remoteInfo.openUrls, host);

      if (sidecarTunnels.size > 0) {
        const fakeMap = {};
        for (const p of sidecarTunnels.keys()) fakeMap[`sc-${p}`] = `http://localhost:${p}`;
        await syncSidecarAuthorities(fakeMap);
      }

      emitState({
        mode: targetMode,
        status: 'connected',
        activeHost: host,
        latencyMs: pingRtt,
        localHttpsPort: 58282,
        localTunnelHttpsPort: tHttps,
        localHttpPort: lHttp,
        localBridgePort: lBridge,
        remoteHttpsPort: rHttps,
        remoteHttpPort: rHttp,
        remoteBridgePort: rBridge,
        remotePid: remoteInfo.pid || 0,
        remoteHostname: remoteInfo.hostname || 'remote-host',
        remoteArch: remoteInfo.arch || 'x86_64',
        remoteHomeDir: remoteInfo.homeDir || '/home/user',
        csrfToken: remoteInfo.csrfToken || '',
        hasAuth: remoteInfo.hasAuth !== false,
        lastError: '',
      });

      await pushMergedProjectListToBrowsers().catch(() => {});
      await syncCliSummariesAndPushUpdates().catch(() => {});
      ensureCliSummariesWatcher();
      return getSshState();
    } catch (err) {
      if (isStale()) return getSshState();
      logSsh(`SSH tunnel connect failed (mode=${targetMode}): ${err.message || err}`);
      return emitState({
        mode: targetMode,
        status: 'error',
        lastError: err.message || String(err),
      });
    } finally {
      if (myGen === connectGeneration) {
        connectingPromise = null;
        connectingMode = '';
      }
    }
  })();

  return connectingPromise;
}

// ---- Link health -------------------------------------------------------------------
// Reconnecting is expensive: every upstream H2 stream (conversation updates, summaries,
// project watchers) dies with the tunnel and the UI has to re-fetch history. So we only
// tear the tunnel down when the link is really gone, not when one ping was slow because a
// large response was in flight.
let healthPollInFlight = false;
let rttEwmaMs = 0;
let lastHealthyTs = 0;
let directGoodStreak = 0;
let lastRouteSwitchTs = 0;
let sshLogger = null;
const HEALTH_FAIL_BUDGET = 3;           // consecutive failed polls ...
const HEALTH_FAIL_MIN_WINDOW_MS = 30000; // ... spanning at least this long
const ROUTE_SWITCH_MIN_INTERVAL_MS = 120000;
const DIRECT_GOOD_STREAK_REQUIRED = 3;

export function setSshLogger(fn) {
  sshLogger = typeof fn === 'function' ? fn : null;
}

function logSsh(message) {
  try { sshLogger?.(message); } catch {}
}

function noteRtt(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  rttEwmaMs = rttEwmaMs ? Math.round(rttEwmaMs * 0.7 + ms * 0.3) : ms;
  lastHealthyTs = Date.now();
}

// Timeout that scales with the observed RTT so a 400ms relay link gets more slack than LAN.
function adaptiveTimeout(baseMs, maxMs = 15000) {
  return Math.min(maxMs, Math.max(baseMs, rttEwmaMs * 8));
}

function reconnectTunnel(reason) {
  logSsh(`Reconnecting SSH tunnel (mode=${sshState.mode}, host=${mainTunnelHost || sshState.activeHost || '-'}): ${reason}`);
  return ensureRemoteTunnel(sshState.mode, {forceReconnect: true});
}

export async function pollTunnelHealth() {
  if (healthPollInFlight) return getSshState();
  healthPollInFlight = true;
  try {
    return await pollTunnelHealthOnce();
  } finally {
    healthPollInFlight = false;
  }
}

async function pollTunnelHealthOnce() {
  ensureLocalPatchedMainJs();
  await discoverLocalMacLsPort();
  syncCliSummariesAndPushUpdates().catch(() => {});
  if (sshState.mode === 'local') return getSshState();
  if (connectingPromise) return getSshState();

  if (!mainTunnelProc || mainTunnelProc.exitCode !== null || sshState.status !== 'connected') {
    consecutivePingFailures += 1;
    const why = !mainTunnelProc
      ? 'no tunnel process'
      : mainTunnelProc.exitCode !== null
        ? `ssh exited (${mainTunnelProc.exitCode})`
        : `status=${sshState.status}`;
    return reconnectTunnel(why);
  }

  const ping = await pingBridge(sshState.localBridgePort, adaptiveTimeout(4000));
  if (ping.ok) {
    consecutivePingFailures = 0;
    noteRtt(ping.latencyMs);
    if (mainTunnelHost) sshState.routeLatencies[mainTunnelHost] = ping.latencyMs;
    const st = await fetchBridgeStatus(sshState.localBridgePort, adaptiveTimeout(4000));
    if (st?.openUrls?.length) handleOpenUrls(st.openUrls, mainTunnelHost || sshState.activeHost || 'fei');
    const desiredAppVersion = detectLocalAppVersion();
    if (
      st &&
      (st.running === false ||
        (st.version && st.version !== desiredAppVersion) ||
        (st.bridgeVersion && st.bridgeVersion !== EXPECTED_BRIDGE_VERSION))
    ) {
      return reconnectTunnel(
        st.running === false
          ? 'remote language_server not running'
          : `remote version mismatch (ls=${st.version}, bridge=${st.bridgeVersion})`
      );
    }

    // Auto mode on the relay: only move back to the direct route after it has been
    // consistently good for a while, and never more than once per ROUTE_SWITCH_MIN_INTERVAL_MS.
    // Each switch drops every live stream, so flapping is worse than staying on the relay.
    if (sshState.mode === 'auto' && mainTunnelHost === 'fei-tunnel') {
      probeHostRtt('fei', 2000).then((pFei) => {
        sshState.routeLatencies.fei = pFei.ok ? pFei.latencyMs : null;
        directGoodStreak = pFei.ok && pFei.latencyMs <= 500 ? directGoodStreak + 1 : 0;
        if (
          directGoodStreak >= DIRECT_GOOD_STREAK_REQUIRED &&
          Date.now() - lastRouteSwitchTs >= ROUTE_SWITCH_MIN_INTERVAL_MS &&
          !connectingPromise &&
          sshState.mode === 'auto' &&
          mainTunnelHost === 'fei-tunnel'
        ) {
          directGoodStreak = 0;
          lastRouteSwitchTs = Date.now();
          reconnectTunnel(`direct route healthy again (${pFei.latencyMs}ms), leaving relay`).catch(() => {});
        }
      }).catch(() => {});
    } else {
      directGoodStreak = 0;
    }

    if (Object.keys(sshState.projectEnvMap).length === 0 || sshState.remoteProjectIds.length === 0) {
      pushMergedProjectListToBrowsers().catch(() => {});
    }
    return emitState({
      status: 'connected',
      activeHost: mainTunnelHost || sshState.activeHost || 'fei',
      latencyMs: ping.latencyMs,
      remotePid: st?.pid || sshState.remotePid,
      csrfToken: st?.csrfToken || sshState.csrfToken,
      hasAuth: st?.hasAuth ?? sshState.hasAuth,
      lastError: '',
    });
  }

  consecutivePingFailures += 1;
  const sinceHealthy = lastHealthyTs ? Date.now() - lastHealthyTs : Infinity;
  // ssh itself is still alive (its own keepalive hasn't given up), so a missed ping most
  // likely means the link is congested, not dead. Keep the tunnel and its streams.
  if (
    mainTunnelProc &&
    mainTunnelProc.exitCode === null &&
    (consecutivePingFailures < HEALTH_FAIL_BUDGET || sinceHealthy < HEALTH_FAIL_MIN_WINDOW_MS)
  ) {
    return getSshState();
  }
  return reconnectTunnel(`bridge unreachable for ${consecutivePingFailures} polls (${Math.round(sinceHealthy / 1000)}s)`);
}

export async function fetchRemoteConversationRaw(cascadeId, lastSig = '', afterIdx = -1) {
  if (!cascadeId || sshState.status !== 'connected') return null;
  const pathStr = `/metrics?cascadeId=${encodeURIComponent(cascadeId)}&sig=${encodeURIComponent(lastSig || '')}&afterIdx=${encodeURIComponent(String(afterIdx))}`;
  // A full (non-delta) fetch can be MBs; give it time to finish once instead of aborting
  // at 3s and re-downloading it on every poll.
  const isFull = !(afterIdx >= 0);
  return fetchBridgeJson(pathStr, isFull ? adaptiveTimeout(20000, 45000) : adaptiveTimeout(5000));
}
