// Mac side of the resumable stream relay (see docs/resumable-relay.md).
//
// A ResumableRelayStream stands in for one browser-facing server-streaming RPC. It asks the
// remote bridge (/relay/stream) to hold the language_server subscription, writes the frames it
// receives to the browser, and remembers the last sequence number. When the bridge connection
// breaks or stalls it reconnects with exponential backoff and resumes with `afterSeq`, so the
// browser's HTTP stream never ends and the UI never resets its conversation state.

import http from 'node:http';
import {randomUUID} from 'node:crypto';

export const REC_META = 1;
export const REC_FRAME = 2;
export const REC_END = 3;
export const REC_BEAT = 4;
const REC_HEADER_LEN = 13;

export const RELAY_DEFAULTS = {
  // Give up (and let the UI re-subscribe the old way) after this long without a working
  // attach. Kept below the remote RELAY_RETENTION_S (180s).
  recoveryWindowMs: 150000,
  // The bridge sends a heartbeat every 5s when idle. No bytes for this long = stalled link.
  stallMs: 20000,
  // Time to get META back from an attach before also trying a parallel one. The slow attach
  // is kept, not dropped: on a congested relay link (seen: 28 KB/s, 10s+ RTT) it is often
  // just slow, and abandoning it only adds load.
  attachTimeoutMs: 30000,
  // At most this many concurrent attaches per stream (old ones are dropped first).
  maxParallelAttaches: 2,
  backoffBaseMs: 250,
  backoffMaxMs: 5000,
};

function detachIfOversized(buf) {
  if (buf.length > 0 && buf.buffer.byteLength > 65536 && buf.length * 4 <= buf.buffer.byteLength) {
    return Buffer.from(buf);
  }
  return buf;
}

export class RecordParser {
  constructor() {
    this.chunks = [];
    this.totalLen = 0;
  }

  _peekHeader() {
    const first = this.chunks[0];
    if (first.length >= REC_HEADER_LEN) {
      return {
        type: first[0],
        seq: Number(first.readBigUInt64BE(1)),
        len: first.readUInt32BE(9),
      };
    }
    const hdr = Buffer.allocUnsafe(REC_HEADER_LEN);
    let filled = 0;
    for (let i = 0; i < this.chunks.length && filled < REC_HEADER_LEN; i++) {
      const c = this.chunks[i];
      const take = Math.min(c.length, REC_HEADER_LEN - filled);
      c.copy(hdr, filled, 0, take);
      filled += take;
    }
    return {
      type: hdr[0],
      seq: Number(hdr.readBigUInt64BE(1)),
      len: hdr.readUInt32BE(9),
    };
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) return [];
    const bufChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.chunks.push(bufChunk);
    this.totalLen += bufChunk.length;

    const out = [];
    let active = null;
    let offset = 0;

    while (this.totalLen >= REC_HEADER_LEN) {
      let type, seq, len;
      if (active) {
        if (active.length - offset < REC_HEADER_LEN) break;
        type = active[offset];
        seq = Number(active.readBigUInt64BE(offset + 1));
        len = active.readUInt32BE(offset + 9);
      } else {
        ({type, seq, len} = this._peekHeader());
      }

      const frameSize = REC_HEADER_LEN + len;
      if (this.totalLen < frameSize) break;

      if (!active) {
        if (this.chunks.length === 1) {
          active = this.chunks[0];
        } else if (this.chunks[0].length >= frameSize) {
          const first = this.chunks[0];
          const payload = first.subarray(REC_HEADER_LEN, frameSize);
          out.push({type, seq, payload});
          if (first.length === frameSize) {
            this.chunks.shift();
          } else {
            this.chunks[0] = first.subarray(frameSize);
          }
          this.totalLen -= frameSize;
          continue;
        } else {
          active = Buffer.concat(this.chunks, this.totalLen);
          this.chunks = [active];
        }
        offset = 0;
      }

      const payload = active.subarray(offset + REC_HEADER_LEN, offset + frameSize);
      out.push({type, seq, payload});
      offset += frameSize;
      this.totalLen -= frameSize;
    }

