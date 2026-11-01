// node --test test/api.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, worker, mesaToken } from './fake-do.mjs';

// Dispositivos de prueba. Si una llamada de cliente no dice cuál es, se asume el primero (D1).
const D1 = 'dispositivo-uno-1', D2 = 'dispositivo-dos-2';
const call = (env, method, path, body, headers = {}) => {
  if (/^\/api\/(mesa|llamar)\?/.test(path) && !/[?&]d=/.test(path)) path += '&d=' + D1;
  if (method === 'POST' && path === '/api/llamar' && body && body.d === undefined) body = { ...body, d: D1 };
  return worker.fetch(new Request('http://sitio' + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }), env);
};
const login = async env => (await (await call(env, 'POST', '/api/login', { usuario: 'BarraProvenza', clave: 'clave-de-prueba-local' })).json());

test('la mesa solo es válida con la llave de su QR', async () => {
  const env = makeEnv();
  const k3 = await mesaToken(env.QR_SECRET, 3);
  assert.equal(k3.length, 16);
  assert.equal((await call(env, 'GET', `/api/mesa?m=3&k=${k3}`)).status, 200);
  assert.equal((await call(env, 'GET', `/api/mesa?m=3&k=`)).status, 403, 'sin llave');
  assert.equal((await call(env, 'GET', `/api/mesa?m=3&k=0000000000000000`)).status, 403, 'llave inventada');
  assert.equal((await call(env, 'GET', `/api/mesa?m=2&k=${k3}`)).status, 403, 'llave de otra mesa');
  assert.equal((await call(env, 'GET', `/api/mesa?m=abc&k=${k3}`)).status, 403);
  assert.equal((await call(env, 'GET', `/api/mesa?m=0&k=${await mesaToken(env.QR_SECRET, 0)}`)).status, 403, 'mesa fuera de rango');
});

test('sin secretos en Cloudflare se usan los de ejemplo del código (los QR impresos siguen valiendo)', async () => {
  const env = makeEnv({ QR_SECRET: undefined, ADMIN_USER: undefined, ADMIN_PASS: undefined, SESSION_SECRET: undefined });
  // llaves de los QR ya impresos (mesa 1, 2 y 3)
  assert.equal((await call(env, 'GET', '/api/mesa?m=1&k=3gaSZmjwJEAqQbbg')).status, 200);
  assert.equal((await call(env, 'GET', '/api/mesa?m=2&k=EFXXu7TDAjE_RvvE')).status, 200);
  assert.equal((await call(env, 'GET', '/api/mesa?m=3&k=wFHLhA75lDIvGQHM')).status, 200);
  assert.equal((await call(env, 'GET', '/api/mesa?m=3&k=3gaSZmjwJEAqQbbg')).status, 403);
  assert.equal((await call(env, 'GET', '/api/mesa?m=1&k=abc')).status, 403);
  const ok = await call(env, 'POST', '/api/login', { usuario: 'BarraProvenza', clave: 'Provenza2026*' });
  assert.equal(ok.status, 200);
  assert.equal((await call(env, 'POST', '/api/login', { usuario: 'BarraProvenza', clave: 'otra' })).status, 401);
});

test('un secreto de Cloudflare tiene prioridad sobre el ejemplo del código', async () => {
  const env = makeEnv({ ADMIN_PASS: 'nueva-clave' });
  assert.equal((await call(env, 'POST', '/api/login', { usuario: 'BarraProvenza', clave: 'nueva-clave' })).status, 200);
  assert.equal((await call(env, 'POST', '/api/login', { usuario: 'BarraProvenza', clave: 'clave-de-prueba-local' })).status, 401);
});

test('llamar al mesero: activo, se ve en la barra, se atiende y se puede volver a llamar', async () => {
  const env = makeEnv();
  const k2 = await mesaToken(env.QR_SECRET, 2), k5 = await mesaToken(env.QR_SECRET, 5);
  let st = await (await call(env, 'GET', `/api/llamar?m=2&k=${k2}`)).json();
  assert.equal(st.activo, false);

  assert.equal((await call(env, 'POST', '/api/llamar', { m: 2, k: k2 })).status, 200);
  assert.equal((await call(env, 'POST', '/api/llamar', { m: 5, k: k5 })).status, 200);
  assert.equal((await call(env, 'POST', '/api/llamar', { m: 2, k: k2 })).status, 200, 'insistir no duplica');
  assert.equal((await call(env, 'POST', '/api/llamar', { m: 2, k: 'falsa' })).status, 403);

  st = await (await call(env, 'GET', `/api/llamar?m=2&k=${k2}`)).json();
  assert.equal(st.activo, true);

  const { token } = await login(env);
  const h = { Authorization: 'Bearer ' + token };
  let lista = await (await call(env, 'GET', '/api/llamados', null, h)).json();
  assert.deepEqual(lista.llamados.map(l => l.mesa), [2, 5], 'orden de llegada');
  assert.equal(lista.llamados[0].veces, 2);

  assert.equal((await call(env, 'POST', '/api/atender', { mesa: 2 }, h)).status, 200);
  lista = await (await call(env, 'GET', '/api/llamados', null, h)).json();
  assert.deepEqual(lista.llamados.map(l => l.mesa), [5]);
  st = await (await call(env, 'GET', `/api/llamar?m=2&k=${k2}`)).json();
  assert.equal(st.activo, false, 'el cliente ve que ya lo atendieron');

  await call(env, 'POST', '/api/llamar', { m: 2, k: k2 });
  st = await (await call(env, 'GET', `/api/llamar?m=2&k=${k2}`)).json();
  assert.equal(st.activo, true, 'puede volver a llamar');
});

