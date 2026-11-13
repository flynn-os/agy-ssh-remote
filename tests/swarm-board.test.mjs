import assert from 'node:assert/strict';
import http from 'node:http';
import {test} from 'node:test';
import {
  SWARM_SIDECAR_ID,
  contentTypeForDataRoute,
  createSwarmBoardProxy,
  isEmptySwarmAnswer,
  rewriteSidecarBaseUrl,
  rewriteSwarmSidecars,
  swarmDataRequest,
} from '../src/swarm-board.mjs';

const REMOTE_CID = '11111111-1111-4111-8111-111111111111';
const LOCAL_CID = '22222222-2222-4222-8222-222222222222';

test('rewriteSidecarBaseUrl swaps only the port', () => {
  assert.deepEqual(rewriteSidecarBaseUrl('http://localhost:57800?token=abc', 58286), {
    baseUrl: 'http://localhost:58286?token=abc',
    upstreamPort: 57800,
    upstreamHost: 'localhost',
  });
  assert.equal(rewriteSidecarBaseUrl('http://localhost:58286?token=abc', 58286), null);
  assert.equal(rewriteSidecarBaseUrl('https://example.com:57800/', 58286), null);
  assert.equal(rewriteSidecarBaseUrl(undefined, 58286), null);
});

test('rewriteSwarmSidecars touches only the swarm board', () => {
  const list = [
    {sidecarId: SWARM_SIDECAR_ID, webPort: 57798, baseUrl: 'http://localhost:57800?token=t1'},
    {sidecarId: 'science/biomolecular_structure_viewer', baseUrl: 'http://localhost:57803?token=t2'},
  ];
  let up = 0;
  assert.equal(rewriteSwarmSidecars(list, 58286, (p) => (up = p)), true);
  assert.equal(list[0].baseUrl, 'http://localhost:58286?token=t1');
  assert.equal(list[0].webPort, 57798);
  assert.equal(list[1].baseUrl, 'http://localhost:57803?token=t2');
  assert.equal(up, 57800);
});

test('swarmDataRequest recognises the pane data routes', () => {
  assert.deepEqual(swarmDataRequest('GET', `/api/swarm?etag=&conversationId=${REMOTE_CID}`), {
    route: '/api/swarm',
    conversationId: REMOTE_CID,
    pathAndQuery: `/api/swarm?etag=&conversationId=${REMOTE_CID}`,
  });
  assert.equal(swarmDataRequest('GET', '/api/swarm?etag='), null);
  assert.equal(swarmDataRequest('POST', `/api/swarm?conversationId=${REMOTE_CID}`), null);
  assert.equal(swarmDataRequest('GET', `/app.js?conversationId=${REMOTE_CID}`), null);
  assert.equal(contentTypeForDataRoute('/api/frame', '/api/frame?path=%2Fa%2Fb.PNG'), 'image/png');
  assert.equal(isEmptySwarmAnswer(Buffer.from('{"swarm":null}')), true);
  assert.equal(isEmptySwarmAnswer(Buffer.from(`{"swarm":"${REMOTE_CID}"}`)), false);
});

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({hostname: '127.0.0.1', port, path: p, headers}, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({status: res.statusCode, body: Buffer.concat(chunks).toString('utf8')}));
    }).on('error', reject);
  });
}

test('proxy routes remote conversations to the remote board and the rest upstream', async () => {
  // Fake local LS sidecar proxy: requires the cookie, answers with "local".
  const upstream = http.createServer((req, res) => {
    if (req.headers.cookie !== 'agy=ok') {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({where: 'local', url: req.url, swarm: null}));
  });
  const upPort = await listen(upstream);
  const remoteCalls = [];
  const proxy = createSwarmBoardProxy({
    getUpstreamPort: () => upPort,
    conversationTarget: (cid) => (cid === REMOTE_CID ? 'remote' : cid === LOCAL_CID ? 'local' : 'unknown'),
    fetchRemote: async (pq) => {
      remoteCalls.push(pq);
      const swarm = pq.includes(REMOTE_CID) ? REMOTE_CID : null;
      return {status: 200, body: Buffer.from(JSON.stringify({where: 'remote', swarm}))};
    },
  });
  const port = await listen(proxy);
  try {
    const ok = {cookie: 'agy=ok'};
    let r = await get(port, `/api/swarm?conversationId=${REMOTE_CID}`, ok);
    assert.equal(JSON.parse(r.body).where, 'remote');

    r = await get(port, `/api/swarm?conversationId=${LOCAL_CID}`, ok);
    assert.equal(JSON.parse(r.body).where, 'local');

    // Unknown conversation with no remote swarm falls back to the local board.
    r = await get(port, '/api/swarm?conversationId=00000000-0000-4000-8000-000000000000', ok);
    assert.equal(JSON.parse(r.body).where, 'local');

    // Assets go upstream.
    r = await get(port, '/app.js?token=x', ok);
    assert.equal(JSON.parse(r.body).url, '/app.js?token=x');

    // Without valid sidecar credentials, no remote data.
    const before = remoteCalls.length;
    r = await get(port, `/api/swarm?conversationId=${REMOTE_CID}`, {cookie: 'agy=bad'});
    assert.equal(r.status, 401);
    assert.equal(remoteCalls.length, before);
  } finally {
    proxy.close();
    upstream.close();
  }
});
