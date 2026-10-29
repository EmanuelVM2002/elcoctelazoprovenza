// Servidor local sin dependencias: archivos de la página + /api con el mismo Worker (Durable Object simulado en memoria).
// Uso: node test/dev-server.mjs   → http://localhost:8851   (los secretos locales salen de .dev.vars; si no existe, de prueba)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEnv, worker, mesaToken } from './fake-do.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8851);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
const HIDDEN = /^\/(worker|test|\.git|node_modules|qr-mesas)(\/|$)|^\/(wrangler\.jsonc|\.assetsignore|\.gitignore|\.dev\.vars.*|package\.json)$/;

const vars = {};
try { for (const line of fs.readFileSync(path.join(ROOT, '.dev.vars'), 'utf8').split(/\r?\n/)) { const m = /^([A-Z_]+)=(.*)$/.exec(line.trim()); if (m) vars[m[1]] = m[2]; } } catch (e) {}
const env = makeEnv(vars);
env.ASSETS = { async fetch(req) {
  let u = decodeURIComponent(new URL(req.url).pathname);
  if (u === '/') u = '/index.html';
  if (HIDDEN.test(u)) return new Response('404', { status: 404 });
  const fp = path.join(ROOT, u);
  if (!fp.startsWith(ROOT)) return new Response('404', { status: 404 });
  try { return new Response(fs.readFileSync(fp), { headers: { 'Content-Type': TYPES[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' } }); }
  catch (e) { return new Response('404', { status: 404 }); }
} };

http.createServer(async (q, r) => {
  const chunks = []; for await (const c of q) chunks.push(c);
  const req = new Request('http://localhost:' + PORT + q.url, { method: q.method, headers: q.headers, body: ['GET', 'HEAD'].includes(q.method) ? undefined : Buffer.concat(chunks) });
  const res = await worker.fetch(req, env);
  r.writeHead(res.status, Object.fromEntries(res.headers));
  r.end(Buffer.from(await res.arrayBuffer()));
}).listen(PORT, async () => {
  console.log(`Local: http://localhost:${PORT}   (usuario ${env.ADMIN_USER})`);
  for (const n of [1, 2, 3]) console.log(`  mesa ${n}: http://localhost:${PORT}/?m=${n}&k=${await mesaToken(env.QR_SECRET, n)}`);
});
