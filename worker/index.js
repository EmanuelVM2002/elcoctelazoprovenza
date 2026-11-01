// Coctelazo & Perritos Gourmet — servidor (Cloudflare Worker + Durable Object).
// Atiende SOLO /api/*; el resto de la página son archivos estáticos (ver wrangler.jsonc).
//
// Qué hace:
//  · Valida la llave del QR de cada mesa (HMAC): la mesa NO se puede inventar escribiendo un número.
//  · Guarda los llamados al mesero (uno por mesa, activo hasta que la barra lo atiende).
//  · Una sola sesión por mesa: el primer dispositivo que escanea el QR queda como dueño de la mesa (cada celular manda
//    un identificador propio). Un segundo dispositivo es rechazado (409) hasta que el dueño deje de dar señales
//    (SESION_MS) o la barra libere la mesa; el dispositivo liberado queda bloqueado hasta que vuelva a escanear el QR.
//  · Inicia sesión del personal de la barra. Usuario y contraseña viven SOLO como secretos del Worker
//    (nunca en la página ni en el repositorio).
//
// Secretos (Cloudflare → Worker → Variables y secretos, tipo «Secreto»):
//   ADMIN_USER      usuario de la barra
//   ADMIN_PASS      contraseña de la barra
//   SESSION_SECRET  texto largo al azar (firma las sesiones de la barra)
//   QR_SECRET       texto largo al azar (firma los QR de las mesas)
//
// POR AHORA los 4 valores van de EJEMPLO aquí abajo, para que funcione sin configurar nada en Cloudflare.
// Más adelante se guardan como secretos en Cloudflare (tienen prioridad sobre estos) y se borran de este archivo.
// OJO: mientras estén aquí, cualquiera que vea el repositorio los conoce. Los QR ya impresos solo valen con este QR_SECRET:
// al pasarlo a secreto, usa el MISMO valor para no tener que reimprimirlos.
const EJEMPLO = {
  ADMIN_USER: 'BarraProvenza',
  ADMIN_PASS: 'Provenza2026*',
  SESSION_SECRET: '9LT3VSxxfIAFxJjnCY0u6mLO_v9nzc0iK59i5ya_-Rc',
  QR_SECRET: 'XPeJTGh4fyrGqQ6Rb_7nwFz8LVvsdhkE7eKFXGrenlU'
};
const conf = env => ({
  ADMIN_USER: env.ADMIN_USER || EJEMPLO.ADMIN_USER,
  ADMIN_PASS: env.ADMIN_PASS || EJEMPLO.ADMIN_PASS,
  SESSION_SECRET: env.SESSION_SECRET || EJEMPLO.SESSION_SECRET,
  QR_SECRET: env.QR_SECRET || EJEMPLO.QR_SECRET
});

