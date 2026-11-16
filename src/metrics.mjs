export const DEFAULT_CONTEXT_LIMIT_TOKENS = 512000;

export function parseProto(buf) {
  const out = new Map();
  if (!(buf instanceof Uint8Array)) return out;
  let i = 0;
  while (i < buf.length) {
    let tag = 0;
    let shift = 0;
    while (i < buf.length) {
      const b = buf[i++];
      tag += (b & 0x7f) * Math.pow(2, shift);
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const fn = Math.floor(tag / 8);
    const wt = tag % 8;
    if (fn <= 0) break;
    if (wt === 0) {
      let val = 0;
      let s = 0;
      while (i < buf.length) {
        const b = buf[i++];
        val += (b & 0x7f) * Math.pow(2, s);
        if (!(b & 0x80)) break;
        s += 7;
      }
      out.set(fn, val);
    } else if (wt === 2) {
      let len = 0;
      let s = 0;
      while (i < buf.length) {
        const b = buf[i++];
        len += (b & 0x7f) * Math.pow(2, s);
        if (!(b & 0x80)) break;
        s += 7;
      }
      if (!Number.isFinite(len) || len < 0 || i + len > buf.length) break;
      out.set(fn, buf.subarray(i, i + len));
      i += len;
    } else if (wt === 1) {
      if (i + 8 > buf.length) break;
      out.set(fn, buf.subarray(i, i + 8));
      i += 8;
    } else if (wt === 5) {
      if (i + 4 > buf.length) break;
      out.set(fn, buf.subarray(i, i + 4));
      i += 4;
    } else {
      break;
    }
  }
  return out;
}

function subProto(map, fieldNumber) {
  const v = map.get(fieldNumber);
  return v instanceof Uint8Array ? parseProto(v) : new Map();
}

function positiveInt(val) {
  return typeof val === 'number' && Number.isFinite(val) && val > 0 ? Math.round(val) : 0;
}

export function fmtTok(n) {
  if (!n || n <= 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n >= 10000) return Math.round(n / 1000) + 'k';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

export function fmtNum(n) {
  return (n || 0).toLocaleString('en-US');
}

export function resolveFallbackContextLimit(config) {
  return positiveInt(config?.contextLimit) || DEFAULT_CONTEXT_LIMIT_TOKENS;
}

export function resolveContextLimit(parsedRows, validRows, fallbackLimit = DEFAULT_CONTEXT_LIMIT_TOKENS) {
  for (let i = validRows.length - 1; i >= 0; i--) {
    const limit = positiveInt(validRows[i]?.maxContextTokens);
    if (limit > 0) return limit;
  }
  for (let i = parsedRows.length - 1; i >= 0; i--) {
    const limit = positiveInt(parsedRows[i]?.maxContextTokens);
    if (limit > 0) return limit;
  }
  return positiveInt(fallbackLimit) || DEFAULT_CONTEXT_LIMIT_TOKENS;
}

export function parseSingleMetricRow(r) {
  const rawVal = r?.data ?? r?.b64 ?? '';
  const rawBuf = Buffer.isBuffer(rawVal)
    ? rawVal
    : (rawVal instanceof Uint8Array ? Buffer.from(rawVal) : Buffer.from(String(rawVal), 'base64'));
  const top = parseProto(rawBuf);
  const chat = subProto(top, 1);
  const usage = subProto(chat, 4);
  const chatStart = subProto(chat, 9);
  const contextWindow = subProto(chatStart, 10);
  const ttftMap = subProto(chat, 11);
  const streamMap = subProto(chat, 12);

  const inTok = usage.get(2) || 0;
  const outTok = usage.get(3) || 0;
  const cacheRead = usage.get(5) || 0;
  const thinkTok = usage.get(9) || 0;
  const respTok = usage.get(10) || 0;
  const maxContextTokens = positiveInt(contextWindow.get(4));
  const ttft = (ttftMap.get(1) || 0) + (ttftMap.get(2) || 0) / 1e9;
  const stream = (streamMap.get(1) || 0) + (streamMap.get(2) || 0) / 1e9;

  return {
    idx: r.idx,
    inTok,
    outTok,
    cacheRead,
    ctx: inTok + cacheRead,
    thinkTok,
    respTok,
    maxContextTokens,
    ttft,
    stream,
    totDur: ttft + stream,
  };
}

export function computeMetricsFromRows(
  cascadeId,
  sig,
  rows,
  userSteps,
  plannerSteps,
  preParsedRows = null,
  fallbackLimit = DEFAULT_CONTEXT_LIMIT_TOKENS
) {
  const parsed = preParsedRows || (rows || []).map(parseSingleMetricRow);
  if (!parsed || parsed.length === 0) {
    return {cascadeId, hasData: false, sig};
  }
  const normIdx = item => (typeof item === 'number' ? item : item?.idx ?? 0);
  const lastUserStepIdx = userSteps.length > 0 ? normIdx(userSteps[userSteps.length - 1]) : -1;
  let totalIn = 0;
  let totalCache = 0;
  let totalOut = 0;
  let totalThink = 0;
  let totalResp = 0;
  let rawTurnSteps = 0;
  for (let i = 0; i < plannerSteps.length; i++) {
    if (normIdx(plannerSteps[i]) > lastUserStepIdx) rawTurnSteps++;
  }

  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    totalIn += p.inTok;
    totalCache += p.cacheRead;
    totalOut += p.outTok;
    totalThink += p.thinkTok;
    totalResp += p.respTok;
  }

  // Filter 0-usage metadata snapshot rows (upstream chuanban v5.0.0) so Ctx never drops to 0%
  const valid = parsed.filter(p => p.ctx > 0 || p.outTok > 0);
  if (valid.length === 0) {
    return {cascadeId, hasData: false, sig};
  }

  const turnSlice = rawTurnSteps > 0 ? valid.slice(-rawTurnSteps) : [];
  const turnSteps = turnSlice.length;
  let turnOut = 0;
  let turnThink = 0;
  let turnResp = 0;
  let turnDur = 0;
  for (let i = 0; i < turnSlice.length; i++) {
    turnOut += turnSlice[i].outTok;
    turnThink += turnSlice[i].thinkTok;
    turnResp += turnSlice[i].respTok;
    turnDur += turnSlice[i].totDur;
  }

  const last = valid[valid.length - 1];
  const ctxLimit = resolveContextLimit(parsed, valid, fallbackLimit);
  const ctxLimitLabel = fmtTok(ctxLimit);
  const streamTps = last.stream >= 0.25 ? (last.outTok / last.stream) : 0;
  const e2eTps = last.totDur > 0 ? (last.outTok / last.totDur) : 0;
  const displayTps = (streamTps > 0 && streamTps <= 600) ? streamTps : e2eTps;
  const ctxPct = Math.round((last.ctx / ctxLimit) * 100);
  const ctxClass = ctxPct >= 90 ? 'ag-ctx-crit' : (ctxPct >= 75 ? 'ag-ctx-warn' : 'ag-ctx-ok');
  const lastCacheRate = last.ctx > 0 ? ((last.cacheRead / last.ctx) * 100).toFixed(1) : '0.0';
  const sessionCacheRate = (totalIn + totalCache) > 0 ? ((totalCache / (totalIn + totalCache)) * 100).toFixed(1) : '0.0';
  const remainCtx = Math.max(0, ctxLimit - last.ctx);

  const inlineHtml = [
    `<span>${Math.round(displayTps)} tok/s</span><span class="ag-sep">·</span>`,
    `<span>TTFT ${last.ttft.toFixed(1)}s</span><span class="ag-sep">·</span>`,
    `<span>Ctx ${fmtTok(last.ctx)}/${ctxLimitLabel} <span class="${ctxClass}">(${ctxPct}%)</span></span><span class="ag-sep">·</span>`,
    `<span>Out ${fmtTok(last.outTok)}</span>`,
  ].join('');

  const turnRowHtml = turnSteps > 1
    ? `<div class="ag-tt-row"><span class="ag-tt-lbl">本轮合计 (${turnSteps}步)</span><span class="ag-tt-val">输出 ${fmtNum(turnOut)} (思考 ${fmtNum(turnThink)} + 响应 ${fmtNum(turnResp)}) | 耗时 ${turnDur.toFixed(1)}s</span></div>`
    : '';

  const tooltipHtml = [
    `<div class="ag-tt-hdr">本轮最新调用 (Gen #${last.idx + 1})</div>`,
    `<div class="ag-tt-row"><span class="ag-tt-lbl">生成速度</span><span class="ag-tt-val">${streamTps > 0 && streamTps <= 600 ? `流式 ${streamTps.toFixed(1)} tok/s | ` : ''}端到端 ${e2eTps.toFixed(1)} tok/s</span></div>`,
    `<div class="ag-tt-row"><span class="ag-tt-lbl">响应耗时</span><span class="ag-tt-val">TTFT ${last.ttft.toFixed(2)}s | 流式 ${last.stream.toFixed(2)}s | 总计 ${last.totDur.toFixed(2)}s</span></div>`,
    `<div class="ag-tt-row"><span class="ag-tt-lbl">当前上下文</span><span class="ag-tt-val">${fmtNum(last.ctx)} (新增 ${fmtNum(last.inTok)} + 缓存 ${fmtNum(last.cacheRead)}, ${lastCacheRate}%)</span></div>`,
    `<div class="ag-tt-row"><span class="ag-tt-lbl">本步输出量</span><span class="ag-tt-val">${fmtNum(last.outTok)} (思考链 ${fmtNum(last.thinkTok)} + 正文/工具 ${fmtNum(last.respTok)})</span></div>`,
    turnRowHtml,
    `<div class="ag-tt-hdr ag-tt-sec">当前会话累计 (${userSteps.length} 轮提问 / ${valid.length} 次有效调用)</div>`,
    `<div class="ag-tt-row"><span class="ag-tt-lbl">压缩水位线</span><span class="ag-tt-val">${fmtTok(last.ctx)} / ${ctxLimitLabel} (${ctxPct}%) · 距压缩余 ${fmtTok(remainCtx)}</span></div>`,
    `<div class="ag-tt-row"><span class="ag-tt-lbl">累计输入量</span><span class="ag-tt-val">新增 ${fmtTok(totalIn)} + 缓存读取 ${fmtTok(totalCache)} (命中率 ${sessionCacheRate}%)</span></div>`,
    `<div class="ag-tt-row"><span class="ag-tt-lbl">累计输出量</span><span class="ag-tt-val">总计 ${fmtTok(totalOut)} (思考链 ${fmtTok(totalThink)} + 正文/工具 ${fmtTok(totalResp)})</span></div>`,
  ].join('');

  return {cascadeId, hasData: true, sig, contextLimit: ctxLimit, inlineHtml, tooltipHtml};
}
