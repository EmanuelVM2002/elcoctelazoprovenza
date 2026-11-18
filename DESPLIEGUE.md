# Cómo publicar Coctelazo & Perritos Gourmet (Cloudflare)

La página es estática, pero el **llamado al mesero**, el **acceso de la barra** y la **validación de los QR** necesitan el Worker (`worker/index.js`). Un solo Worker publica las dos cosas (`wrangler.jsonc`).

## 1. Conectar el repositorio
Cloudflare → *Workers y Pages* → *Crear* → *Importar un repositorio* → `EmanuelVM2002/elcoctelazoprovenza` (rama `main`).
El nombre del Worker debe ser `elcoctelazoprovenza` (es el que dice `wrangler.jsonc`). Cada `git push` a `main` vuelve a publicar solo.
No hay que crear ninguna base de datos: el estado de la barra vive en un Durable Object que crea la migración del primer despliegue.

## 2. Secretos (OBLIGATORIOS)
El Worker **no trae ningún valor de respaldo en el código**: los 4 secretos se cargan en Cloudflare **antes** de publicar la versión sin valores de ejemplo. Si falta alguno, las mesas se rechazan (403) y el inicio de sesión de la barra responde 503.

*Worker → Configuración → Variables y secretos → Agregar* (tipo **Secreto**), y luego **Implementar**:

| Nombre | Qué es |
|---|---|
| `ADMIN_USER` | usuario de la barra |
| `ADMIN_PASS` | contraseña de la barra |
| `SESSION_SECRET` | texto largo al azar (firma las sesiones de la barra) |
| `QR_SECRET` | texto largo al azar (firma los QR de las mesas) |

Los valores vigentes (generados el 16/11/2026) están en `qr-mesas/SECRETOS-NUEVOS-CLOUDFLARE.txt` (carpeta local, excluida de git). Los anteriores estuvieron en un repositorio público: **no sirven y no deben volver a usarse**. Cambiar `QR_SECRET` obliga a reimprimir los QR.

## 3. Los QR
Cada QR lleva `https://elcoctelazoprovenza.com/?m=3&k=LLAVE`. La llave es un HMAC de `QR_SECRET` + el número de mesa: **no se puede adivinar ni escribir un número de mesa**. Para generarlos (hace falta internet para cargar la librería de QR):
```
node qr-mesas/generar-qr.mjs      # abre http://localhost:8863 → botón «Generar y guardar» → PNG en qr-mesas/nuevos/
```
Variables opcionales: `DOMINIO` (por defecto https://elcoctelazoprovenza.com) y `MESAS` (por defecto 15). La llave de cada mesa la calcula el servidor con el mismo código del Worker. **No imprimir hasta que el dominio esté asignado al Worker y un celular real lea un QR de prueba.**

## 4. Probar en local
```
node --test test/api.test.mjs     # 16 pruebas del servidor
node test/dev-server.mjs          # http://localhost:8851 (imprime enlaces de mesa de prueba)
```
Los secretos locales salen de `.dev.vars` (copiar de `.dev.vars.example`); si no existe, el servidor local usa valores de prueba propios (nunca los de producción).

## 5. Cabeceras de seguridad
El archivo `_headers` las pone en toda la página (nosniff, X-Frame-Options, Referrer-Policy, Permissions-Policy con cámara y ubicación solo del propio sitio, y una CSP mínima). Para comprobarlas: `curl -I https://elcoctelazoprovenza.com`.