const enc = new TextEncoder();
const MAX_MESA = 99;
const SESSION_MS = 12 * 60 * 60 * 1000;      // la sesión de la barra dura 12 h
const CALL_MS = 3 * 60 * 60 * 1000;          // un llamado olvidado se limpia solo a las 3 h
const LOGIN_MAX_FAILS = 5, LOGIN_WINDOW_MS = 10 * 60 * 1000;
const SESION_MS = 30 * 60 * 1000;            // el dispositivo de una mesa sigue siendo el dueño mientras dé señales (cada ~6 s con la página abierta)
const EXPULSADO_MS = 12 * 60 * 60 * 1000;    // un dispositivo liberado por la barra queda bloqueado para esa mesa hasta que escanee otra vez
const DEV_RE = /^[A-Za-z0-9_-]{8,64}$/;
const devOk = d => typeof d === 'string' && DEV_RE.test(d);

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
    const cfg = conf(env);
    const to = (route, data) => barra.fetch(new Request('http://barra' + route, { method: 'POST', body: JSON.stringify(data || {}) }));

    try {
      // La mesa del QR es válida y este dispositivo pasa a ser su dueño (la página lo consulta al escanear)
      if (path === '/api/mesa' && request.method === 'GET') {
        const n = await mesaValida(cfg, url.searchParams.get('m'), url.searchParams.get('k'));
        if (!n) return json({ ok: false }, 403);
        const d = url.searchParams.get('d');
        if (!devOk(d)) return json({ ok: false, error: 'Falta el dispositivo' }, 400);
        const r = await (await to('/reclamar', { mesa: n, d })).json();
        return r.estado === 'ok' ? json({ ok: true, mesa: n }) : json({ ok: false, ocupada: true }, 409);
      }

      // Cliente: estado de su llamado (también es la señal de vida del dispositivo dueño de la mesa)
      if (path === '/api/llamar' && request.method === 'GET') {
        const n = await mesaValida(cfg, url.searchParams.get('m'), url.searchParams.get('k'));
        if (!n) return json({ ok: false }, 403);
        const d = url.searchParams.get('d');
        if (!devOk(d)) return json({ ok: false, error: 'Falta el dispositivo' }, 400);
        return barra.fetch(new Request('http://barra/estado?mesa=' + n + '&d=' + d));
      }

      // Cliente: llama al mesero (solo el dispositivo dueño de la mesa)
      if (path === '/api/llamar' && request.method === 'POST') {
        const b = await bodyOf(request);
        const n = await mesaValida(cfg, b.m, b.k);
        if (!n) return json({ ok: false }, 403);
        if (!devOk(b.d)) return json({ ok: false, error: 'Falta el dispositivo' }, 400);
        return to('/llamar', { mesa: n, d: b.d });
      }

      // Barra: iniciar sesión
      if (path === '/api/login' && request.method === 'POST') {
                const ip = request.headers.get('CF-Connecting-IP') || 'local';
        const bloqueo = await (await to('/login-estado', { ip })).json();
        if (bloqueo.bloqueado) return json({ ok: false, error: 'Demasiados intentos. Espera unos minutos.' }, 429);
        const b = await bodyOf(request);
        // se comparan SIEMPRE ambos campos, para no revelar cuál falló
        const okU = await safeEqual(b.usuario ?? '', cfg.ADMIN_USER);
        const okP = await safeEqual(b.clave ?? '', cfg.ADMIN_PASS);
        if (!(okU && okP)) {
          await to('/login-fallo', { ip });
          return json({ ok: false, error: 'Usuario o contraseña incorrectos' }, 401);
        }
        await to('/login-ok', { ip });
        const exp = Date.now() + SESSION_MS;
        return json({ ok: true, token: await sessionToken(cfg, exp), exp });
      }

      // Barra (con sesión): ver y atender llamados
      if (path === '/api/llamados' && request.method === 'GET') {
        if (!(await sessionOk(cfg, request))) return json({ ok: false }, 401);
        return barra.fetch(new Request('http://barra/lista'));
      }
      if (path === '/api/atender' && request.method === 'POST') {
        if (!(await sessionOk(cfg, request))) return json({ ok: false }, 401);
        const b = await bodyOf(request);
        return to('/atender', { mesa: Number(b.mesa) });
      }
      // Barra (con sesión): liberar una mesa, o sea tumbar el dispositivo que la tiene asignada
      if (path === '/api/liberar' && request.method === 'POST') {
        if (!(await sessionOk(cfg, request))) return json({ ok: false }, 401);
        const b = await bodyOf(request);
        return to('/liberar', { mesa: Number(b.mesa) });
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

  // Sesiones de mesa: { [mesa]: { d: dispositivo, desde, visto } }. Una sin señales por SESION_MS se da por abandonada.
  async sesiones() {
    const s = (await this.state.storage.get('sesiones')) || {};
    const ahora = Date.now(); let cambio = false;
    for (const m of Object.keys(s)) if (ahora - s[m].visto > SESION_MS) { delete s[m]; cambio = true; }
    if (cambio) await this.state.storage.put('sesiones', s);
    return s;
  }
  async expulsados() {
    const e = (await this.state.storage.get('expulsados')) || {};
    const ahora = Date.now(); let cambio = false;
    for (const k of Object.keys(e)) if (ahora - e[k] > EXPULSADO_MS) { delete e[k]; cambio = true; }
    if (cambio) await this.state.storage.put('expulsados', e);
    return e;
  }
  // 'ok' = este dispositivo es (o pasa a ser) el dueño · 'otro' = la mesa la tiene otro dispositivo · 'expulsado' = la barra lo liberó.
  // explicito = el cliente escaneó el QR a propósito: levanta un bloqueo anterior. Las señales automáticas no lo levantan.
  async tomar(mesa, d, explicito) {
    const ses = await this.sesiones(), exp = await this.expulsados();
    const key = mesa + ':' + d, ahora = Date.now();
    if (exp[key]) {
      if (!explicito) return 'expulsado';
      delete exp[key]; await this.state.storage.put('expulsados', exp);
    }
    const cur = ses[mesa];
    if (cur && cur.d !== d) return 'otro';
    ses[mesa] = { d, desde: cur ? cur.desde : ahora, visto: ahora };
    await this.state.storage.put('sesiones', ses);
    return 'ok';
  }

  async fetch(request) {
    const url = new URL(request.url);
    const b = request.method === 'POST' ? await bodyOf(request) : {};
    const ahora = Date.now();

    if (url.pathname === '/reclamar') {
      const estado = await this.tomar(b.mesa, b.d, true);
      return json({ ok: estado === 'ok', estado });
    }
    if (url.pathname === '/liberar') {
      const ses = await this.sesiones(), exp = await this.expulsados();
      const cur = ses[b.mesa];
      if (cur) { exp[b.mesa + ':' + cur.d] = ahora; delete ses[b.mesa]; await this.state.storage.put('sesiones', ses); await this.state.storage.put('expulsados', exp); }
      const todos = await this.llamados(); delete todos[b.mesa]; await this.state.storage.put('llamados', todos);   // la mesa queda limpia para quien llegue
      return json({ ok: true, liberada: !!cur });
    }

    if (url.pathname === '/llamar') {
      const estado = await this.tomar(b.mesa, b.d, false);
      if (estado !== 'ok') return json({ ok: false, sesion: estado }, 409);
      const todos = await this.llamados();
      const cur = todos[b.mesa];
      if (!cur) todos[b.mesa] = { desde: ahora, veces: 1 };
      else cur.veces += 1;                                  // ya estaba activo: solo se cuenta el insistir
      await this.state.storage.put('llamados', todos);
      return json({ ok: true, activo: true, desde: todos[b.mesa].desde, ahora });
    }
    if (url.pathname === '/estado') {
      const estado = await this.tomar(url.searchParams.get('mesa'), url.searchParams.get('d'), false);   // también es la señal de vida
      if (estado !== 'ok') return json({ ok: false, sesion: estado }, 409);
      const todos = await this.llamados(); const c = todos[url.searchParams.get('mesa')];
      return json({ ok: true, sesion: 'ok', activo: !!c, desde: c ? c.desde : null, ahora });
    }
    if (url.pathname === '/lista') {
      const todos = await this.llamados(), ses = await this.sesiones();
      const lista = Object.entries(todos).map(([mesa, c]) => ({ mesa: Number(mesa), desde: c.desde, veces: c.veces })).sort((x, y) => x.desde - y.desde);
      const mesas = Object.entries(ses).map(([mesa, s]) => ({ mesa: Number(mesa), desde: s.desde, visto: s.visto })).sort((x, y) => x.mesa - y.mesa);   // nunca se envía el identificador del dispositivo
      return json({ ok: true, ahora, llamados: lista, mesas });
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
