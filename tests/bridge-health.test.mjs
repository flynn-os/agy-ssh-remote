// Regression test for the "health check blind for 7 minutes" bug: bulk bridge downloads that
// trickle in must not delay /ping, and bridge calls must honour a wall-clock deadline.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.AG_SSH_DIRECT_HOST = 'box-direct';
process.env.AG_SSH_TUNNEL_HOST = 'box-tunnel';
const {__test, selectBestHost} = await import('../src/ssh-remote.mjs');

function startFakeBridge() {
  const open = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === '/ping') {
      res.end(JSON.stringify({ok: true}));
      return;
    }
    // /metrics: a slow transfer that never goes idle (1 byte every 200ms)
    res.writeHead(200, {'content-type': 'application/json'});
    const t = setInterval(() => res.write(' '), 200);
    open.add(t);
    res.on('close', () => clearInterval(t));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({server, port: server.address().port, open})));
}

test('ping is not queued behind trickling bulk downloads', async () => {
  const b = await startFakeBridge();
  try {
    // Fill the whole bulk pool (and then some) with never-ending downloads.
    const bulk = Array.from({length: 10}, () => __test.bridgeRequest({port: b.port, path: '/metrics', deadlineMs: 30000}));
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    const ping = await __test.pingBridge(b.port, 2000);
    assert.equal(ping.ok, true);
    assert.ok(Date.now() - t0 < 1000, `ping took ${Date.now() - t0}ms`);
    void bulk;
  } finally {
    b.server.closeAllConnections();
    b.server.close();
  }
});

test('wall-clock deadline fires even while bytes keep arriving', async () => {
  const b = await startFakeBridge();
  try {
    const t0 = Date.now();
    const res = await __test.bridgeRequest({port: b.port, path: '/metrics', deadlineMs: 800, control: true});
    assert.equal(res, null);
    const ms = Date.now() - t0;
    assert.ok(ms >= 700 && ms < 2000, `deadline fired after ${ms}ms`);
  } finally {
    b.server.closeAllConnections();
    b.server.close();
  }
});

test('bodyIdleMs lets a moving download outlive the head deadline', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    let n = 0;
    const t = setInterval(() => {
      res.write('x');
      if (++n === 8) {
        clearInterval(t);
        res.end();
      }
    }, 150);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await __test.bridgeRequest({port: server.address().port, path: '/metrics', deadlineMs: 500, bodyIdleMs: 400});
    assert.ok(res, 'download was cut off');
    assert.equal(res.body.toString(), 'xxxxxxxx');
  } finally {
    server.close();
  }
});

test('auto mode fails over fast when the direct route hangs', async () => {
  const t0 = Date.now();
  const res = await selectBestHost('auto', async (host) => {
    if (host === 'box-direct') {
      await new Promise((r) => setTimeout(r, 1800));
      return {ok: false, host, latencyMs: Infinity};
    }
    await new Promise((r) => setTimeout(r, 300));
    return {ok: true, host, latencyMs: 300};
  });
  assert.equal(res.host, 'box-tunnel');
  assert.ok(Date.now() - t0 < 1700);
});

test('explicit mode probes the configured alias for that role', async () => {
  const seen = [];
  const res = await selectBestHost('tunnel', async (host) => {
    seen.push(host);
    return {ok: true, host, latencyMs: 10};
  });
  assert.equal(res.host, 'box-tunnel');
  assert.equal(seen[0], 'box-tunnel');
});