test('la barra exige sesión', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'GET', '/api/llamados')).status, 401);
  assert.equal((await call(env, 'POST', '/api/atender', { mesa: 1 })).status, 401);
  assert.equal((await call(env, 'GET', '/api/llamados', null, { Authorization: 'Bearer 9999999999999.firma-falsa' })).status, 401);
  const { token } = await login(env);
  const [exp] = token.split('.');
  assert.equal((await call(env, 'GET', '/api/llamados', null, { Authorization: `Bearer ${Number(exp) + 1}.${token.split('.')[1]}` })).status, 401, 'no se puede alargar la sesión');
  assert.equal((await call(env, 'GET', '/api/llamados', null, { Authorization: 'Bearer ' + token })).status, 200);
});

test('una sesión vencida no sirve', async () => {
  const env = makeEnv();
  const { token } = await login(env);
  const real = Date.now; Date.now = () => real() + 13 * 3600 * 1000;
  try { assert.equal((await call(env, 'GET', '/api/llamados', null, { Authorization: 'Bearer ' + token })).status, 401); }
  finally { Date.now = real; }
});

test('login: credenciales incorrectas y bloqueo tras 5 fallos', async () => {
  const env = makeEnv();
  for (let i = 0; i < 5; i++) {
    const r = await call(env, 'POST', '/api/login', { usuario: 'BarraProvenza', clave: 'mala' });
    assert.equal(r.status, 401);
  }
  const bloqueado = await call(env, 'POST', '/api/login', { usuario: 'BarraProvenza', clave: 'clave-de-prueba-local' });
  assert.equal(bloqueado.status, 429, 'ni la clave buena entra mientras está bloqueado');
});

test('login: un éxito borra los fallos; el usuario también se valida', async () => {
  const env = makeEnv();
  for (let i = 0; i < 3; i++) await call(env, 'POST', '/api/login', { usuario: 'BarraProvenza', clave: 'mala' });
  assert.equal((await call(env, 'POST', '/api/login', { usuario: 'otro', clave: 'clave-de-prueba-local' })).status, 401);
  assert.equal((await call(env, 'POST', '/api/login', { usuario: 'BarraProvenza', clave: 'clave-de-prueba-local' })).status, 200);
});

test('login con clave vacía o ausente no entra', async () => {
  const env = makeEnv({ ADMIN_PASS: undefined });
  assert.equal((await call(env, 'POST', '/api/login', { usuario: 'BarraProvenza', clave: '' })).status, 401);
  assert.equal((await call(env, 'POST', '/api/login', { usuario: 'BarraProvenza' })).status, 401);
});

test('la respuesta del servidor nunca trae la contraseña ni los secretos', async () => {
  const env = makeEnv();
  const txt = await (await call(env, 'POST', '/api/login', { usuario: 'BarraProvenza', clave: 'clave-de-prueba-local' })).text();
  for (const s of [env.ADMIN_PASS, env.SESSION_SECRET, env.QR_SECRET]) assert.ok(!txt.includes(s));
});

test('un llamado olvidado se limpia solo a las 3 horas', async () => {
  const env = makeEnv();
  const k1 = await mesaToken(env.QR_SECRET, 1);
  await call(env, 'POST', '/api/llamar', { m: 1, k: k1 });
  const real = Date.now; Date.now = () => real() + 4 * 3600 * 1000;
  try {
    const st = await (await call(env, 'GET', `/api/llamar?m=1&k=${k1}`)).json();
    assert.equal(st.activo, false);
  } finally { Date.now = real; }
});

