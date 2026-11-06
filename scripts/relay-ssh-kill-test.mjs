#!/usr/bin/env node
// Live test of the resumable relay against the real remote language_server, over a real ssh
// route, killing the ssh forward mid-stream. It does not touch the running agy-ssh-remote
// setup: it starts its own relay-only bridge on the remote (default port 58294) from a temp
// copy of remote-ctl.py and its own `ssh -L`.
//
//   node scripts/relay-ssh-kill-test.mjs [--host <ssh-alias>] [--cascade <id>] [--down 8] [--kills 2]
//   (default host: the configured tunnel route, see src/routes.mjs)
//
// Start a task in that conversation first if you want to see live frames replayed across
// the outage. Passing means: one LS subscription for the whole run, every kill resumed with
// after_seq (no second snapshot), and the stream still open at the end.

import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ResumableRelayStream} from '../src/relay-client.mjs';
import {routeHosts} from '../src/routes.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);
const HOST = args.host || routeHosts().tunnel;
const REMOTE_PORT = Number(args['remote-port'] || 58294);
const DOWN_S = Number(args.down || 8);
const KILLS = Number(args.kills || 2);
const TAIL_S = Number(args.tail || 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (m) => console.log(`${ts()} ${m}`);
const SSH = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4'];
const REMOTE_SCRIPT = `/tmp/ag-relay-test-${process.pid}.py`;

function sshRun(cmd, input) {
  const r = spawnSync('ssh', [...SSH, HOST, cmd], {input, encoding: 'utf8', timeout: 60000});
  if (r.status !== 0) throw new Error(`ssh ${HOST} '${cmd}' failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const {port} = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

function getJson(port, p, timeout = 5000) {
  return new Promise((resolve) => {
    const req = http.get({host: '127.0.0.1', port, path: p, agent: false, timeout}, (res) => {
      let t = '';
      res.on('data', (d) => { t += d; });
      res.on('end', () => { try { resolve(JSON.parse(t)); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

let tunnel = null;
let tunnelUp = false;
const reconnectWaiters = new Set();
let localPort = 0;

async function startTunnel() {
  tunnel = spawn('ssh', [...SSH, '-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${localPort}:127.0.0.1:${REMOTE_PORT}`, HOST], {stdio: 'ignore'});
  const started = Date.now();
  while (Date.now() - started < 30000) {
    if (await getJson(localPort, '/ping', 3000)) {
      tunnelUp = true;
      for (const fn of [...reconnectWaiters]) fn();
      return Date.now() - started;
    }
    await sleep(200);
  }
  throw new Error('tunnel did not come up');
}

function killTunnel() {
  tunnelUp = false;
  tunnel?.kill('SIGKILL');
  tunnel = null;
}

