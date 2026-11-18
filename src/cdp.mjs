import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
export const patchDir = path.basename(__dirname) === 'src' ? path.dirname(__dirname) : __dirname;
export const portFile = path.join(os.homedir(), 'Library/Application Support/antigravity/DevToolsActivePort');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isPatchableTarget(target, port = null) {
  if (!target || typeof target !== 'object') return false;
  try {
    const title = String(target.title || '');
    if (/\(SSH:\s/i.test(title)) return false;
    const url = new URL(target.url);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (!LOOPBACK_HOSTS.has(url.hostname)) return false;
    if (target.type !== 'page') return false;
    if (!(/(^| - )(Antigravity|Jetski Web)/i.test(title) || url.protocol === 'https:')) return false;
    if (port !== null || target.webSocketDebuggerUrl !== undefined) {
      const ws = new URL(target.webSocketDebuggerUrl);
      if (ws.protocol !== 'ws:') return false;
      if (port !== null) {
        if (ws.hostname !== '127.0.0.1' || Number(ws.port) !== port) return false;
      } else if (!LOOPBACK_HOSTS.has(ws.hostname)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export async function targets() {
  const port = Number((await fs.readFile(portFile, 'utf8')).split('\n')[0]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid local debug port');
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {signal: AbortSignal.timeout(3000)});
  if (!response.ok) throw Error(`Debug endpoint HTTP ${response.status}`);
  return (await response.json()).filter(target => isPatchableTarget(target, port));
}

export async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const listeners = new Map();
  let serial = 0;
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(Error('WebSocket timeout')); }, 5000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once: true});
    ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('WebSocket connection failed')); }, {once: true});
  });
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id && message.method) {
      for (const fn of listeners.get(message.method) || []) {
        try { fn(message.params); } catch {}
      }
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(Error(message.error.message));
    else request.resolve(message.result);
  });
  ws.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(Error('WebSocket closed'));
    }
    pending.clear();
    listeners.clear();
  });
  await opened;
  const client = {
    get open() { return ws.readyState === WebSocket.OPEN; },
    on(method, fn) {
      const list = listeners.get(method) || [];
      list.push(fn);
      listeners.set(method, list);
    },
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++serial;
        const timer = setTimeout(() => { pending.delete(id); reject(Error(`${method} timeout`)); }, 10000);
        pending.set(id, {resolve, reject, timer});
        ws.send(JSON.stringify({id, method, params}));
      });
    },
    async evaluate(expression) {
      const reply = await client.call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
      if (reply.exceptionDetails) throw Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
      return reply.result?.value;
    },
    close() { ws.close(); },
  };
  return client;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const found = await targets();
  if (!found.length) throw Error('No Antigravity window is open');
  const client = await connect(found[0]);
  try { console.log(JSON.stringify(await client.evaluate(process.argv[2]), null, 2)); }
  finally { client.close(); }
}
