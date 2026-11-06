#!/usr/bin/env node
// Offline test of the resumable stream relay.
//
//   fake language_server  <-HTTP/1.1->  remote/remote-ctl.py bridge-daemon (relay)  <-TCP->
//   chaos proxy (drops / freezes / refuses / throttles, standing in for the ssh tunnel)  <-TCP->
//   src/relay-client.mjs ResumableRelayStream  ->  sink that checks what the browser would get
//
// Each scenario checks that the browser-side stream got every update exactly once, in order,
// with a single snapshot and a single upstream LS subscription, or (for the failure scenarios)
// that it ends with a clean Connect "unavailable" error so the UI can fall back.
//
//   node scripts/relay-chaos-test.mjs            # all scenarios
//   node scripts/relay-chaos-test.mjs drops gap  # some

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ResumableRelayStream} from '../src/relay-client.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REMOTE_CTL = path.join(ROOT, 'remote', 'remote-ctl.py');
const METHOD_PATH = '/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function envelope(obj, flags = 0) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const hdr = Buffer.alloc(5);
  hdr[0] = flags;
  hdr.writeUInt32BE(body.length, 1);
  return Buffer.concat([hdr, body]);
}

// ---- fake language_server ------------------------------------------------------------------
function startFakeLs({updates, tickMs, snapshotBytes, updatePadBytes = 0}) {
  const st = {subscriptions: 0, closedEarly: 0};
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== METHOD_PATH) {
      res.writeHead(404).end();
      return;
    }
    req.resume();
    req.on('end', () => {
      st.subscriptions += 1;
      res.writeHead(200, {'content-type': 'application/connect+json'});
      res.write(envelope({update: {snapshot: true, pad: 'S'.repeat(snapshotBytes)}}));
      let n = 0;
      let finished = false;
      const timer = setInterval(() => {
        n += 1;
        res.write(envelope({update: {n, pad: 'u'.repeat(updatePadBytes)}}));
        if (n >= updates) {
          clearInterval(timer);
          finished = true;
          res.end(envelope({}, 0x02));
        }
      }, tickMs);
      res.on('close', () => {
        clearInterval(timer);
        if (!finished) st.closedEarly += 1;
      });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({server, port: server.address().port, st})));
}

// ---- bridge (the real remote-ctl.py relay) -----------------------------------------------
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const {port} = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