async function main() {
  localPort = await freePort();
  const cascade =
    args.cascade || sshRun('ls -t ~/.gemini/antigravity/conversations | head -1').replace(/\.(db|pb)$/, '');
  log(`host=${HOST} cascade=${cascade} remote test bridge :${REMOTE_PORT} -> local :${localPort}`);

  sshRun(`cat > ${REMOTE_SCRIPT}`, fs.readFileSync(path.join(ROOT, 'remote', 'remote-ctl.py'), 'utf8'));
  sshRun(
    `AG_BRIDGE_RELAY_ONLY=1 setsid nohup python3 ${REMOTE_SCRIPT} bridge-daemon ${REMOTE_PORT} > ${REMOTE_SCRIPT}.log 2>&1 < /dev/null & echo started`
  );
  const upMs = await startTunnel();
  log(`tunnel up in ${upMs}ms`);

  const frames = [];
  let firstFrameAt = 0;
  const openedAt = Date.now();
  let ended = false;
  let endBuf = Buffer.alloc(0);
  const body = Buffer.from(
    JSON.stringify({conversationId: cascade, subscriberId: randomUUID(), trajectoryVerbosity: 'CLIENT_TRAJECTORY_VERBOSITY_PROD_UI'}),
    'utf8'
  );
  const env = Buffer.concat([Buffer.from([0, 0, 0, 0, 0]), body]);
  env.writeUInt32BE(body.length, 1);
  const client = new ResumableRelayStream({
    getBridge: () => (tunnelUp ? {host: '127.0.0.1', port: localPort} : null),
    onReconnected: (fn) => {
      reconnectWaiters.add(fn);
      return () => reconnectWaiters.delete(fn);
    },
    request: {
      path: '/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates',
      headers: {'content-type': 'application/connect+json', 'connect-protocol-version': '1'},
      body: env,
    },
    log,
    sink: {
      writeHead: (status, h) => log(`browser <- HTTP ${status} ${h['content-type'] || ''}`),
      write: (buf) => {
        // Envelopes arrive whole from the relay (one envelope per record).
        const flags = buf[0];
        if (flags & 0x02) {
          endBuf = buf;
          return;
        }
        if (!firstFrameAt) firstFrameAt = Date.now();
        frames.push({at: Date.now(), size: buf.length});
      },
      end: () => {
        ended = true;
        log(`browser stream ENDED ${endBuf.subarray(5).toString('utf8')}`);
      },
    },
  }).start();

  while (!firstFrameAt && Date.now() - openedAt < 60000) await sleep(100);
  if (!firstFrameAt) throw new Error('no snapshot frame within 60s');
  const snapshot = frames[0];
  log(`initial snapshot: ${(snapshot.size / 1024).toFixed(0)} KB in ${firstFrameAt - openedAt}ms (this is what every re-subscribe used to cost)`);
  await sleep(2000);

  const resumes = [];
  for (let k = 1; k <= KILLS; k++) {
    const before = {frames: frames.length, bytes: client.stats.bytes, seq: client.lastSeq};
    log(`--- kill #${k}: SIGKILL ssh forward at seq=${client.lastSeq}; down for ${DOWN_S}s`);
    killTunnel();
    await sleep(DOWN_S * 1000);
    const reMs = await startTunnel();
    log(`tunnel back in ${reMs}ms`);
    const waitStart = Date.now();
    while (client.stats.resumes < k && Date.now() - waitStart < 30000 && !ended) await sleep(100);
    const after = {frames: frames.length, bytes: client.stats.bytes};
    resumes.push({
      k,
      resumed: client.stats.resumes >= k,
      resumeMs: Date.now() - waitStart,
      replayedFrames: after.frames - before.frames,
      replayedBytes: after.bytes - before.bytes,
    });
    await sleep(2000);
  }
  await sleep(TAIL_S * 1000);

  const bridge = await getJson(localPort, '/relay/stats');
  const mine = bridge?.streams?.find((s) => s.id === client.id);
  const bigFrames = frames.slice(1).filter((f) => f.size >= snapshot.size * 0.5).length;
  const errs = [];
  if (ended) errs.push('browser stream ended (UI would reset and re-download history)');
  for (const r of resumes) if (!r.resumed) errs.push(`kill #${r.k} not resumed`);
  if (bigFrames) errs.push(`${bigFrames} snapshot-sized frame(s) after the first: looks like a re-subscribe`);
  if (!mine) errs.push('bridge no longer holds the stream');

  console.log(
    JSON.stringify(
      {
        pass: errs.length === 0,
        errs,
        snapshotKB: Math.round(snapshot.size / 1024),
        snapshotMs: firstFrameAt - openedAt,
        resumes,
        totalFrames: frames.length,
        lastSeq: client.lastSeq,
        clientStats: client.stats,
        bridgeStream: mine,
      },
      null,
      2
    )
  );
  client.cancel();
  await sleep(500);
  return errs.length === 0;
}

let ok = false;
try {
  ok = await main();
} catch (e) {
  console.error(e.stack || e);
} finally {
  try {
    if (!tunnelUp) await startTunnel().catch(() => {});
    killTunnel();
    // [/]tmp keeps pkill from matching the shell running this very command.
    sshRun(`pkill -f '[/]${REMOTE_SCRIPT.slice(1)} bridge-daemon'; rm -f ${REMOTE_SCRIPT} ${REMOTE_SCRIPT}.log; echo cleaned`);
  } catch (e) {
    console.error(`cleanup: ${e.message}`);
  }
}
process.exit(ok ? 0 : 1);
