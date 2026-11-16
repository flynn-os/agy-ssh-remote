import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  DEFAULT_CONTEXT_LIMIT_TOKENS,
  computeMetricsFromRows,
  fmtTok,
  parseSingleMetricRow,
  resolveContextLimit,
  resolveFallbackContextLimit,
} from '../src/metrics.mjs';

function encodeVarint(n) {
  const bytes = [];
  let v = n;
  while (v >= 0x80) {
    bytes.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function fieldVarint(fieldNum, val) {
  return Buffer.concat([encodeVarint(fieldNum * 8), encodeVarint(val)]);
}

function fieldBytes(fieldNum, buf) {
  return Buffer.concat([encodeVarint(fieldNum * 8 + 2), encodeVarint(buf.length), buf]);
}

function buildGenMetadataBlob({
  inTok = 0,
  outTok = 0,
  cacheRead = 0,
  thinkTok = 0,
  respTok = 0,
  maxContextTokens = 0,
  ttftSec = 1,
  streamSec = 2,
} = {}) {
  const usage = Buffer.concat([
    ...(inTok ? [fieldVarint(2, inTok)] : []),
    ...(outTok ? [fieldVarint(3, outTok)] : []),
    ...(cacheRead ? [fieldVarint(5, cacheRead)] : []),
    ...(thinkTok ? [fieldVarint(9, thinkTok)] : []),
    ...(respTok ? [fieldVarint(10, respTok)] : []),
  ]);
  const chatParts = [fieldBytes(4, usage)];
  if (maxContextTokens > 0) {
    const cwm = fieldVarint(4, maxContextTokens);
    const chatStart = fieldBytes(10, cwm);
    chatParts.push(fieldBytes(9, chatStart));
  }
  if (ttftSec > 0) chatParts.push(fieldBytes(11, fieldVarint(1, ttftSec)));
  if (streamSec > 0) chatParts.push(fieldBytes(12, fieldVarint(1, streamSec)));
  return fieldBytes(1, Buffer.concat(chatParts));
}

test('parseSingleMetricRow extracts max_context_tokens alongside token and timing metrics', () => {
  const blob = buildGenMetadataBlob({
    inTok: 4908,
    outTok: 4849,
    cacheRead: 392281,
    thinkTok: 2601,
    respTok: 2248,
    maxContextTokens: 512000,
    ttftSec: 10,
    streamSec: 21,
  });

  const parsed = parseSingleMetricRow({idx: 95, data: blob.toString('base64')});
  assert.equal(parsed.ctx, 397189);
  assert.equal(parsed.outTok, 4849);
  assert.equal(parsed.maxContextTokens, 512000);
  assert.equal(parsed.ttft, 10);
  assert.equal(parsed.stream, 21);
});

test('computeMetricsFromRows uses dynamic max_context_tokens from gen_metadata (512k, 256k, 840k, 1.00M)', () => {
  for (const [limit, expectedLabel, expectedPct, expectedRemain] of [
    [512000, '512k', 78, '115k'],
    [256000, '256k', 155, '0'],
    [840000, '840k', 47, '443k'],
    [1000000, '1.00M', 40, '603k'],
  ]) {
    const row = {
      idx: 95,
      data: buildGenMetadataBlob({inTok: 4908, outTok: 4849, cacheRead: 392281, maxContextTokens: limit}),
    };
    const payload = computeMetricsFromRows('cid-1', 'sig-1', [row], [{idx: 0}], [{idx: 95}]);
    assert.equal(payload.hasData, true);
    assert.equal(payload.contextLimit, limit);
    assert.match(payload.inlineHtml, new RegExp(`Ctx 397k/${expectedLabel.replace('.', '\\.')} <span class="[^"]+">\\(${expectedPct}%\\)</span>`));
    assert.ok(payload.tooltipHtml.includes(`397k / ${expectedLabel} (${expectedPct}%) · 距压缩余 ${expectedRemain}`));
  }
});

test('mid-conversation rollout or model switch updates the displayed limit dynamically', () => {
  const rows = [
    {idx: 0, data: buildGenMetadataBlob({inTok: 150000, outTok: 1200, maxContextTokens: 256000})},
    {idx: 1, data: buildGenMetadataBlob({inTok: 170000, outTok: 1500, maxContextTokens: 512000})},
    // Trailing 0-usage snapshot row should be ignored for usage, while 512000 remains active.
    {idx: 2, data: buildGenMetadataBlob({inTok: 0, outTok: 0, maxContextTokens: 0})},
  ];
  const payload = computeMetricsFromRows('cid-2', 'sig-2', rows, [0], [1]);
  assert.equal(payload.contextLimit, 512000);
  assert.ok(payload.inlineHtml.includes('Ctx 170k/512k'));
  assert.ok(payload.tooltipHtml.includes('170k / 512k (33%)'));

  // Missing max_context_tokens on the latest valid row falls back to the latest valid row that had one.
  const sparseRows = [
    parseSingleMetricRow({idx: 0, data: buildGenMetadataBlob({inTok: 100000, outTok: 500, maxContextTokens: 512000})}),
    parseSingleMetricRow({idx: 1, data: buildGenMetadataBlob({inTok: 200000, outTok: 600, maxContextTokens: 0})}),
  ];
  assert.equal(resolveContextLimit(sparseRows, sparseRows), 512000);
});

test('falls back cleanly when legacy rows omit max_context_tokens', () => {
  assert.equal(DEFAULT_CONTEXT_LIMIT_TOKENS, 512000);
  assert.equal(resolveFallbackContextLimit(undefined), 512000);
  assert.equal(resolveFallbackContextLimit({contextLimit: 'auto'}), 512000);
  assert.equal(resolveFallbackContextLimit({contextLimit: 256000}), 256000);

  const row = {idx: 0, data: buildGenMetadataBlob({inTok: 100000, outTok: 1000, maxContextTokens: 0})};
  const payload = computeMetricsFromRows('cid-3', 'sig-3', [row], [0], [0]);
  assert.equal(payload.contextLimit, 512000);
  assert.ok(payload.inlineHtml.includes(`/${fmtTok(512000)}`));

  const customFallback = computeMetricsFromRows('cid-3', 'sig-3', [row], [0], [0], null, 256000);
  assert.equal(customFallback.contextLimit, 256000);
  assert.ok(customFallback.inlineHtml.includes('/256k'));
});
