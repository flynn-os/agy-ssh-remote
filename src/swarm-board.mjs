// Swarm board pane for remote SSH conversations.
//
// The Hub shows the `swarm/swarm_board` sidecar of the *local* Mac language_server: the
// unified window gets its sidecar list from SubscribeToSidecars, which the gateway answers
// from the local LS. That sidecar reads `<appData>/brain/<conv>/.system_generated/swarm/`
// on the Mac, but a swarm started in a remote SSH conversation lives in the remote host's
// brain dir, so the pane always says "No swarm in this conversation".
//
// Fix: the gateway rewrites the swarm sidecar's `baseUrl` to this small HTTP proxy. The Hub
// derives the plugin://<authority> origin of the pane from `baseUrl`, so every request of
// the pane reaches us. Everything is passed through to the local LS sidecar proxy (page,
// assets, /_sidecar/* RPCs, cookies) except the two data routes, `/api/swarm` and
// `/api/frame`: for a remote conversation those are answered by the remote host's own
// swarm_board sidecar, reached through the remote bridge (`/swarm-board/...`).

import http from 'node:http';

export const SWARM_SIDECAR_ID = 'swarm/swarm_board';
export const SWARM_DATA_ROUTES = new Set(['/api/swarm', '/api/frame']);
export const DEFAULT_SWARM_PROXY_PORT = 58286;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FRAME_TYPES = {png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp'};
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer']);

export function isConversationId(v) {
  return typeof v === 'string' && ID_RE.test(v);
}

/**
 * `http://localhost:57800?token=T` -> {baseUrl: `http://localhost:<proxyPort>?token=T`,
 * upstreamPort: 57800}. Only the port is replaced, so the host the cookies belong to, the
 * token and the exact string shape the Hub keys its authority map on stay as they were.
 * Returns null for anything that is not a loopback http URL with a port, or that already
 * points at the proxy.
 */
export function rewriteSidecarBaseUrl(baseUrl, proxyPort) {
  if (typeof baseUrl !== 'string') return null;
  const m = baseUrl.match(/^(http:\/\/)(localhost|127\.0\.0\.1)(?::(\d+))(.*)$/i);
  if (!m) return null;
  const upstreamPort = Number(m[3]);
  if (!upstreamPort || upstreamPort === Number(proxyPort)) return null;
  return {baseUrl: `${m[1]}${m[2]}:${proxyPort}${m[4]}`, upstreamPort, upstreamHost: m[2]};
}

/**
 * Points the swarm board entries of one SubscribeToSidecars frame at the proxy (in place).
 * Calls onUpstream(port) with the local LS sidecar proxy port it replaced.
 * Returns true if anything changed.
 */
export function rewriteSwarmSidecars(sidecars, proxyPort, onUpstream = () => {}) {
  if (!Array.isArray(sidecars) || !proxyPort) return false;
  let changed = false;
  for (const sc of sidecars) {
    if (!sc || sc.sidecarId !== SWARM_SIDECAR_ID) continue;
    const r = rewriteSidecarBaseUrl(sc.baseUrl, proxyPort);
    if (!r) continue;
    sc.baseUrl = r.baseUrl;
    onUpstream(r.upstreamPort);
    changed = true;
  }
  return changed;
}

/** {route, conversationId} for a pane data request that may be answered remotely, else null. */
export function swarmDataRequest(method, reqUrl) {
  if (method !== 'GET') return null;
  let u;
  try {
    u = new URL(reqUrl || '/', 'http://localhost');
  } catch {
    return null;
  }
  if (!SWARM_DATA_ROUTES.has(u.pathname)) return null;
  const conversationId = u.searchParams.get('conversationId') || '';
  if (!isConversationId(conversationId)) return null;
  return {route: u.pathname, conversationId, pathAndQuery: `${u.pathname}${u.search}`};
}

export function contentTypeForDataRoute(route, pathAndQuery) {
  if (route === '/api/swarm') return 'application/json; charset=utf-8';
  try {
    const p = new URL(pathAndQuery, 'http://localhost').searchParams.get('path') || '';
    const ext = (p.match(/\.([a-z]+)$/i)?.[1] || '').toLowerCase();
    return FRAME_TYPES[ext] || 'application/octet-stream';
  } catch {
    return 'application/octet-stream';
  }
}

/** A remote /api/swarm answer that says "this conversation has no swarm there". */
export function isEmptySwarmAnswer(body) {
  try {
    const j = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
    return !j || !j.swarm;
  } catch {
    return false;
  }
}

/**
 * The proxy server.
 *  - getUpstreamPort(): local LS sidecar proxy port (from the rewritten baseUrl), or 0.
 *  - conversationTarget(cid): 'remote' | 'local' | 'unknown'.
 *  - fetchRemote(pathAndQuery): {status, body: Buffer} | null, from the remote swarm_board.
 */
export function createSwarmBoardProxy({getUpstreamPort, conversationTarget, fetchRemote, log = () => {}}) {
  // Cookie headers the local LS sidecar proxy accepted. Remote answers are only given to
  // a pane that is allowed to read the local sidecar too.
  const authorized = new Map(); // cookie header -> last ok ts
  const AUTH_TTL_MS = 10 * 60 * 1000;

  function upstreamHeaders(req, port) {
    const out = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_HEADERS.has(k.toLowerCase())) continue;
      out[k] = v;
    }
    out.host = `localhost:${port}`;
    return out;
  }

  function passThrough(req, res, bodyBuf = null) {
    const port = getUpstreamPort();
    if (!port) {
      res.writeHead(503, {'content-type': 'text/plain; charset=utf-8'});
      res.end('swarm sidecar not available yet');
      return;
    }
    const uReq = http.request(
      {hostname: '127.0.0.1', port, method: req.method, path: req.url, headers: upstreamHeaders(req, port)},
      (uRes) => {
        const headers = {};
        for (const [k, v] of Object.entries(uRes.headers)) {
          if (!HOP_HEADERS.has(k.toLowerCase())) headers[k] = v;
        }
        res.writeHead(uRes.statusCode || 502, headers);
        uRes.pipe(res);
      }
    );
    uReq.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, {'content-type': 'text/plain; charset=utf-8'});
      res.end(`swarm sidecar upstream error: ${e.message}`);
    });
    res.on('close', () => uReq.destroy());
    if (bodyBuf) uReq.end(bodyBuf);
    else req.pipe(uReq);
  }

  // Asks the local sidecar proxy whether this pane's credentials are valid (a GET of the same
  // data route), caching the answer per cookie header.
  function isAuthorized(req) {
    const key = String(req.headers.cookie || '') + '\n' + new URL(req.url, 'http://localhost').searchParams.get('token');
    const ts = authorized.get(key);
    if (ts && Date.now() - ts < AUTH_TTL_MS) return Promise.resolve(true);
    const port = getUpstreamPort();
    if (!port) return Promise.resolve(false);
    return new Promise((resolve) => {
      const uReq = http.request(
        {hostname: '127.0.0.1', port, method: 'GET', path: req.url, headers: upstreamHeaders(req, port), timeout: 4000},
        (uRes) => {
          uRes.resume();
          const ok = uRes.statusCode !== 401 && uRes.statusCode !== 403;
          if (ok) {
            if (authorized.size > 64) authorized.clear();
            authorized.set(key, Date.now());
          }
          resolve(ok);
        }
      );
      uReq.on('timeout', () => uReq.destroy());
      uReq.on('error', () => resolve(false));
      uReq.end();
    });
  }

  async function handle(req, res) {
    const data = swarmDataRequest(req.method, req.url);
    if (!data) {
      passThrough(req, res);
      return;
    }
    const target = conversationTarget(data.conversationId);
    if (target === 'local') {
      passThrough(req, res);
      return;
    }
    if (!(await isAuthorized(req))) {
      res.writeHead(401, {'content-type': 'text/plain; charset=utf-8'});
      res.end('unauthorized');
      return;
    }
    const r = await fetchRemote(data.pathAndQuery).catch(() => null);
    const usable = r && r.status === 200 && Buffer.isBuffer(r.body);
    if (usable && !(target === 'unknown' && data.route === '/api/swarm' && isEmptySwarmAnswer(r.body))) {
      res.writeHead(200, {
        'content-type': contentTypeForDataRoute(data.route, data.pathAndQuery),
        'content-length': String(r.body.length),
        'cache-control': data.route === '/api/frame' ? 'private, max-age=3600' : 'no-store',
      });
      res.end(r.body);
      return;
    }
    if (target === 'remote' && !usable) {
      // Keep the pane on "Reconnecting" rather than flipping it to "No swarm".
      log(`[swarm-board] remote ${data.route} failed (status=${r?.status ?? 'none'})`);
      res.writeHead(r?.status === 404 ? 404 : 502, {'content-type': 'text/plain; charset=utf-8'});
      res.end('remote swarm board unavailable');
      return;
    }
    passThrough(req, res);
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) res.writeHead(500, {'content-type': 'text/plain; charset=utf-8'});
      res.end(String(e?.message || e));
    });
  });
}