test('una sola sesión por mesa: el segundo dispositivo es rechazado', async () => {
  const env = makeEnv();
  const k4 = await mesaToken(env.QR_SECRET, 4), k6 = await mesaToken(env.QR_SECRET, 6);
  assert.equal((await call(env, 'GET', `/api/mesa?m=4&k=${k4}&d=${D1}`)).status, 200, 'el primero entra');
  assert.equal((await call(env, 'GET', `/api/mesa?m=4&k=${k4}&d=${D1}`)).status, 200, 'el mismo dispositivo puede volver a escanear');
  const r = await call(env, 'GET', `/api/mesa?m=4&k=${k4}&d=${D2}`);
  assert.equal(r.status, 409, 'el segundo no entra');
  assert.equal((await r.json()).ocupada, true);
  assert.equal((await call(env, 'GET', `/api/mesa?m=6&k=${k6}&d=${D2}`)).status, 200, 'otra mesa sí está libre');
  // el que no es dueño ni puede ver el estado ni llamar al mesero
  assert.equal((await call(env, 'GET', `/api/llamar?m=4&k=${k4}&d=${D2}`)).status, 409);
  assert.equal((await call(env, 'POST', '/api/llamar', { m: 4, k: k4, d: D2 })).status, 409);
  assert.equal((await call(env, 'GET', `/api/llamar?m=4&k=${k4}&d=${D1}`)).status, 200, 'el dueño sigue bien');
  // el identificador es obligatorio y debe tener forma válida
  assert.equal((await worker.fetch(new Request(`http://sitio/api/mesa?m=4&k=${k4}`), env)).status, 400);
  assert.equal((await worker.fetch(new Request(`http://sitio/api/mesa?m=4&k=${k4}&d=corto`), env)).status, 400);
});

test('la barra libera una mesa: el dispositivo cae y otro puede entrar', async () => {
  const env = makeEnv();
  const k2 = await mesaToken(env.QR_SECRET, 2);
  await call(env, 'GET', `/api/mesa?m=2&k=${k2}&d=${D1}`);
  await call(env, 'POST', '/api/llamar', { m: 2, k: k2, d: D1 });
  const { token } = await login(env);
  const h = { Authorization: 'Bearer ' + token };

  let lista = await (await call(env, 'GET', '/api/llamados', null, h)).json();
  assert.deepEqual(lista.mesas.map(m => m.mesa), [2], 'la barra ve la mesa con dispositivo');
  assert.ok(!JSON.stringify(lista).includes(D1), 'nunca se envía el identificador del dispositivo');

  assert.equal((await call(env, 'POST', '/api/liberar', { mesa: 2 })).status, 401, 'liberar exige sesión de la barra');
  const lib = await (await call(env, 'POST', '/api/liberar', { mesa: 2 }, h)).json();
  assert.equal(lib.liberada, true);
  lista = await (await call(env, 'GET', '/api/llamados', null, h)).json();
  assert.deepEqual(lista.mesas, [], 'la mesa queda libre');
  assert.deepEqual(lista.llamados, [], 'y sin llamados pendientes');

  const st = await call(env, 'GET', `/api/llamar?m=2&k=${k2}&d=${D1}`);
  assert.equal(st.status, 409, 'el dispositivo liberado se entera en su siguiente señal');
  assert.equal((await st.json()).sesion, 'expulsado');
  assert.equal((await call(env, 'POST', '/api/llamar', { m: 2, k: k2, d: D1 })).status, 409, 'y no puede llamar');

  assert.equal((await call(env, 'GET', `/api/mesa?m=2&k=${k2}&d=${D2}`)).status, 200, 'otro dispositivo entra');
  assert.equal((await call(env, 'GET', `/api/mesa?m=2&k=${k2}&d=${D1}`)).status, 409, 'el liberado ya no puede volver mientras D2 la tenga');
  await call(env, 'POST', '/api/liberar', { mesa: 2 }, h);
  assert.equal((await call(env, 'GET', `/api/mesa?m=2&k=${k2}&d=${D1}`)).status, 200, 'volviendo a escanear a propósito sí puede entrar');
  assert.equal((await (await call(env, 'POST', '/api/liberar', { mesa: 9 }, h)).json()).liberada, false, 'liberar una mesa vacía no falla');
});

test('si el dueño deja de dar señales, la mesa se libera sola', async () => {
  const env = makeEnv();
  const k5 = await mesaToken(env.QR_SECRET, 5);
  await call(env, 'GET', `/api/mesa?m=5&k=${k5}&d=${D1}`);
  const real = Date.now;
  Date.now = () => real() + 10 * 60 * 1000;
  try {
    await call(env, 'GET', `/api/llamar?m=5&k=${k5}&d=${D1}`);   // señal a los 10 min: renueva
    Date.now = () => real() + 35 * 60 * 1000;
    assert.equal((await call(env, 'GET', `/api/mesa?m=5&k=${k5}&d=${D2}`)).status, 409, 'a los 25 min de la última señal sigue ocupada');
    Date.now = () => real() + 45 * 60 * 1000;
    assert.equal((await call(env, 'GET', `/api/mesa?m=5&k=${k5}&d=${D2}`)).status, 200, 'a los 35 min sin señales queda libre');
    assert.equal((await call(env, 'GET', `/api/llamar?m=5&k=${k5}&d=${D1}`)).status, 409, 'y el dueño anterior ya no es el dueño');
  } finally { Date.now = real; }
});

test('rutas desconocidas dan 404', async () => {
  assert.equal((await call(makeEnv(), 'GET', '/api/nada')).status, 404);
});
