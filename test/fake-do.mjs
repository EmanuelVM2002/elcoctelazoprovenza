// Durable Object simulado en memoria: permite probar el Worker con Node, sin wrangler ni red.
import worker, { Barra, mesaToken } from '../worker/index.js';

export function makeEnv(extra = {}) {
  const store = new Map();
  const storage = {
    async get(k) { return store.has(k) ? structuredClone(store.get(k)) : undefined; },
    async put(k, v) { store.set(k, structuredClone(v)); },
    async delete(k) { store.delete(k); }
  };
  const obj = new Barra({ storage });
  return {
    ADMIN_USER: 'BarraProvenza', ADMIN_PASS: 'clave-de-prueba-local', SESSION_SECRET: 'sesion-de-prueba', QR_SECRET: 'qr-de-prueba',
    BARRA: { idFromName: n => n, get: () => ({ fetch: r => obj.fetch(r) }) },
    ...extra
  };
}

export { worker, mesaToken };
