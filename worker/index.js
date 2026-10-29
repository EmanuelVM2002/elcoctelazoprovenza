// Coctelazo & Perritos Gourmet — servidor (Cloudflare Worker + Durable Object).
// Atiende SOLO /api/*; el resto de la página son archivos estáticos (ver wrangler.jsonc).
//
// Qué hace:
//  · Valida la llave del QR de cada mesa (HMAC): la mesa NO se puede inventar escribiendo un número.
//  · Guarda los llamados al mesero (uno por mesa, activo hasta que la barra lo atiende).
//  · Inicia sesión del personal de la barra. Usuario y contraseña viven SOLO como secretos del Worker
//    (nunca en la página ni en el repositorio).
//
// Secretos (Cloudflare → Worker → Variables y secretos, tipo «Secreto»):
//   ADMIN_USER      usuario de la barra
//   ADMIN_PASS      contraseña de la barra
//   SESSION_SECRET  texto largo al azar (firma las sesiones de la barra)
//   QR_SECRET       texto largo al azar (firma los QR de las mesas)

const enc = new TextEncoder();
const MAX_MESA = 99;
const SESSION_MS = 12 * 60 * 60 * 1000;      // la sesión de la barra dura 12 h
const CALL_MS = 3 * 60 * 60 * 1000;          // un llamado olvidado se limpia solo a las 3 h
const LOGIN_MAX_FAILS = 5, LOGIN_WINDOW_MS = 10 * 60 * 1000;

/* ---------- criptografía ---------- */
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

// Comparación en tiempo constante (se comparan los HMAC de ambos textos, que siempre miden lo mismo).
async function safeEqual(a, b) {
  const k = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const [x, y] = await Promise.all([crypto.subtle.sign('HMAC', key, enc.encode(String(a))), crypto.subtle.sign('HMAC', key, enc.encode(String(b)))]);
  const xa = new Uint8Array(x), ya = new Uint8Array(y);
  let diff = 0; for (let i = 0; i < xa.length; i++) diff |= xa[i] ^ ya[i];
  return diff === 0;
}

// Llave de la mesa N: los primeros 12 bytes del HMAC(QR_SECRET, "mesa:N") en base64url (16 caracteres).
export async function mesaToken(secret, mesa) {
  return b64url((await hmac(secret, 'mesa:' + mesa)).slice(0, 12));
}
async function mesaValida(env, m, k) {
  const n = Number(m);
  if (!env.QR_SECRET || !Number.isInteger(n) || n < 1 || n > MAX_MESA || typeof k !== 'string' || k.length > 64) return null;
  return (await safeEqual(await mesaToken(env.QR_SECRET, n), k)) ? n : null;
}

async function sessionToken(env, exp) { return `${exp}.${b64url(await hmac(env.SESSION_SECRET, 'barra:' + exp))}`; }
async function sessionOk(env, request) {
  const h = request.headers.get('Authorization') || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const [exp, sig] = tok.split('.');
  if (!env.SESSION_SECRET || !exp || !sig || !(Number(exp) > Date.now())) return false;
  return safeEqual(await sessionToken(env, exp), tok);
}

/* ---------- utilidades HTTP ---------- */
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});
const bodyOf = async request => { try { return await request.json(); } catch (e) { return {}; } };

