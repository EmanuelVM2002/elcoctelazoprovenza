# Cómo publicar Coctelazo & Perritos Gourmet (Cloudflare)

La página es estática, pero el **llamado al mesero**, el **acceso de la barra** y la **validación de los QR** necesitan el Worker (`worker/index.js`). Un solo Worker publica las dos cosas (`wrangler.jsonc`).

## 1. Conectar el repositorio
Cloudflare → *Workers y Pages* → *Crear* → *Importar un repositorio* → `EmanuelVM2002/elcoctelazoprovenza` (rama `main`).
El nombre del Worker debe ser `elcoctelazoprovenza` (es el que dice `wrangler.jsonc`). Cada `git push` a `main` vuelve a publicar solo.
No hay que crear ninguna base de datos: el estado de la barra vive en un Durable Object que crea la migración del primer despliegue.

## 2. Guardar los 4 secretos (tipo **Secreto**, nunca en el repositorio)
*Worker → Configuración → Variables y secretos → Agregar*

| Nombre | Qué es |
|---|---|
| `ADMIN_USER` | usuario de la barra |
| `ADMIN_PASS` | contraseña de la barra |
| `SESSION_SECRET` | texto largo al azar (firma las sesiones de la barra) |
| `QR_SECRET` | texto largo al azar (firma los QR de las mesas) |

Sin estos secretos nadie puede entrar a la barra y ningún QR es válido (falla cerrado).
Los valores reales están en `qr-mesas/SECRETOS-CLOUDFLARE.txt` (carpeta local, excluida de git).

## 3. Los QR
Cada QR lleva `…/?m=3&k=LLAVE`. La llave es un HMAC de `QR_SECRET` + el número de mesa: **no se puede adivinar ni escribir un número de mesa**. Si cambias `QR_SECRET` hay que regenerar e imprimir los QR otra vez. Para más mesas se generan nuevos QR con el mismo `QR_SECRET` (no hay que tocar el código).

## 4. Probar en local
```
node --test test/api.test.mjs     # 11 pruebas del servidor
node test/dev-server.mjs          # http://localhost:8851 (imprime enlaces de mesa de prueba)
```
Los secretos locales salen de `.dev.vars` (copiar de `.dev.vars.example`); si no existe usa valores de prueba.
