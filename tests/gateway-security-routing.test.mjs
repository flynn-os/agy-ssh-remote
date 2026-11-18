import assert from 'node:assert/strict';
import http from 'node:http';
import {test} from 'node:test';
import {REC_END, REC_FRAME, REC_META, RecordParser, ResumableRelayStream} from '../src/relay-client.mjs';

process.env.AG_SSH_DIRECT_HOST = 'box-direct';
process.env.AG_SSH_TUNNEL_HOST = 'box-tunnel';
const {__test, getSshState, sshState} = await import('../src/ssh-remote.mjs');

function encodeRecord(type, seq, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const hdr = Buffer.alloc(13);
  hdr[0] = type;
  hdr.writeBigUInt64BE(BigInt(seq), 1);
  hdr.writeUInt32BE(body.length, 9);
  return Buffer.concat([hdr, body]);
}

test('RecordParser assembles split headers, multi-MB chunked frames, and detaches oversized buffers', () => {
  const parser = new RecordParser();

  // 1. Split 13-byte header and payload across tiny chunks
  const frame1 = encodeRecord(REC_FRAME, 1, Buffer.from('hello-relay'));
  assert.deepEqual(parser.push(frame1.subarray(0, 4)), []);
  assert.equal(parser.chunks.length, 1);
  assert.equal(parser.totalLen, 4);
  assert.deepEqual(parser.push(frame1.subarray(4, 13)), []);
  assert.equal(parser.chunks.length, 2);
  assert.equal(parser.totalLen, 13);
  const res1 = parser.push(frame1.subarray(13));
  assert.equal(res1.length, 1);
  assert.equal(res1[0].type, REC_FRAME);
  assert.equal(res1[0].seq, 1);
  assert.equal(res1[0].payload.toString('utf8'), 'hello-relay');
  assert.equal(parser.chunks.length, 0);
  assert.equal(parser.totalLen, 0);

  // 2. Multi-MB frame in 8 KiB chunks followed by a tiny remainder
  const bigSize = 3 * 1024 * 1024;
  const bigPayload = Buffer.alloc(bigSize, 0x61);
  const bigFrame = encodeRecord(REC_FRAME, 2, bigPayload);
  const trailingPartial = Buffer.from([REC_FRAME, 0, 0, 0, 0, 0, 0, 0, 3]);
  const combined = Buffer.concat([bigFrame, trailingPartial]);

  const t0 = Date.now();
  const emitted = [];
  const step = 8192;
  for (let i = 0; i < combined.length; i += step) {
    const chunk = combined.subarray(i, Math.min(i + step, combined.length));
    const recs = parser.push(chunk);
    emitted.push(...recs);
    if (i + step < bigFrame.length) {
      assert.equal(recs.length, 0);
      assert.equal(parser.chunks.length, Math.floor(i / step) + 1, 'should accumulate chunks without prematurely coalescing');
    }
  }
  const elapsedMs = Date.now() - t0;
  assert.ok(elapsedMs < 2000, `multi-MB chunk parsing took too long (${elapsedMs}ms)`);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].seq, 2);
  assert.equal(emitted[0].payload.length, bigSize);
  assert.equal(emitted[0].payload[0], 0x61);
  assert.equal(emitted[0].payload[bigSize - 1], 0x61);

  // Tiny remainder must not retain the 3MB backing ArrayBuffer
  assert.equal(parser.totalLen, trailingPartial.length);
  assert.equal(parser.chunks.length, 1);
  assert.ok(
    parser.chunks[0].buffer.byteLength <= 65536,
    `remainder pinned oversized buffer of ${parser.chunks[0].buffer.byteLength} bytes`
  );
});

test('RecordParser handles multiple small frames inside a single chunk', () => {
  const parser = new RecordParser();
  const f1 = encodeRecord(REC_META, 0, Buffer.from('{"status":200}'));
  const f2 = encodeRecord(REC_FRAME, 1, Buffer.from('abc'));
  const f3 = encodeRecord(REC_END, 2, Buffer.from('{}'));
  const recs = parser.push(Buffer.concat([f1, f2, f3]));
  assert.equal(recs.length, 3);
  assert.equal(recs[0].type, REC_META);
  assert.equal(recs[1].payload.toString('utf8'), 'abc');
  assert.equal(recs[2].type, REC_END);
  assert.equal(parser.chunks.length, 0);
  assert.equal(parser.totalLen, 0);
});