    if (active) {
      if (this.totalLen === 0) {
        this.chunks = [];
      } else {
        this.chunks = [detachIfOversized(active.subarray(offset))];
      }
    } else if (this.totalLen === 0) {
      this.chunks = [];
    } else if (this.chunks.length > 0) {
      this.chunks[0] = detachIfOversized(this.chunks[0]);
    }

    return out;
  }
}

// Connect end-of-stream envelope carrying an error, so the browser's client sees a clean
// "unavailable" and falls back to its normal re-subscribe path.
export function connectEndStreamError(message, code = 'unavailable') {
  const body = Buffer.from(JSON.stringify({error: {code, message}}), 'utf8');
  const hdr = Buffer.alloc(5);
  hdr[0] = 0x02;
  hdr.writeUInt32BE(body.length, 1);
  return Buffer.concat([hdr, body]);
}

const GRPC_STATUS = {unavailable: 14, unknown: 2};

export function isGrpcWeb(contentType) {
  return /^application\/grpc-web(\+|;|$)/i.test(String(contentType || '').trim());
}

/** gRPC-web trailer frame (flag 0x80) carrying a grpc-status error. */
export function grpcWebEndStreamError(message, code = 'unavailable') {
  const text = `grpc-status: ${GRPC_STATUS[code] ?? 2}\r\ngrpc-message: ${encodeURIComponent(message)}\r\n`;
  const body = Buffer.from(text, 'utf8');
  const hdr = Buffer.alloc(5);
  hdr[0] = 0x80;
  hdr.writeUInt32BE(body.length, 1);
  return Buffer.concat([hdr, body]);
}

/** End-of-stream error frame in the request's own protocol (Connect or gRPC-web). */
export function endStreamError(contentType, message, code = 'unavailable') {
  return isGrpcWeb(contentType) ? grpcWebEndStreamError(message, code) : connectEndStreamError(message, code);
}

export function requestContentType(headers) {
  for (const [k, v] of Object.entries(headers || {})) if (k.toLowerCase() === 'content-type') return String(v);
  return '';
}

function parseJson(buf) {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return {};
  }
}

/**
 * @param {object} opts
 * @param {() => {host: string, port: number, token?: string} | null} opts.getBridge  current bridge address, or null while disconnected
 * @param {(fn: () => void) => () => void} [opts.onReconnected]  subscribe to "tunnel is back" to retry immediately
 * @param {{path: string, headers: object, body: Buffer}} opts.request  the original RPC
 * @param {{writeHead(status:number, headers:object):void, write(buf:Buffer):void, end():void}} opts.sink
 * @param {(msg: string) => void} [opts.log]
 */
export class ResumableRelayStream {
  constructor({getBridge, onReconnected, request, sink, log, label, ...tuning}) {
    this.id = randomUUID().replace(/-/g, '');
    this.getBridge = getBridge;
    this.onReconnected = onReconnected;
    this.request = request;
    this.sink = sink;
    this.log = log || (() => {});
    this.label = label || request.path.split('/').pop();
    this.cfg = {...RELAY_DEFAULTS, ...tuning};
    this.lastSeq = 0;
    this.headSent = false;
    this.done = false;
    this.attempt = 0;
    this.brokenSince = 0;
    this.conns = new Set();
    this.primary = null;
    this.retryTimer = null;
    this.unsubscribe = null;
    this.stats = {attaches: 0, resumes: 0, replayedFrames: 0, duplicateFrames: 0, frames: 0, bytes: 0};
  }

  start() {
    this.connect();
    return this;
  }

  // Browser went away: drop our side and tell the bridge to release the LS subscription.
  cancel() {
    if (this.done) return;
    this.finish();
    this.closeRemote();
  }

