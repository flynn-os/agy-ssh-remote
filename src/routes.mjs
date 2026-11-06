// SSH route configuration.
//
// The proxy can reach the remote dev box over two routes:
//   direct: a low-latency path (LAN, Tailscale, ...)
//   tunnel: a fallback path (jump host, reverse tunnel, ...)
// Each route is an ssh host alias from ~/.ssh/config. Aliases are personal, so they are not
// in the code: set them in config.json ("sshRoutes": {"direct": "...", "tunnel": "..."}) or
// with AG_SSH_DIRECT_HOST / AG_SSH_TUNNEL_HOST.
//
// SSH modes are role names: local | auto | direct | tunnel.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.basename(SRC_DIR) === 'src' ? path.dirname(SRC_DIR) : SRC_DIR;
const CONFIG_CANDIDATES = [path.join(ROOT_DIR, 'config.json'), path.join(ROOT_DIR, 'config', 'config.json')];

export const ROUTE_ROLES = ['direct', 'tunnel'];
export const SSH_MODES = ['local', 'auto', ...ROUTE_ROLES];
export const DEFAULT_ROUTE_HOSTS = Object.freeze({direct: 'devbox', tunnel: 'devbox-tunnel'});
const HOST_ALIAS_RE = /^[A-Za-z0-9._@-]{1,128}$/;
const CACHE_MS = 5000;

let cached = null;
let cachedAt = 0;

function readConfiguredRoutes() {
  for (const p of CONFIG_CANDIDATES) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (cfg && typeof cfg.sshRoutes === 'object' && cfg.sshRoutes) return cfg.sshRoutes;
      return {};
    } catch {}
  }
  return {};
}

function pick(...values) {
  for (const v of values) {
    if (typeof v === 'string' && HOST_ALIAS_RE.test(v.trim())) return v.trim();
  }
  return '';
}

/** @returns {{direct: string, tunnel: string}} ssh host aliases for each route */
export function routeHosts() {
  if (cached && Date.now() - cachedAt < CACHE_MS) return cached;
  const cfg = readConfiguredRoutes();
  cached = Object.freeze({
    direct: pick(process.env.AG_SSH_DIRECT_HOST, cfg.direct) || DEFAULT_ROUTE_HOSTS.direct,
    tunnel: pick(process.env.AG_SSH_TUNNEL_HOST, cfg.tunnel) || DEFAULT_ROUTE_HOSTS.tunnel,
  });
  cachedAt = Date.now();
  return cached;
}

export function hostForMode(mode) {
  return ROUTE_ROLES.includes(mode) ? routeHosts()[mode] : null;
}

export function roleForHost(host) {
  const hosts = routeHosts();
  if (host === hosts.direct) return 'direct';
  if (host === hosts.tunnel) return 'tunnel';
  return null;
}

/**
 * Map any mode value to a role mode. Accepts role names and the configured host aliases.
 * Older configs stored the host alias itself as the mode.
 */
export function normalizeSshMode(mode) {
  if (SSH_MODES.includes(mode)) return mode;
  return roleForHost(mode) || 'auto';
}
