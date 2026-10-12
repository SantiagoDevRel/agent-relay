// Rasterize the checked-in MIT brand sources, with real alpha and state colors.
// Requires installed Chrome, no packages or network. Scratch stays in Downloads.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const icons = fileURLToPath(new URL('../web/public/icons/brands/', import.meta.url));
const chrome = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
  .filter(Boolean).map(p => path.join(p, 'Google/Chrome/Application/chrome.exe')).find(fs.existsSync);
if (!chrome) throw new Error('Google Chrome not found');
const scratch = path.join(os.homedir(), 'Downloads/agent-work');
fs.mkdirSync(scratch, { recursive: true });
const temp = fs.mkdtempSync(path.join(scratch, 'chats-brand-png-'));
const sources = Object.fromEntries(['claude', 'openai'].map(name => [name,
  fs.readFileSync(path.join(icons, name + '.svg'), 'utf8')]));
const colors = { plain: '#f5f3ec', working: '#4bd5a0', waiting: '#e8bb4c',
  cut: '#ed6963', closed: 'oklch(0.74 0.04 75)', unknown: 'oklch(0.76 0.14 302)' };
const html = path.join(temp, 'rasterize.html');
fs.writeFileSync(html, `<!doctype html><pre id="result"></pre><script>
const sources=${JSON.stringify(sources)}, colors=${JSON.stringify(colors)};
(async()=>{const out={}; for(const [brand,svg] of Object.entries(sources)) {
 const image=new Image(); image.src='data:image/svg+xml;base64,'+btoa(svg);
 await image.decode();
 for(const [state,color] of Object.entries(colors)) {
  const c=document.createElement('canvas'); c.width=c.height=96; const ctx=c.getContext('2d');
  ctx.drawImage(image,0,0,96,96); ctx.globalCompositeOperation='source-in'; ctx.fillStyle=color; ctx.fillRect(0,0,96,96);
  const alpha=ctx.getImageData(0,0,1,1).data[3]; if(alpha!==0) throw Error('Nontransparent corner');
  out[brand+'-'+state+'.png']=c.toDataURL('image/png').split(',')[1];
 }
} document.getElementById('result').textContent=JSON.stringify(out);})().catch(e=>document.getElementById('result').textContent='ERROR:'+e);
</script>`);
const dom = execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--user-data-dir=${path.join(temp, 'profile')}`, '--virtual-time-budget=3000', '--dump-dom', pathToFileURL(html).href],
{ encoding: 'utf8', windowsHide: true, timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 2_000_000 });
const output = JSON.parse(dom.match(/<pre id="result">([^<]+)<\/pre>/)?.[1] || 'null');
if (!output || Object.keys(output).length !== 12) throw new Error('PNG rasterization incomplete');
for (const [name, png] of Object.entries(output)) fs.writeFileSync(path.join(icons, name), Buffer.from(png, 'base64'));
// Only this invocation's own temporary profile/files are removed.
fs.rmSync(temp, { recursive: true, force: true });
console.log('12 transparent 96px brand PNGs verified and written.');
