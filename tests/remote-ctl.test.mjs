import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REMOTE_CTL = path.join(ROOT, 'remote', 'remote-ctl.py');
const EXPECTED_BRIDGE_VERSION = '20261118-ssh-v17';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const {port} = s.address();
      s.close(() => resolve(port));
    });
  });
}

function httpRequest({port, method = 'GET', reqPath = '/', headers = {}, body = null}) {
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, method, path: reqPath, headers, agent: false}, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          buf: Buffer.concat(chunks),
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function startFakeLs() {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates') {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, {'content-type': 'application/connect+json'});
        const payload = Buffer.from(JSON.stringify({ok: true}), 'utf8');
        const frame = Buffer.alloc(5 + payload.length);
        frame[0] = 0;
        frame.writeUInt32BE(payload.length, 1);
        payload.copy(frame, 5);
        const endPayload = Buffer.from('{}', 'utf8');
        const endFrame = Buffer.alloc(5 + endPayload.length);
        endFrame[0] = 0x02;
        endFrame.writeUInt32BE(endPayload.length, 1);
        endPayload.copy(endFrame, 5);
        res.end(Buffer.concat([frame, endFrame]));
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({server, port: server.address().port})));
}

async function startBridgeDaemon({home, port, env = {}}) {
  const proc = spawn('python3', ['-I', REMOTE_CTL, 'bridge-daemon', String(port)], {
    env: {
      ...process.env,
      HOME: home,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  for (let i = 0; i < 80; i++) {
    if (proc.exitCode !== null) {
      throw new Error(`bridge-daemon exited early (${proc.exitCode}): ${stderr}`);
    }
    try {
      const r = await httpRequest({port, reqPath: '/ping'});
      if (r.status === 200) return proc;
    } catch {}
    await sleep(40);
  }
  proc.kill('SIGKILL');
  throw new Error(`bridge-daemon failed to listen on ${port}: ${stderr}`);
}

function runPyHelper(script, env = {}) {
  const proc = spawnSync('python3', ['-c', script], {
    env: {
      ...process.env,
      REMOTE_CTL_PATH: REMOTE_CTL,
      ...env,
    },
    encoding: 'utf8',
  });
  if (proc.status !== 0) {
    throw new Error(`python3 exited ${proc.status}: ${proc.stderr || proc.stdout}`);
  }
  return JSON.parse(proc.stdout.trim());
}

test('bridge-daemon enforces AG_BRIDGE_TOKEN on /status and /relay/stream while keeping /ping unauthenticated', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-rc-auth-'));
  const token = crypto.randomBytes(32).toString('hex');
  const ls = await startFakeLs();
  const port = await freePort();
  const proc = await startBridgeDaemon({
    home,
    port,
    env: {
      AG_BRIDGE_RELAY_ONLY: '1',
      AG_BRIDGE_TOKEN: token,
      AG_RELAY_UPSTREAM: `127.0.0.1:${ls.port}`,
    },
  });
  try {
    const pingRes = await httpRequest({port, reqPath: '/ping'});
    assert.equal(pingRes.status, 200);
    const pingJson = JSON.parse(pingRes.text);
    assert.equal(pingJson.ok, true);
    assert.equal(typeof pingJson.ts, 'number');
    assert.equal(typeof pingJson.hostname, 'string');
    assert.equal('bridgeToken' in pingJson, false);

    const statusNoAuth = await httpRequest({port, reqPath: '/status'});
    assert.equal(statusNoAuth.status, 401);
    assert.deepEqual(JSON.parse(statusNoAuth.text), {ok: false, error: 'unauthorized'});

    const statusBadAuth = await httpRequest({
      port,
      reqPath: '/status',
      headers: {'x-ag-bridge-token': '0'.repeat(64)},
    });
    assert.equal(statusBadAuth.status, 401);

    const relayReqBody = JSON.stringify({
      id: 'test-stream-001',
      afterSeq: 0,
      path: '/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates',
      headers: {'content-type': 'application/connect+json'},
      bodyB64: Buffer.from('{}').toString('base64'),
    });

    const relayNoAuth = await httpRequest({
      port,
      method: 'POST',
      reqPath: '/relay/stream',
      headers: {'content-type': 'application/json', 'content-length': Buffer.byteLength(relayReqBody)},
      body: relayReqBody,
    });
    assert.equal(relayNoAuth.status, 401);
    assert.deepEqual(JSON.parse(relayNoAuth.text), {ok: false, error: 'unauthorized'});

    const statusOk = await httpRequest({
      port,
      reqPath: '/status',
      headers: {'x-ag-bridge-token': token},
    });
    assert.equal(statusOk.status, 200);
    const statusJson = JSON.parse(statusOk.text);
    assert.equal(statusJson.ok, true);
    assert.equal(statusJson.bridgeVersion, EXPECTED_BRIDGE_VERSION);

    const statusMixedCase = await httpRequest({
      port,
      reqPath: '/status',
      headers: {'X-Ag-Bridge-Token': token},
    });
    assert.equal(statusMixedCase.status, 200);

    const relayOk = await httpRequest({
      port,
      method: 'POST',
      reqPath: '/relay/stream',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(relayReqBody),
        'x-ag-bridge-token': token,
      },
      body: relayReqBody,
    });
    assert.equal(relayOk.status, 200);
    assert.equal(relayOk.headers['x-ag-relay-protocol'], '1');
    assert.ok(relayOk.buf.length > 0);
  } finally {
    proc.kill('SIGKILL');
    ls.server.close();
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('bridge-daemon skips auth in AG_BRIDGE_RELAY_ONLY=1 without AG_BRIDGE_TOKEN, and loads bridge.json fallback otherwise', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-rc-relayonly-'));
  const port = await freePort();
  const proc = await startBridgeDaemon({
    home,
    port,
    env: {AG_BRIDGE_RELAY_ONLY: '1'},
  });
  try {
    const statsRes = await httpRequest({port, reqPath: '/relay/stats'});
    assert.equal(statsRes.status, 200);
    assert.equal(JSON.parse(statsRes.text).ok, true);
  } finally {
    proc.kill('SIGKILL');
    fs.rmSync(home, {recursive: true, force: true});
  }

  const homeFallback = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-rc-fallback-'));
  try {
    const runDir = path.join(homeFallback, '.antigravity-server', 'run');
    fs.mkdirSync(runDir, {recursive: true, mode: 0o700});
    const tok = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(runDir, 'bridge.json'), JSON.stringify({bridgeToken: tok}), {mode: 0o600});
    const res = runPyHelper(
      `
import importlib.util, json, os
spec = importlib.util.spec_from_file_location("remote_ctl", os.environ["REMOTE_CTL_PATH"])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
os.environ.pop("AG_BRIDGE_TOKEN", None)
os.environ.pop("AG_BRIDGE_RELAY_ONLY", None)
loaded = mod._resolve_expected_bridge_token()
os.unlink(os.path.join(os.environ["HOME"], ".antigravity-server", "run", "bridge.json"))
missing = mod._resolve_expected_bridge_token()
print(json.dumps({"loaded": loaded, "missing": missing, "ver": mod.BRIDGE_DAEMON_VERSION}))
`,
      {HOME: homeFallback}
    );
    assert.equal(res.loaded, tok);
    assert.equal(res.missing, '');
    assert.equal(res.ver, EXPECTED_BRIDGE_VERSION);
  } finally {
    fs.rmSync(homeFallback, {recursive: true, force: true});
  }
});

test('ensure_bridge_daemon persists 0o600 bridge.json + bridge.log and spawns authenticated daemon', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-rc-ensure-bridge-'));
  const port = await freePort();
  let spawnedPid = 0;
  try {
    const res = runPyHelper(
      `
import importlib.util, json, os
spec = importlib.util.spec_from_file_location("remote_ctl", os.environ["REMOTE_CTL_PATH"])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
run_dir = os.path.join(os.environ["HOME"], ".antigravity-server", "run")
os.makedirs(run_dir, mode=0o700, exist_ok=True)
b_port, b_tok = mod.ensure_bridge_daemon(run_dir, ${port})
st_json = os.stat(os.path.join(run_dir, "bridge.json"))
st_log = os.stat(os.path.join(run_dir, "bridge.log"))
with open(os.path.join(run_dir, "bridge.json")) as f:
    saved = json.load(f)
print(json.dumps({
    "port": b_port,
    "token": b_tok,
    "jsonMode": st_json.st_mode & 0o777,
    "logMode": st_log.st_mode & 0o777,
    "saved": saved,
}))
`,
      {HOME: home}
    );
    spawnedPid = res.saved.pid;
    assert.equal(res.port, port);
    assert.match(res.token, /^[0-9a-f]{64}$/);
    assert.equal(res.saved.bridgeToken, res.token);
    assert.equal(res.saved.version, EXPECTED_BRIDGE_VERSION);
    assert.equal(res.jsonMode, 0o600);
    assert.equal(res.logMode, 0o600);

    const noAuth = await httpRequest({port, reqPath: '/status'});
    assert.equal(noAuth.status, 401);
    const withAuth = await httpRequest({
      port,
      reqPath: '/status',
      headers: {'x-ag-bridge-token': res.token},
    });
    assert.equal(withAuth.status, 200);
  } finally {
    if (spawnedPid > 0) {
      try { process.kill(spawnedPid, 'SIGKILL'); } catch {}
    }
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('sanitize_git_worktree_configs preserves .git/config when worktree config.worktree exists and atomically sanitizes stale configs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-rc-wt-'));
  try {
    const repoSubWt = path.join(home, 'repo-sub-wt');
    fs.mkdirSync(path.join(repoSubWt, '.git', 'worktrees', 'wt1'), {recursive: true});
    const wtSubCfg = '[core]\n\trepositoryformatversion = 0\n[extensions]\n\tworktreeConfig = true\n';
    fs.writeFileSync(path.join(repoSubWt, '.git', 'config'), wtSubCfg, {mode: 0o644});
    fs.writeFileSync(path.join(repoSubWt, '.git', 'worktrees', 'wt1', 'config.worktree'), '[user]\n\tname = test\n');

    const repoRootWt = path.join(home, 'repo-root-wt');
    fs.mkdirSync(path.join(repoRootWt, '.git'), {recursive: true});
    fs.writeFileSync(path.join(repoRootWt, '.git', 'config'), wtSubCfg, {mode: 0o644});
    fs.writeFileSync(path.join(repoRootWt, '.git', 'config.worktree'), '[user]\n\tname = test\n');

    const repoStale = path.join(home, 'repo-stale');
    fs.mkdirSync(path.join(repoStale, '.git'), {recursive: true});
    fs.writeFileSync(path.join(repoStale, '.git', 'config'), wtSubCfg, {mode: 0o640});

    const repoMultiExt = path.join(home, 'repo-multi-ext');
    fs.mkdirSync(path.join(repoMultiExt, '.git'), {recursive: true});
    const multiCfg = '[core]\n\trepositoryformatversion = 0\n[extensions]\n\tworktreeConfig = true\n\tobjectFormat = sha256\n';
    fs.writeFileSync(path.join(repoMultiExt, '.git', 'config'), multiCfg, {mode: 0o640});

    const res = runPyHelper(
      `
import importlib.util, json, os
spec = importlib.util.spec_from_file_location("remote_ctl", os.environ["REMOTE_CTL_PATH"])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
orig_isdir = os.path.isdir
os.path.isdir = lambda p: False if p == "/develop" else orig_isdir(p)
try:
    mod.sanitize_git_worktree_configs()
finally:
    os.path.isdir = orig_isdir
print(json.dumps({
    "subWt": open(os.path.join(os.environ["HOME"], "repo-sub-wt", ".git", "config")).read(),
    "rootWt": open(os.path.join(os.environ["HOME"], "repo-root-wt", ".git", "config")).read(),
    "stale": open(os.path.join(os.environ["HOME"], "repo-stale", ".git", "config")).read(),
    "staleMode": os.stat(os.path.join(os.environ["HOME"], "repo-stale", ".git", "config")).st_mode & 0o777,
    "staleFiles": sorted(os.listdir(os.path.join(os.environ["HOME"], "repo-stale", ".git"))),
    "multiExt": open(os.path.join(os.environ["HOME"], "repo-multi-ext", ".git", "config")).read(),
}))
`,
      {HOME: home}
    );

    assert.equal(res.subWt, wtSubCfg);
    assert.equal(res.rootWt, wtSubCfg);
    assert.equal(res.stale, '[core]\n\trepositoryformatversion = 0\n');
    assert.equal(res.staleMode, 0o640);
    assert.deepEqual(res.staleFiles, ['config']);
    assert.equal(res.multiExt, '[core]\n\trepositoryformatversion = 0\n[extensions]\n\tobjectFormat = sha256\n');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('incremental extract_open_urls handles appended lines, truncation, and inode replacement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-rc-urls-'));
  try {
    const res = runPyHelper(`
import builtins, importlib.util, json, os
spec = importlib.util.spec_from_file_location("remote_ctl", os.environ["REMOTE_CTL_PATH"])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

log_path = os.path.join(os.environ["TEST_DIR"], "server.log")
with open(log_path, "w", encoding="utf-8") as f:
    f.write("booting\\nANTIGRAVITY_OPEN_URL: https://example.com/1\\n")

reads = []
orig_open = builtins.open
def spy_open(file, mode="r", *args, **kwargs):
    fh = orig_open(file, mode, *args, **kwargs)
    if file == log_path and "b" in mode:
        orig_read = fh.read
        orig_seek = fh.seek
        seek_calls = []
        fh.seek = lambda pos, *a: (seek_calls.append(pos), orig_seek(pos, *a))[1]
        reads.append(seek_calls)
    return fh

builtins.open = spy_open
try:
    u1 = mod.extract_open_urls(log_path)
    # Same size -> should not even open the file
    u1_cached = mod.extract_open_urls(log_path)

    # Append new lines -> should seek to previous offset
    with orig_open(log_path, "a", encoding="utf-8") as f:
        f.write("noise line\\nANTIGRAVITY_OPEN_URL: https://example.com/2\\n")
    u2 = mod.extract_open_urls(log_path)

    # Truncate to 0 -> resets cache
    with orig_open(log_path, "w", encoding="utf-8") as f:
        pass
    u_empty = mod.extract_open_urls(log_path)

    # Write shorter content -> resets and picks up new URL
    with orig_open(log_path, "w", encoding="utf-8") as f:
        f.write("ANTIGRAVITY_OPEN_URL: https://example.com/3\\n")
    u3 = mod.extract_open_urls(log_path)

    # Replace via os.replace (new st_ino, larger size than before) -> resets cache
    tmp_path = log_path + ".new"
    with orig_open(tmp_path, "w", encoding="utf-8") as f:
        f.write("ANTIGRAVITY_OPEN_URL: https://example.com/4\\nANTIGRAVITY_OPEN_URL: https://example.com/5\\n")
    os.replace(tmp_path, log_path)
    u4 = mod.extract_open_urls(log_path)
finally:
    builtins.open = orig_open

print(json.dumps({
    "u1": u1,
    "u1_cached": u1_cached,
    "u2": u2,
    "u_empty": u_empty,
    "u3": u3,
    "u4": u4,
    "seekCalls": reads,
}))
`, {TEST_DIR: dir});

    assert.deepEqual(res.u1, ['https://example.com/1']);
    assert.deepEqual(res.u1_cached, ['https://example.com/1']);
    assert.deepEqual(res.u2, ['https://example.com/1', 'https://example.com/2']);
    assert.deepEqual(res.u_empty, []);
    assert.deepEqual(res.u3, ['https://example.com/3']);
    assert.deepEqual(res.u4, ['https://example.com/4', 'https://example.com/5']);
    // First read seeks to 0, cached read doesn't open, append read seeks > 0, truncation/replacement seek to 0
    assert.equal(res.seekCalls.length, 4);
    assert.equal(res.seekCalls[0][0], 0);
    assert.ok(res.seekCalls[1][0] > 0);
    assert.equal(res.seekCalls[2][0], 0);
    assert.equal(res.seekCalls[3][0], 0);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('ensure_patched_web_bundle extracts via mmap and patches embedded zip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-rc-mmap-'));
  try {
    const res = runPyHelper(`
import importlib.util, io, json, mmap, os, zipfile
spec = importlib.util.spec_from_file_location("remote_ctl", os.environ["REMOTE_CTL_PATH"])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

bin_path = os.path.join(os.environ["TEST_DIR"], "language_server")
zbuf = io.BytesIO()
with zipfile.ZipFile(zbuf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
    zf.writestr("compiled_tailwind.css", "body{}")
    zf.writestr("index.html", "<html><head><title>t</title></head><body></body></html>")
    zf.writestr("main.js", "console.log(window.dialog, x===enumObj.CortexTrajectorySource.JETBOX);")

with open(bin_path, "wb") as f:
    f.write(b"\\x7fELF" + b"\\x00" * 4096)
    f.write(zbuf.getvalue())
    f.write(b"\\x00" * 128)

out_zip = mod.ensure_patched_web_bundle(bin_path)
with zipfile.ZipFile(out_zip, "r") as zf:
    idx_html = zf.read("index.html").decode("utf-8")
    main_js = zf.read("main.js").decode("utf-8")
ver = open(os.path.join(os.environ["TEST_DIR"], "web_bundle_patched.version")).read().strip()
print(json.dumps({"idxHasMarker": "__ag_is_ssh_remote" in idx_html, "mainJs": main_js, "ver": ver}))
`, {TEST_DIR: dir});

    assert.equal(res.idxHasMarker, true);
    assert.ok(res.mainJs.includes('(window.__ag_is_ssh_remote?void 0:window.dialog)'));
    assert.ok(res.mainJs.includes('CortexTrajectorySource.CLI'));
    assert.equal(res.ver, '20261106-ssh-v11');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('pick_port avoids listening sockets and _cli_sync_lock is an RLock', () => {
  const res = runPyHelper(`
import importlib.util, json, os, socket
spec = importlib.util.spec_from_file_location("remote_ctl", os.environ["REMOTE_CTL_PATH"])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind(("127.0.0.1", 0))
s.listen(1)
occupied = s.getsockname()[1]
try:
    free_check = mod.is_port_free(occupied)
    picked = mod.pick_port(occupied)
finally:
    s.close()

print(json.dumps({
    "freeCheck": free_check,
    "picked": picked,
    "occupied": occupied,
    "lockType": type(mod._cli_sync_lock).__name__,
}))
`);
  assert.equal(res.freeCheck, false);
  assert.notEqual(res.picked, res.occupied);
  assert.ok(res.picked > res.occupied);
  assert.equal(res.lockType, 'RLock');
});

test('ensure_server serializes via install.lock, rotates >50MiB server.log, creates 0o600 files, and returns bridgeToken', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-rc-lock-'));
  try {
    const res = runPyHelper(
      `
import fcntl, importlib.util, json, os, subprocess, sys, time
spec = importlib.util.spec_from_file_location("remote_ctl", os.environ["REMOTE_CTL_PATH"])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

run_dir = os.path.join(os.environ["HOME"], ".antigravity-server", "run")
os.makedirs(run_dir, mode=0o700, exist_ok=True)
log_path = os.path.join(run_dir, "server.log")
with open(log_path, "wb") as f:
    f.truncate(50 * 1024 * 1024 + 1024)

# Stub external binary/network steps to verify install.lock, log rotation, and bridgeToken return
mod.sanitize_git_worktree_configs = lambda: None
mod.sync_cli_store = lambda: None
mod.ensure_auth_token = lambda: True
mod.ensure_binary = lambda v, e, env: os.path.join(run_dir, "fake_ls")
mod.ensure_patched_web_bundle = lambda b: os.path.join(run_dir, "fake.zip")
mod.ensure_bridge_daemon = lambda rd, p=58284: (58284, "a" * 64)
mod.kill_existing_ls = lambda rd: None
mod.pick_port = lambda p: p
mod.check_https_alive = lambda p, c, timeout=4.0: True
mod.is_pid_alive_ls = lambda pid: pid == 424242

class FakeProc:
    pid = 424242
    returncode = None
    def poll(self): return None

def fake_popen(args, **kwargs):
    # Write listening line directly to stdout fd
    os.write(kwargs["stdout"], b"listening on loopback port at 58282 for HTTPS\\nlistening on loopback port at 58283 for HTTP\\n")
    return FakeProc()

orig_popen = mod.subprocess.Popen
mod.subprocess.Popen = fake_popen

# Test 1: fresh start rotates >50MiB server.log -> server.log.1 and creates 0o600 server.log + install.lock
r1 = mod.ensure_server("2.28.2", "123", force_restart=False)
rotated_exists = os.path.isfile(log_path + ".1")
log_mode = os.stat(log_path).st_mode & 0o777
lock_mode = os.stat(os.path.join(run_dir, "install.lock")).st_mode & 0o777

# Test 2: hold install.lock in a subprocess, call ensure_server, ensure it waits and reuses server.json
lock_path = os.path.join(run_dir, "install.lock")
holder = orig_popen([
    sys.executable, "-c",
    "import fcntl, sys, time; fd = open(sys.argv[1], 'r+'); fcntl.flock(fd, fcntl.LOCK_EX); print('locked', flush=True); time.sleep(0.35); fcntl.flock(fd, fcntl.LOCK_UN)",
    lock_path,
], stdout=subprocess.PIPE)
assert holder.stdout.readline().strip() == b"locked"
t0 = time.monotonic()
r2 = mod.ensure_server("2.28.2", "123", force_restart=False)
elapsed = time.monotonic() - t0
holder.wait()

print(json.dumps({
    "r1": r1,
    "r2": r2,
    "rotatedExists": rotated_exists,
    "logMode": log_mode,
    "lockMode": lock_mode,
    "waitedS": elapsed,
}))
`,
      {HOME: home}
    );

    assert.equal(res.r1.ok, true);
    assert.equal(res.r1.reused, false);
    assert.equal(res.r1.bridgeToken, 'a'.repeat(64));
    assert.equal(res.r2.ok, true);
    assert.equal(res.r2.reused, true);
    assert.equal(res.r2.bridgeToken, 'a'.repeat(64));
    assert.equal(res.rotatedExists, true);
    assert.equal(res.logMode, 0o600);
    assert.equal(res.lockMode, 0o600);
    assert.ok(res.waitedS >= 0.25, `expected ensure_server to wait on install.lock, got ${res.waitedS}s`);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});