/* ---------- Worker ---------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: 'No encontrado' }, 404);
    const barra = env.BARRA.get(env.BARRA.idFromName('provenza'));
    const to = (route, data) => barra.fetch(new Request('http://barra' + route, { method: 'POST', body: JSON.stringify(data || {}) }));

    try {
      // La mesa del QR es válida (la página lo consulta al escanear)
      if (path === '/api/mesa' && request.method === 'GET') {
        const n = await mesaValida(env, url.searchParams.get('m'), url.searchParams.get('k'));
        return n ? json({ ok: true, mesa: n }) : json({ ok: false }, 403);
      }

      // Cliente: estado de su llamado
      if (path === '/api/llamar' && request.method === 'GET') {
        const n = await mesaValida(env, url.searchParams.get('m'), url.searchParams.get('k'));
        if (!n) return json({ ok: false }, 403);
        return barra.fetch(new Request('http://barra/estado?mesa=' + n));
      }

      // Cliente: llama al mesero
      if (path === '/api/llamar' && request.method === 'POST') {
        const b = await bodyOf(request);
        const n = await mesaValida(env, b.m, b.k);
        if (!n) return json({ ok: false }, 403);
        return to('/llamar', { mesa: n });
      }

      // Barra: iniciar sesión
      if (path === '/api/login' && request.method === 'POST') {
        if (!env.ADMIN_USER || !env.ADMIN_PASS || !env.SESSION_SECRET) return json({ ok: false, error: 'Servidor sin configurar' }, 503);
        const ip = request.headers.get('CF-Connecting-IP') || 'local';
        const bloqueo = await (await to('/login-estado', { ip })).json();
        if (bloqueo.bloqueado) return json({ ok: false, error: 'Demasiados intentos. Espera unos minutos.' }, 429);
        const b = await bodyOf(request);
        // se comparan SIEMPRE ambos campos, para no revelar cuál falló
        const okU = await safeEqual(b.usuario ?? '', env.ADMIN_USER);
        const okP = await safeEqual(b.clave ?? '', env.ADMIN_PASS);
        if (!(okU && okP)) {
          await to('/login-fallo', { ip });
          return json({ ok: false, error: 'Usuario o contraseña incorrectos' }, 401);
        }
        await to('/login-ok', { ip });
        const exp = Date.now() + SESSION_MS;
        return json({ ok: true, token: await sessionToken(env, exp), exp });
      }

      // Barra (con sesión): ver y atender llamados
      if (path === '/api/llamados' && request.method === 'GET') {
        if (!(await sessionOk(env, request))) return json({ ok: false }, 401);
        return barra.fetch(new Request('http://barra/lista'));
      }
      if (path === '/api/atender' && request.method === 'POST') {
        if (!(await sessionOk(env, request))) return json({ ok: false }, 401);
        const b = await bodyOf(request);
        return to('/atender', { mesa: Number(b.mesa) });
      }
    } catch (e) {
      return json({ ok: false, error: 'Error del servidor' }, 500);
    }
    return json({ error: 'No encontrado' }, 404);
  }
};

/* ---------- Durable Object: estado compartido de la barra ---------- */
export class Barra {
  constructor(state) { this.state = state; }

  async llamados() {
    const todos = (await this.state.storage.get('llamados')) || {};
    const ahora = Date.now(); let cambio = false;
    for (const m of Object.keys(todos)) if (ahora - todos[m].desde > CALL_MS) { delete todos[m]; cambio = true; }
    if (cambio) await this.state.storage.put('llamados', todos);
    return todos;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const b = request.method === 'POST' ? await bodyOf(request) : {};
    const ahora = Date.now();

    if (url.pathname === '/llamar') {
      const todos = await this.llamados();
      const cur = todos[b.mesa];
      if (!cur) todos[b.mesa] = { desde: ahora, veces: 1 };
      else cur.veces += 1;                                  // ya estaba activo: solo se cuenta el insistir
      await this.state.storage.put('llamados', todos);
      return json({ ok: true, activo: true, desde: todos[b.mesa].desde, ahora });
    }
    if (url.pathname === '/estado') {
      const todos = await this.llamados(); const c = todos[url.searchParams.get('mesa')];
      return json({ ok: true, activo: !!c, desde: c ? c.desde : null, ahora });
    }
    if (url.pathname === '/lista') {
      const todos = await this.llamados();
      const lista = Object.entries(todos).map(([mesa, c]) => ({ mesa: Number(mesa), desde: c.desde, veces: c.veces })).sort((x, y) => x.desde - y.desde);
      return json({ ok: true, ahora, llamados: lista });
    }
    if (url.pathname === '/atender') {
      const todos = await this.llamados();
      delete todos[b.mesa];
      await this.state.storage.put('llamados', todos);
      return json({ ok: true });
    }

    // intentos fallidos de inicio de sesión, por IP
    const key = 'fallos:' + b.ip;
    if (url.pathname === '/login-estado') {
      const f = await this.state.storage.get(key);
      return json({ bloqueado: !!f && f.n >= LOGIN_MAX_FAILS && ahora - f.desde < LOGIN_WINDOW_MS });
    }
    if (url.pathname === '/login-fallo') {
      let f = await this.state.storage.get(key);
      if (!f || ahora - f.desde >= LOGIN_WINDOW_MS) f = { n: 0, desde: ahora };
      f.n += 1; await this.state.storage.put(key, f);
      return json({ ok: true });
    }
    if (url.pathname === '/login-ok') { await this.state.storage.delete(key); return json({ ok: true }); }

    return json({ error: 'No encontrado' }, 404);
  }
}