async function startBridge(upstreamPort, extraEnv = {}, port = 0) {
  port = port || (await freePort());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-relay-test-'));
  const proc = spawn('python3', ['-I', REMOTE_CTL, 'bridge-daemon', String(port)], {
    env: {
      ...process.env,
      HOME: home,
      AG_BRIDGE_RELAY_ONLY: '1',
      AG_RELAY_UPSTREAM: `127.0.0.1:${upstreamPort}`,
      AG_RELAY_CSRF: 'test-csrf',
      AG_RELAY_HEARTBEAT_S: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise((r) => {
      http.get({host: '127.0.0.1', port, path: '/ping', agent: false}, (res) => { res.resume(); r(res.statusCode === 200); }).on('error', () => r(false));
    });
    if (ok) return {proc, port, home};
    await sleep(50);
  }
  throw new Error('bridge did not start');
}

function bridgeStats(port) {
  return new Promise((resolve) => {
    http.get({host: '127.0.0.1', port, path: '/relay/stats', agent: false}, (res) => {
      let t = '';
      res.on('data', (d) => { t += d; });
      res.on('end', () => { try { resolve(JSON.parse(t)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

// ---- chaos proxy (the "ssh tunnel") ------------------------------------------------------
function startChaosProxy(targetPort, {bytesPerSec = 0, latencyMs = 0} = {}) {
  const pairs = new Set();
  const ctl = {down: false, drops: 0, freezes: 0};
  const server = net.createServer((client) => {
    if (ctl.down) {
      client.destroy();
      return;
    }
    const upstream = net.connect(targetPort, '127.0.0.1');
    const pair = {client, upstream, frozen: false};
    pairs.add(pair);
    const kill = () => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    pair.kill = kill;
    client.on('error', kill).on('close', kill);
    upstream.on('error', kill);
    if (!bytesPerSec) upstream.on('close', kill);
    // latencyMs: one-way delay on requests, so an attach takes longer than attachTimeoutMs.
    client.on('data', (d) => {
      if (pair.frozen) return;
      if (latencyMs) setTimeout(() => { if (!upstream.destroyed) upstream.write(d); }, latencyMs);
      else upstream.write(d);
    });
    if (!bytesPerSec) {
      upstream.on('data', (d) => { if (!pair.frozen) client.write(d); });
    } else {
      // Throttle bridge -> client so a large snapshot is still in flight when we cut the link.
      const queue = [];
      let upstreamEnded = false;
      const perTick = Math.max(1, Math.round(bytesPerSec / 50));
      upstream.on('data', (d) => queue.push(d));
      // Orderly close from the bridge: deliver what is queued first, like a real forward would.
      upstream.on('close', () => { upstreamEnded = true; });
      const t = setInterval(() => {
        if (pair.frozen || client.destroyed) return;
        if (upstreamEnded && !queue.length) {
          clearInterval(t);
          client.end();
          pairs.delete(pair);
          return;
        }
        let budget = perTick;
        while (budget > 0 && queue.length) {
          const head = queue[0];
          if (head.length <= budget) {
            client.write(queue.shift());
            budget -= head.length;
          } else {
            client.write(head.subarray(0, budget));
            queue[0] = head.subarray(budget);
            budget = 0;
          }
        }
      }, 20);
      client.on('close', () => clearInterval(t));
    }
  });
  ctl.drop = () => {
    ctl.drops += 1;
    for (const p of [...pairs]) {
      p.client.destroy();
      p.upstream.destroy();
    }
  };
  // Hung link: existing connections stop moving bytes but stay open (like a stuck ssh).
  ctl.freeze = () => {
    ctl.freezes += 1;
    for (const p of pairs) p.frozen = true;
  };
  ctl.close = () => {
    ctl.drop();
    server.close();
  };
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({...ctl, ctl, port: server.address().port})));
}

// ---- browser-side sink ---------------------------------------------------------------
function makeSink() {
  const st = {status: 0, headers: null, buf: Buffer.alloc(0), frames: [], ended: false, endFrame: null};
  return {
    st,
    writeHead(status, headers) { st.status = status; st.headers = headers; },
    write(b) {
      st.buf = Buffer.concat([st.buf, b]);
      while (st.buf.length >= 5) {
        const len = st.buf.readUInt32BE(1);
        if (st.buf.length < 5 + len) break;
        const flags = st.buf[0];
        const json = JSON.parse(st.buf.subarray(5, 5 + len).toString('utf8') || '{}');
        st.buf = st.buf.subarray(5 + len);
        if (flags & 0x02) st.endFrame = json;
        else st.frames.push(json);
      }
    },
    end() { st.ended = true; },
  };
}

function checkComplete(sink, updates) {
  const errs = [];
  const snaps = sink.st.frames.filter((f) => f.update?.snapshot).length;
  const ns = sink.st.frames.filter((f) => f.update?.n).map((f) => f.update.n);
  if (sink.st.status !== 200) errs.push(`status ${sink.st.status}`);
  if (snaps !== 1) errs.push(`snapshots=${snaps} (want 1)`);
  if (ns.length !== updates) errs.push(`updates=${ns.length} (want ${updates})`);
  for (let i = 0; i < ns.length; i++) {
    if (ns[i] !== i + 1) {
      errs.push(`out of order at ${i}: ${ns[i]}`);
      break;
    }
  }
  if (!sink.st.ended) errs.push('stream not ended');
  if (!sink.st.endFrame || sink.st.endFrame.error) errs.push(`bad end frame ${JSON.stringify(sink.st.endFrame)}`);
  return errs;
}

async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(25);
  }
  return pred();
}

// ---- scenarios -----------------------------------------------------------------------
async function withRig(opts, fn) {
  const ls = await startFakeLs(opts.ls);
  let bridge = await startBridge(ls.port, opts.bridgeEnv);
  const proxy = await startChaosProxy(bridge.port, opts.proxy);
  const sink = makeSink();
  const logs = [];
  const client = new ResumableRelayStream({
    getBridge: () => ({host: '127.0.0.1', port: proxy.port}),
    request: {path: METHOD_PATH, headers: {'content-type': 'application/connect+json', 'connect-protocol-version': '1'}, body: envelope({conversationId: 'test'})},
    sink,
    log: (m) => logs.push(m),
    stallMs: 3000,
    attachTimeoutMs: 3000,
    backoffBaseMs: 100,
    backoffMaxMs: 800,
    recoveryWindowMs: opts.recoveryWindowMs || 20000,
  });
  const rig = {
    ls, proxy, sink, client, logs,
    get bridge() { return bridge; },
    async restartBridge() {
      const port = bridge.port;
      bridge.proc.kill('SIGKILL');
      await sleep(200);
      bridge = await startBridge(ls.port, opts.bridgeEnv, port);
    },
  };
  try {
    client.start();
    return await fn(rig);
  } finally {
    client.cancel();
    proxy.close();
    bridge.proc.kill('SIGKILL');
    ls.server.close();
    fs.rmSync(bridge.home, {recursive: true, force: true});
  }
}

const SCENARIOS = {
  // Tunnel drops several times, once mid-snapshot, plus a 2s outage where connects are refused.
  async drops() {
    const updates = 150;
    return withRig({ls: {updates, tickMs: 40, snapshotBytes: 600000}, proxy: {bytesPerSec: 1_500_000}}, async (r) => {
      await sleep(150); // snapshot (600KB at 1.5MB/s) is still in flight
      r.proxy.drop();
      await sleep(1200);
      r.proxy.drop();
      await sleep(1000);
      r.proxy.ctl.down = true;
      r.proxy.drop();
      await sleep(2000);
      r.proxy.ctl.down = false;
      await sleep(800);
      r.proxy.drop();
      await waitFor(() => r.sink.st.ended, 20000);
      const errs = checkComplete(r.sink, updates);
      if (r.ls.st.subscriptions !== 1) errs.push(`LS subscriptions=${r.ls.st.subscriptions} (want 1)`);
      if (r.client.stats.resumes < 4) errs.push(`resumes=${r.client.stats.resumes} (want >=4)`);
      if (errs.length && process.env.DEBUG) console.log(r.logs.join("\n"), JSON.stringify(await bridgeStats(r.bridge.port)));
      return {errs, info: {resumes: r.client.stats.resumes, attaches: r.client.stats.attaches, dupFrames: r.client.stats.duplicateFrames, lsSubs: r.ls.st.subscriptions}};
    });
  },

  // Link hangs without closing (stuck ssh). Stall detection attaches in parallel over a fresh
  // connection (make-before-break) and the bridge preempts the old writer.
  async freeze() {
    const updates = 120;
    return withRig({ls: {updates, tickMs: 50, snapshotBytes: 200000}}, async (r) => {
      await sleep(1500);
      r.proxy.freeze();
      await waitFor(() => r.sink.st.ended, 25000);
      const errs = checkComplete(r.sink, updates);
      if (r.ls.st.subscriptions !== 1) errs.push(`LS subscriptions=${r.ls.st.subscriptions} (want 1)`);
      if (r.client.stats.resumes < 1) errs.push('no resume after freeze');
      if (!r.logs.some((l) => l.includes('stalled'))) errs.push('stall not detected');
      return {errs, info: {resumes: r.client.stats.resumes, attaches: r.client.stats.attaches, lsSubs: r.ls.st.subscriptions}};
    });
  },

  // Outage longer than the replay buffer can cover: the client must give up cleanly with a
  // Connect error (the UI then re-subscribes the old way) instead of silently skipping frames.
  async gap() {
    return withRig({
      ls: {updates: 400, tickMs: 10, snapshotBytes: 1000, updatePadBytes: 2000},
      bridgeEnv: {AG_RELAY_MAX_BUFFER_BYTES: String(64 * 1024)},
    }, async (r) => {
      await sleep(500);
      r.proxy.ctl.down = true;
      r.proxy.drop();
      await sleep(2500);
      r.proxy.ctl.down = false;
      await waitFor(() => r.sink.st.ended, 10000);
      const errs = [];
      if (!r.sink.st.ended) errs.push('stream not ended');
      if (r.sink.st.endFrame?.error?.code !== 'unavailable') errs.push(`want unavailable end frame, got ${JSON.stringify(r.sink.st.endFrame)}`);
      const ns = r.sink.st.frames.filter((f) => f.update?.n).map((f) => f.update.n);
      for (let i = 0; i < ns.length; i++) if (ns[i] !== i + 1) { errs.push('frames skipped before giving up'); break; }
      return {errs, info: {deliveredUpdates: ns.length, end: r.sink.st.endFrame}};
    });
  },

  // Bridge process restarts (version bump): stream is unknown, client must fail cleanly.
  async bridgeRestart() {
    return withRig({ls: {updates: 200, tickMs: 30, snapshotBytes: 1000}}, async (r) => {
      await sleep(800);
      await r.restartBridge();
      await waitFor(() => r.sink.st.ended, 10000);
      const errs = [];
      if (r.sink.st.endFrame?.error?.code !== 'unavailable') errs.push(`want unavailable end frame, got ${JSON.stringify(r.sink.st.endFrame)}`);
      return {errs, info: {end: r.sink.st.endFrame}};
    });
  },

  // Browser closes the stream: bridge must release the LS subscription promptly.
  async cancel() {
    return withRig({ls: {updates: 1000, tickMs: 20, snapshotBytes: 1000}}, async (r) => {
      await sleep(600);
      r.client.cancel();
      const released = await waitFor(() => r.ls.st.closedEarly === 1, 3000);
      const stats = await bridgeStats(r.bridge.port);
      const errs = [];
      if (!released) errs.push('LS subscription not released after cancel');
      if (stats?.streams?.length) errs.push(`bridge still holds ${stats.streams.length} stream(s)`);
      return {errs, info: {lsClosed: r.ls.st.closedEarly}};
    });
  },

  // Congested link: every attach takes longer than attachTimeoutMs to answer. The client must
  // keep the slow attach, try one in parallel, and still deliver everything exactly once.
  async slowAttach() {
    const updates = 60;
    return withRig({ls: {updates, tickMs: 100, snapshotBytes: 100000}, proxy: {latencyMs: 4000}}, async (r) => {
      await sleep(7000);
      r.proxy.drop();
      await waitFor(() => r.sink.st.ended, 30000);
      const errs = checkComplete(r.sink, updates);
      if (r.ls.st.subscriptions !== 1) errs.push(`LS subscriptions=${r.ls.st.subscriptions} (want 1)`);
      if (!r.logs.some((l) => l.includes('no META'))) errs.push('slow attach path not exercised');
      if (r.logs.some((l) => l.includes('giving up'))) errs.push('gave up on a slow link');
      return {errs, info: {resumes: r.client.stats.resumes, attaches: r.client.stats.attaches, dupFrames: r.client.stats.duplicateFrames}};
    });
  },

  // Tunnel down for longer than a typical reconnect (8s) while the agent keeps producing:
  // everything produced meanwhile is replayed from the buffer.
  async longOutage() {
    const updates = 300;
    return withRig({ls: {updates, tickMs: 40, snapshotBytes: 300000}}, async (r) => {
      await sleep(1000);
      r.proxy.ctl.down = true;
      r.proxy.drop();
      await sleep(8000);
      r.proxy.ctl.down = false;
      await waitFor(() => r.sink.st.ended, 20000);
      const errs = checkComplete(r.sink, updates);
      if (r.ls.st.subscriptions !== 1) errs.push(`LS subscriptions=${r.ls.st.subscriptions} (want 1)`);
      const resumeLog = r.logs.find((l) => l.includes('resumed'));
      return {errs, info: {resumes: r.client.stats.resumes, attaches: r.client.stats.attaches, resumeLog}};
    });
  },
};

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS);
let failed = 0;
for (const name of wanted) {
  const t0 = Date.now();
  try {
    const {errs, info} = await SCENARIOS[name]();
    const ok = errs.length === 0;
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (${Date.now() - t0}ms) ${JSON.stringify(info)}`);
    for (const e of errs) console.log(`     - ${e}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${name}: ${e.stack || e}`);
  }
}
process.exit(failed ? 1 : 0);
