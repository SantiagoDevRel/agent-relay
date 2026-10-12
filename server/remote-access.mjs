// Tailscale Serve identity is trusted only through our loopback HTTP listener.
// Serve v1.102.2 preserves the original TCP proxy Host and replaces identity and
// forwarding headers: tailscale/tailscale/ipn/ipnlocal/serve.go (Rewrite).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const CONFIG_LIMIT = 4096;
const LOGIN = /^[\x21-\x7e]{1,320}$/;
const DNS = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$/;
const PROXY_HEADERS = /^(?:tailscale-|x-forwarded-|forwarded$)/i;
export const mobileConfigPath = (env = process.env, home = os.homedir()) =>
  path.join(env.LOCALAPPDATA || home, 'chats-dashboard', 'mobile.json');

export function validateMobileConfig(value, port) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 ||
      typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.backendPort) ||
      value.backendPort < 1 || value.backendPort > 65535 || (port != null && value.backendPort !== port) ||
      typeof value.ownerLogin !== 'string' || !LOGIN.test(value.ownerLogin) ||
      typeof value.origin !== 'string') throw Error('Invalid private mobile configuration');
  const allowed = new Set(['version', 'enabled', 'origin', 'ownerLogin', 'backendPort', 'createdAt']);
  if (Object.keys(value).some(key => !allowed.has(key)) ||
      (value.createdAt != null && !Number.isSafeInteger(value.createdAt))) throw Error('Invalid private mobile configuration');
  let url;
  try { url = new URL(value.origin); } catch { throw Error('Invalid mobile origin'); }
  if (url.protocol !== 'https:' || !DNS.test(url.hostname) || url.username || url.password || url.port ||
      url.pathname !== '/' || url.search || url.hash || value.origin !== url.origin) throw Error('Invalid mobile origin');
  return {...value};
}

export function readMobileConfig(file, port) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size > CONFIG_LIMIT) return null;
    const data = Buffer.alloc(CONFIG_LIMIT + 1); let size = 0;
    while (size < data.length) {
      const count = fs.readSync(fd, data, size, data.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > CONFIG_LIMIT) return null;
    return validateMobileConfig(JSON.parse(data.subarray(0, size).toString('utf8')), port);
  } catch { return null; } finally { if (fd != null) fs.closeSync(fd); }
}

export function writeMobileConfig(file, value) {
  const config = validateMobileConfig(value);
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  // Per-user LOCALAPPDATA inherits the user's ACL on Windows; mode protects Unix.
  fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  fs.renameSync(temp, file);
}

const loopback = address => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
const header = (req, key) => typeof req.headers?.[key] === 'string' ? req.headers[key] : null;
function duplicated(req, key) {
  if (!Array.isArray(req.rawHeaders)) return false;
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) if (String(req.rawHeaders[index]).toLowerCase() === key) count++;
  return count > 1;
}

export class RemoteAccess {
  constructor({file = mobileConfigPath(), port = Number(process.env.CHATS_PORT || 4848)} = {}) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw Error('Invalid backend port');
    this.file = file; this.port = port;
    this.localHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  }
  publicState() {
    const config = readMobileConfig(this.file, this.port);
    return {ready: true, enabled: config?.enabled === true, origin: config?.enabled ? config.origin : null, auth: 'tailscale-owner'};
  }
  authorize(req) {
    const deny = (status, remote = false) => ({allowed: false, status, remote, origin: null});
    if (!loopback(req.socket?.remoteAddress)) return deny(403);
    const host = header(req, 'host');
    if (!host || duplicated(req, 'host')) return deny(421);
    if (this.localHosts.has(host)) {
      // A reverse proxy that rewrites Host must not inherit local access. Never
      // promote X-Forwarded-Host into Host or trust local proxy identity headers.
      if (Object.keys(req.headers || {}).some(key => PROXY_HEADERS.test(key))) return deny(403, true);
      return {allowed: true, status: 200, remote: false, origin: `http://${host}`};
    }
    const config = readMobileConfig(this.file, this.port);
    if (!config?.enabled || host !== new URL(config.origin).host) return deny(421, true);
    if (duplicated(req, 'tailscale-user-login') || duplicated(req, 'x-forwarded-host') || duplicated(req, 'x-forwarded-proto') ||
        header(req, 'tailscale-user-login') !== config.ownerLogin || header(req, 'x-forwarded-host') !== host ||
        header(req, 'x-forwarded-proto') !== 'https' || Object.hasOwn(req.headers || {}, 'tailscale-funnel-request')) return deny(403, true);
    return {allowed: true, status: 200, remote: true, origin: config.origin};
  }
  originAllowed(req, authorization = this.authorize(req)) {
    return authorization.allowed && header(req, 'origin') === authorization.origin && !duplicated(req, 'origin');
  }
}
