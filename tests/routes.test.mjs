import {test} from 'node:test';
import assert from 'node:assert/strict';

process.env.AG_SSH_DIRECT_HOST = 'box-direct';
process.env.AG_SSH_TUNNEL_HOST = 'box-tunnel';
const {routeHosts, normalizeSshMode, hostForMode, roleForHost} = await import('../src/routes.mjs');

test('route hosts come from env', () => {
  assert.deepEqual({...routeHosts()}, {direct: 'box-direct', tunnel: 'box-tunnel'});
  assert.equal(hostForMode('tunnel'), 'box-tunnel');
  assert.equal(hostForMode('auto'), null);
  assert.equal(roleForHost('box-direct'), 'direct');
});

test('modes normalize to roles, legacy alias values migrate', () => {
  for (const m of ['local', 'auto', 'direct', 'tunnel']) assert.equal(normalizeSshMode(m), m);
  assert.equal(normalizeSshMode('box-direct'), 'direct');
  assert.equal(normalizeSshMode('box-tunnel'), 'tunnel');
  assert.equal(normalizeSshMode('unknown-host'), 'auto');
  assert.equal(normalizeSshMode(undefined), 'auto');
});
