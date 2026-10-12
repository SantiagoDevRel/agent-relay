// Private machine configuration is loaded before server modules read environment settings.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
export const CONFIG_FILE = process.env.CHATS_CONFIG_FILE || path.join(process.env.LOCALAPPDATA || os.homedir(),'chats-dashboard','config.local.json');
const keys = new Set(['CHATS_WORKSPACE_ROOT','CHATS_TOPICS_FILE','CHATS_SUMMARY_URL','CHATS_SUMMARY_MODEL','CHATS_DGX_PROBE','CHATS_SECRET_SCANNER','CHATS_RUNNER_SESSIONS','CHATS_NOTIFICATION_APP_ID','CHATS_DELIVERY_DEFAULTS_FILE']);
try {
  if(fs.statSync(CONFIG_FILE).size>64*1024)throw Error('Private configuration exceeds 64 KB');
  const value=JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.entries(value).some(([key,item])=>!keys.has(key)||typeof item!=='string'||!item||/[\x00-\x1f]/.test(item)))throw Error('Invalid private configuration');
  for(const [key,item] of Object.entries(value))if(process.env[key]===undefined)process.env[key]=item;
} catch(error){if(error.code!=='ENOENT')throw Error('Could not load private configuration; check its schema locally');}
export const WORKSPACE = path.resolve(process.env.CHATS_WORKSPACE_ROOT || path.join(os.homedir(),'Projects'));
export const TOPICS_FILE = process.env.CHATS_TOPICS_FILE || new URL('../topics.example.json',import.meta.url);
export const RUNNER_SESSIONS = process.env.CHATS_RUNNER_SESSIONS || path.join(process.env.LOCALAPPDATA || os.homedir(),'chats-dashboard','runner-sessions');
