#!/usr/bin/env node
// Explicit opt-in to one private HTTPS Serve endpoint. Never reset/Funnel/LAN.
import {execFile} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {mobileConfigPath, readMobileConfig, validateMobileConfig, writeMobileConfig} from '../server/remote-access.mjs';

const exec = promisify(execFile);
const TAILSCALE = process.platform === 'win32' ? 'C:/Program Files/Tailscale/tailscale.exe' : 'tailscale';
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const empty = value => object(value) && Object.keys(value).length === 0;
function parseJson(stdout) {
  try { const data = JSON.parse(stdout); if (object(data)) return data; } catch {}
  throw Error('Local Tailscale state could not be verified.');
}
export function deriveMobileConfig(status, port) {
  if (status.BackendState !== 'Running' || !status.Self || status.Self.Tags?.length) throw Error('Tailscale must be connected with your account, without tags.');
  const uid = status.Self.UserID;
  if ((typeof uid !== 'number' && typeof uid !== 'string') || !Object.hasOwn(status.User || {}, String(uid))) throw Error('The owner of this device could not be identified.');
  const ownerLogin = status.User[String(uid)]?.LoginName;
  const dns = status.Self.DNSName;
  if (typeof dns !== 'string') throw Error('The private domain of this device could not be verified.');
  return validateMobileConfig({version: 1, enabled: true, origin: `https://${dns.replace(/\.$/, '')}`, ownerLogin, backendPort: port, createdAt: Date.now()}, port);
}
export function ownsServe(config, mobile) {
  if (!object(config) || Object.keys(config).some(key => !['TCP', 'Web', 'AllowFunnel'].includes(key))) return false;
  const host = `${new URL(mobile.origin).host}:443`;
  const tcp = config.TCP, web = config.Web;
  if (!object(tcp) || Object.keys(tcp).length !== 1 || !object(tcp['443']) ||
      Object.keys(tcp['443']).length !== 1 || tcp['443'].HTTPS !== true ||
      !object(web) || Object.keys(web).length !== 1 || !object(web[host]) ||
      Object.keys(web[host]).length !== 1 || !object(web[host].Handlers) || Object.keys(web[host].Handlers).length !== 1) return false;
  const handler = web[host].Handlers['/'];
  if (!object(handler) || Object.keys(handler).length !== 1 || handler.Proxy !== `http://127.0.0.1:${mobile.backendPort}`) return false;
  return config.AllowFunnel == null || (object(config.AllowFunnel) && Object.keys(config.AllowFunnel).every(key => key === host && config.AllowFunnel[key] === false));
}
function localRequest(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({hostname: '127.0.0.1', port, path: '/api/ping', headers, timeout: 4000}, res => {
      let bytes = 0, body = '';
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 8192) req.destroy(Error('Local response is too large.')); else body += chunk; });
      res.on('end', () => { let data; try { data = JSON.parse(body); } catch {} resolve({status: res.statusCode, data}); });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Error('The local server did not respond.')));
    req.on('error', reject);
  });
}
async function verifyGate(request, port, mobile) {
  const host = new URL(mobile.origin).host;
  const proxy = {'host': host, 'x-forwarded-host': host, 'x-forwarded-proto': 'https'};
  const probes = [
    {...proxy},
    {...proxy, 'tailscale-user-login': 'agent-relay-untrusted@example.invalid'},
    {...proxy, 'host': `127.0.0.1:${port}`, 'tailscale-user-login': mobile.ownerLogin},
    {...proxy, 'tailscale-user-login': mobile.ownerLogin, 'tailscale-funnel-request': '?1'},
  ];
  for (const headers of probes) {
    const response = await request(port, headers);
    if (response.status !== 403) throw Error('The server did not confirm mobile identity protection.');
  }
  const owner = await request(port, {...proxy, 'tailscale-user-login': mobile.ownerLogin});
  if (owner.status !== 200 || owner.data?.app !== 'chats-dashboard' || owner.data?.mobile?.origin !== mobile.origin || owner.data?.mobile?.enabled !== true) throw Error('The server did not confirm your private mobile access.');
}

export async function enableMobile({port = Number(process.env.CHATS_PORT || 4848), file = mobileConfigPath(),
  tailscalePath = TAILSCALE, execImpl = exec, requestImpl = localRequest, enable = true} = {}) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw Error('Invalid port.');
  if (process.env.AI_RELAY_MANAGED === '1') throw Error('A worker cannot enable mobile access.');
  const call = async args => {
    try { return await execImpl(tailscalePath, args, {encoding: 'utf8', windowsHide: true, shell: false, timeout: 20_000, maxBuffer: 1024 * 1024}); }
    catch (error) { const clean = Error('Tailscale did not complete the local operation.'); clean.code = error.code; throw clean; }
  };
  const mobile = deriveMobileConfig(parseJson((await call(['status', '--json'])).stdout), port);
  const initial = parseJson((await call(['serve', 'status', '--json'])).stdout);
  const saved = readMobileConfig(file, port);
  if (fs.existsSync(file) && (!saved || saved.origin !== mobile.origin || saved.ownerLogin !== mobile.ownerLogin)) throw Error('The existing mobile configuration needs review; it was not replaced.');
  const owned = !!saved && ownsServe(initial, mobile);
  if (!empty(initial) && !owned) throw Error('An unrelated Serve configuration already exists; it was not modified.');
  const ready = await requestImpl(port);
  if (ready.status !== 200 || ready.data?.app !== 'chats-dashboard' || ready.data?.mobile?.ready !== true || ready.data?.mobile?.auth !== 'tailscale-owner') throw Error('Start Agent Relay with the updated mobile protection first.');
  if (!enable) return {enabled: owned && saved.enabled, origin: mobile.origin, ready: true, private: true};
  const config = {...mobile, createdAt: saved?.createdAt || mobile.createdAt};
  writeMobileConfig(file, config); // The backend gate must be active before Serve.
  try {
    await verifyGate(requestImpl, port, config);
    const fresh = parseJson((await call(['serve', 'status', '--json'])).stdout);
    if (owned && ownsServe(fresh, config)) return {enabled: true, origin: config.origin, private: true, reused: true};
    if (!empty(fresh)) throw Error('Serve changed during preparation; it was not modified.');
    // CLI preserves its own read/write ETag and rejects concurrent changes. The
    // final empty check avoids replacing any observed existing Serve config.
    await call(['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`]);
    const final = parseJson((await call(['serve', 'status', '--json'])).stdout);
    if (!ownsServe(final, config)) throw Error('The exact private endpoint could not be confirmed; review Tailscale.');
    return {enabled: true, origin: config.origin, private: true, reused: false};
  } catch (error) {
    // No reset/off: leave external state untouched, but close our own app gate.
    writeMobileConfig(file, {...config, enabled: false});
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  try {
    let enable = false, port = Number(process.env.CHATS_PORT || 4848);
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--enable') enable = true;
      else if (args[index] === '--check') enable = false;
      else if (args[index] === '--port') port = Number(args[++index]);
      else throw Error('Usage: node scripts/enable-mobile.mjs --check|--enable [--port 4848]');
    }
    console.log(JSON.stringify(await enableMobile({port, enable}), null, 2));
  } catch (error) {
    console.error(error.message);
    console.error('If HTTPS is missing from your tailnet, enable it in the Tailscale dashboard and retry. Funnel is not enabled.');
    process.exitCode = 1;
  }
}