test('ResumableRelayStream attaches x-ag-bridge-token only when bridge.token is set', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({url: req.url, token: req.headers['x-ag-bridge-token']});
    req.resume();
    if (req.url === '/relay/stream') {
      res.writeHead(200);
      res.end(Buffer.concat([encodeRecord(REC_META, 0, '{"status":200}'), encodeRecord(REC_END, 1, '{}')]));
      return;
    }
    res.writeHead(200);
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    // With token
    await new Promise((resolve) => {
      const stream = new ResumableRelayStream({
        getBridge: () => ({host: '127.0.0.1', port, token: 'secret-bridge-token'}),
        request: {path: '/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates', headers: {}, body: Buffer.from('{}')},
        sink: {writeHead() {}, write() {}, end: resolve},
      });
      stream.start();
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(seen[0].url, '/relay/stream');
    assert.equal(seen[0].token, 'secret-bridge-token');
    assert.equal(seen[1].url.startsWith('/relay/close?id='), true);
    assert.equal(seen[1].token, 'secret-bridge-token');

    // Without token
    seen.length = 0;
    await new Promise((resolve) => {
      const stream = new ResumableRelayStream({
        getBridge: () => ({host: '127.0.0.1', port}),
        request: {path: '/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates', headers: {}, body: Buffer.from('{}')},
        sink: {writeHead() {}, write() {}, end: resolve},
      });
      stream.start();
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(seen[0].token, undefined);
    assert.equal(seen[1].token, undefined);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('decideRpcTarget routes /opt/homebrew local, /opt/conda remote, and ignores prompt rawText', () => {
  const prevLocalMacPort = sshState.localMacPort;
  try {
    sshState.localMacPort = 64830;

    assert.equal(__test.decideRpcTarget('ReadDir', {}, {uri: '/opt/homebrew/bin'}), 'local');
    assert.equal(__test.decideRpcTarget('ReadDir', {}, {uri: '/opt/homebrew'}), 'local');
    assert.equal(__test.decideRpcTarget('ReadDir', {}, {uri: 'file:///opt/homebrew/Cellar/node'}), 'local');
    assert.equal(__test.decideRpcTarget('ReadDir', {}, {uri: 'file:///opt/homebrew'}), 'local');

    assert.equal(__test.decideRpcTarget('ReadDir', {}, {uri: '/opt/conda/envs/dev'}), 'remote');
    assert.equal(__test.decideRpcTarget('ReadDir', {}, {uri: 'file:///opt/conda/bin/python'}), 'remote');

    // Prompt text containing /home/ubuntu in a local project must NOT trigger remote routing
    const localTarget = __test.decideRpcTarget(
      'SendUserCascadeMessage',
      {'x-ag-target-env': 'local'},
      {items: [{text: 'Please inspect /home/ubuntu/repo and file:///home/ubuntu/app'}]},
      '{"items":[{"text":"Please inspect /home/ubuntu/repo and file:///home/ubuntu/app"}]}'
    );
    assert.equal(localTarget, 'local');

    // Even without x-ag-target-env header, rawText alone must not override local fallback
    const fallbackTarget = __test.decideRpcTarget(
      'SendUserCascadeMessage',
      {},
      {items: [{text: 'check file:///home/ubuntu/project'}]},
      '{"items":[{"text":"check file:///home/ubuntu/project"}]}'
    );
    assert.equal(fallbackTarget, 'local');
  } finally {
    sshState.localMacPort = prevLocalMacPort;
  }
});

test('addCorsHeaders strictly enforces loopback and plugin origin allowlist', () => {
  for (const origin of [
    'http://127.0.0.1:5173',
    'https://127.0.0.1',
    'http://localhost:3000',
    'https://localhost:8443',
    'plugin://antigravity-ssh-patch',
  ]) {
    const out = __test.addCorsHeaders({'content-type': 'application/json'}, {origin});
    assert.equal(out['access-control-allow-origin'], origin);
    assert.equal(out['access-control-allow-credentials'], 'true');
  }

  for (const badOrigin of [
    undefined,
    '',
    'null',
    'https://evil.com',
    'http://127.0.0.1.evil.com',
    'https://localhost.attacker.example:8080',
    'http://192.168.1.50:3000',
  ]) {
    const out = __test.addCorsHeaders(
      {'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true'},
      badOrigin === undefined ? {} : {origin: badOrigin}
    );
    assert.equal(out['access-control-allow-origin'], undefined);
    assert.equal(out['access-control-allow-credentials'], undefined);
  }
});

test('getSshState exposes gatewayToken and hides bridgeToken; bridgeRequest & gateway auth helpers work', async () => {
  const prevBridgeToken = sshState.bridgeToken;
  const prevLocalCsrf = sshState.localMacCsrfToken;
  const prevRemoteCsrf = sshState.csrfToken;
  const seenBridgeHeaders = [];
  const server = http.createServer((req, res) => {
    seenBridgeHeaders.push({url: req.url, token: req.headers['x-ag-bridge-token']});
    if (req.url === '/status' && req.headers['x-ag-bridge-token'] !== 'expected-bridge-tok') {
      res.writeHead(401, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: 'unauthorized'}));
      return;
    }
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({ok: true}));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    sshState.bridgeToken = 'expected-bridge-tok';
    sshState.localMacCsrfToken = 'local-csrf-123';
    sshState.csrfToken = 'remote-csrf-456';

    const state = getSshState();
    assert.match(state.gatewayToken, /^[0-9a-f]{64}$/);
    assert.equal('bridgeToken' in state, false);
    assert.equal(state.bridgeToken, undefined);

    const gwTok = __test.getGatewayToken();
    assert.equal(state.gatewayToken, gwTok);
    assert.equal(__test.hasValidGatewayToken({'x-ag-gateway-token': gwTok}), true);
    assert.equal(__test.hasValidGatewayToken({'x-ag-gateway-token': 'bad'}), false);
    assert.equal(__test.isAuthorizedGatewayRequest({'x-ag-gateway-token': gwTok}), true);
    assert.equal(__test.isAuthorizedGatewayRequest({'x-codeium-csrf-token': 'local-csrf-123'}), true);
    assert.equal(__test.isAuthorizedGatewayRequest({'x-codeium-csrf-token': 'remote-csrf-456'}), true);
    assert.equal(__test.isAuthorizedGatewayRequest({'x-codeium-csrf-token': ''}), false);
    assert.equal(__test.isAuthorizedGatewayRequest({}), false);

    // bridgeRequest sends x-ag-bridge-token when non-empty
    const okStatus = await __test.fetchBridgeStatus(port, 1500);
    assert.equal(okStatus.ok, true);
    assert.equal(seenBridgeHeaders[0].token, 'expected-bridge-tok');

    // Without matching token, fetchBridgeStatus surfaces 401 unauthorized
    sshState.bridgeToken = '';
    const unauthStatus = await __test.fetchBridgeStatus(port, 1500);
    assert.equal(unauthStatus.ok, false);
    assert.equal(unauthStatus.unauthorized, true);
    assert.equal(unauthStatus.httpStatus, 401);
    assert.equal(seenBridgeHeaders[1].token, undefined);
  } finally {
    sshState.bridgeToken = prevBridgeToken;
    sshState.localMacCsrfToken = prevLocalCsrf;
    sshState.csrfToken = prevRemoteCsrf;
    server.closeAllConnections();
    server.close();
  }
});

test('computeDisconnectedBackoffMs scales exponentially up to 60s cap with +/-15% jitter', () => {
  const expectedBases = [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000];
  for (let attempt = 1; attempt <= expectedBases.length; attempt++) {
    const base = expectedBases[attempt - 1];
    assert.equal(__test.computeDisconnectedBackoffMs(attempt, 0), Math.round(base * 0.85));
    assert.equal(__test.computeDisconnectedBackoffMs(attempt, 0.5), base);
    assert.equal(__test.computeDisconnectedBackoffMs(attempt, 1), Math.round(base * 1.15));
  }
});