  finish() {
    this.done = true;
    clearTimeout(this.retryTimer);
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const c of this.conns) this.destroyConn(c);
  }

  closeRemote() {
    const bridge = this.getBridge();
    if (!bridge) return;
    const headers = {'content-length': '0'};
    if (typeof bridge.token === 'string' && bridge.token.length > 0) {
      headers['x-ag-bridge-token'] = bridge.token;
    }
    const req = http.request({
      host: bridge.host,
      port: bridge.port,
      method: 'POST',
      path: `/relay/close?id=${this.id}`,
      agent: false,
      timeout: 5000,
      headers,
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.end();
  }

  destroyConn(c) {
    this.conns.delete(c);
    clearTimeout(c.stallTimer);
    clearTimeout(c.attachTimer);
    c.dead = true;
    try { c.req.destroy(); } catch {}
    if (this.primary === c) this.primary = null;
  }

  connect() {
    if (this.done) return;
    const bridge = this.getBridge();
    if (!bridge) {
      this.scheduleRetry('tunnel down');
      return;
    }
    const resuming = this.headSent || this.lastSeq > 0;
    const body = Buffer.from(
      JSON.stringify({
        id: this.id,
        afterSeq: this.lastSeq,
        path: this.request.path,
        headers: this.request.headers,
        bodyB64: this.request.body.toString('base64'),
      }),
      'utf8'
    );
    const c = {req: null, parser: new RecordParser(), gotMeta: false, dead: false, stallTimer: null, attachTimer: null, replayed: 0, startedAt: Date.now()};
    this.conns.add(c);
    this.stats.attaches += 1;
    const headers = {'content-type': 'application/json', 'content-length': String(body.length)};
    if (typeof bridge.token === 'string' && bridge.token.length > 0) {
      headers['x-ag-bridge-token'] = bridge.token;
    }
    const req = http.request({
      host: bridge.host,
      port: bridge.port,
      method: 'POST',
      path: '/relay/stream',
      agent: false,
      headers,
    });
    c.req = req;
    c.attachTimer = setTimeout(() => this.attachInParallel(c, `no META after ${this.cfg.attachTimeoutMs}ms`), this.cfg.attachTimeoutMs);
    req.on('response', (res) => {
      if (c.dead) return;
      if (res.statusCode !== 200) {
        let text = '';
        res.on('data', (d) => { text += d; });
        res.on('end', () => {
          if (c.dead) return;
          // The bridge no longer has our stream (reaped, or bridge restarted): we cannot resume.
          if (res.statusCode === 404 && resuming) this.giveUp(`relay stream unknown on bridge (${text.trim()})`);
          else if (res.statusCode >= 400 && res.statusCode < 500) this.giveUp(`relay rejected: ${res.statusCode} ${text.trim()}`);
          else this.connFailed(c, `bridge http ${res.statusCode}`);
        });
        return;
      }
      this.armStall(c);
      res.on('data', (chunk) => {
        if (c.dead) return;
        c.stalled = false;
        this.armStall(c);
        for (const rec of c.parser.push(chunk)) {
          if (c.dead || this.done) return;
          this.onRecord(c, rec, resuming);
        }
      });
      res.on('end', () => this.connFailed(c, 'bridge closed stream'));
      res.on('error', (e) => this.connFailed(c, e.message));
    });
    req.on('error', (e) => this.connFailed(c, e.message));
    req.end(body);
  }

  armStall(c) {
    clearTimeout(c.stallTimer);
    c.stallTimer = setTimeout(() => this.onStall(c), this.cfg.stallMs);
  }

  // No bytes (not even heartbeats) for stallMs. The socket may still be "open" through a hung
  // ssh. Make-before-break: start a new attach now and only drop the old one once the new
  // attach delivers META (the bridge preempts the old writer as soon as the new one attaches).
  onStall(c) {
    this.attachInParallel(c, `stalled ${this.cfg.stallMs}ms`);
  }

  // Keep `c` (it may still deliver) but start another attach next to it. Whichever delivers
  // META first wins and retires the others.
  attachInParallel(c, why) {
    if (c.dead || this.done) return;
    c.stalled = true;
    if (!this.brokenSince) this.brokenSince = Date.now();
    if (Date.now() - this.brokenSince > this.cfg.recoveryWindowMs) {
      this.giveUp(`relay could not resume within ${Math.round(this.cfg.recoveryWindowMs / 1000)}s (${why})`);
      return;
    }
    this.log(`[relay ${this.label} ${this.id.slice(0, 8)}] ${why} at seq=${this.lastSeq}; attaching in parallel`);
    if (![...this.conns].every((x) => x.stalled || x.dead)) return;
    while (this.conns.size >= this.cfg.maxParallelAttaches) {
      const oldest = [...this.conns].sort((a, b) => a.startedAt - b.startedAt)[0];
      this.destroyConn(oldest);
    }
    this.connect();
  }

  onRecord(c, rec, resuming) {
    if (rec.type === REC_META) {
      const meta = parseJson(rec.payload);
      c.gotMeta = true;
      clearTimeout(c.attachTimer);
      // New attach is live: retire every other (stalled / older) connection.
      for (const other of [...this.conns]) if (other !== c) this.destroyConn(other);
      this.primary = c;
      if (!this.headSent) {
        this.headSent = true;
        this.sink.writeHead(Number(meta.status) || 200, meta.headers || {});
      }
      if (resuming) {
        this.stats.resumes += 1;
        const downMs = this.brokenSince ? Date.now() - this.brokenSince : 0;
        this.log(
          `[relay ${this.label} ${this.id.slice(0, 8)}] resumed after_seq=${this.lastSeq} remote_last=${meta.lastSeq} ` +
            `oldest=${meta.oldestSeq} down=${downMs}ms attempt=${this.attempt}`
        );
      }
      this.attempt = 0;
      this.brokenSince = 0;
      return;
    }
    if (rec.type === REC_FRAME) {
      if (rec.seq <= this.lastSeq) {
        this.stats.duplicateFrames += 1;
        return;
      }
      if (rec.seq !== this.lastSeq + 1) {
        this.giveUp(`relay gap: expected seq ${this.lastSeq + 1}, got ${rec.seq}`);
        return;
      }
      if (resuming) c.replayed += 1;
      this.lastSeq = rec.seq;
      this.stats.frames += 1;
      this.stats.bytes += rec.payload.length;
      this.sink.write(rec.payload);
      return;
    }
    if (rec.type === REC_END) {
      const info = parseJson(rec.payload);
      if (info.reason === 'gap') {
        this.giveUp(`relay replay buffer no longer has seq ${this.lastSeq + 1} (oldest=${info.oldestSeq})`);
        return;
      }
      this.finish();
      this.sink.end();
      this.closeRemote();
      return;
    }
    // REC_BEAT: nothing to do; armStall already ran.
  }

  connFailed(c, reason) {
    if (c.dead || this.done) return;
    this.destroyConn(c);
    // Another attach that is not known to be stalled is still in flight or live: let it work.
    // Stalled connections are kept (they may recover) but do not count.
    if ([...this.conns].some((x) => !x.stalled)) return;
    if (!this.brokenSince) this.brokenSince = Date.now();
    this.scheduleRetry(reason);
  }

  scheduleRetry(reason) {
    if (this.done) return;
    if (!this.brokenSince) this.brokenSince = Date.now();
    const downMs = Date.now() - this.brokenSince;
    if (downMs > this.cfg.recoveryWindowMs) {
      this.giveUp(`relay could not resume within ${Math.round(this.cfg.recoveryWindowMs / 1000)}s (${reason})`);
      return;
    }
    const exp = Math.min(this.cfg.backoffMaxMs, this.cfg.backoffBaseMs * 2 ** this.attempt);
    const delay = Math.round(exp / 2 + Math.random() * (exp / 2));
    if (this.attempt === 0) {
      this.log(`[relay ${this.label} ${this.id.slice(0, 8)}] link lost at seq=${this.lastSeq} (${reason}); resuming`);
    }
    this.attempt += 1;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.connect();
    }, delay);
    // Retry right away when the tunnel comes back instead of waiting out the backoff.
    if (this.onReconnected && !this.unsubscribe) {
      this.unsubscribe = this.onReconnected(() => {
        if (this.done || [...this.conns].some((x) => !x.stalled)) return;
        clearTimeout(this.retryTimer);
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.connect();
      });
    }
  }

  giveUp(reason) {
    if (this.done) return;
    this.log(`[relay ${this.label} ${this.id.slice(0, 8)}] giving up at seq=${this.lastSeq}: ${reason}`);
    this.finish();
    if (!this.headSent) {
      this.sink.writeHead(502, {'content-type': 'text/plain'});
      this.sink.write(Buffer.from(`relay unavailable: ${reason}`));
    } else {
      this.sink.write(endStreamError(requestContentType(this.request.headers), reason));
    }
    this.sink.end();
    this.closeRemote();
  }
}
