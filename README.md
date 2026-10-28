# MojoBasket

Menú semanal, recetas y lista de la compra con precios reales de los supermercados de Canarias. Producción: https://mojobasket.es (proyecto Vercel `quecompro-precios`).

## Estructura
- `index.html` — webapp (HTML + JS sin dependencias). Detecta si corre dentro de Claude (`window.claude`) o en la web (`STANDALONE`).
- `api/` — funciones de Vercel (Node 22):
  - `claude.js` — proxy a Claude: Anthropic con `ANTHROPIC_API_KEY` o Vercel AI Gateway con OIDC.
  - `buscar`, `precios`, `ofertas`, `comparar`, `categorias` — catálogo de Mercadona, SPAR Gran Canaria y HiperDino.
  - `lidl` (Lidl Plus por tienda), `folletos` (folleto Lidl), `nutricion` (Open Food Facts), `salud` (diagnóstico), `cron` (recolector diario a Vercel Blob).
- `lib/` — adaptadores por cadena, almacenamiento (Blob) y utilidades.
- `vercel.json` — duración de funciones, crons y cabeceras.

## Variables de entorno (Vercel)
| Variable | Uso |
|---|---|
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob (catálogos, histórico, métricas) |
| `CRON_SECRET` | Protege `/api/cron` |
| `ANTHROPIC_API_KEY` | Opcional: Claude directo (si no, AI Gateway) |
| `CLAUDE_LIMITE_HORA` | Peticiones a Claude por IP y hora (por defecto 30) |
| `CUENTAS_SECRET` | Cuentas: firma de sesiones y cifrado (≥16 caracteres) |
| `RESEND_API_KEY` / `EMAIL_FROM` | Envío del enlace de acceso (Resend, dominio mojobasket.es) |
| `SUPERADMIN_EMAILS` | Emails (separados por comas) con plan Pro y acceso a `/admin` |
| `PRECIO_{SONNET,HAIKU,OPUS}_{IN,OUT}` | Opcional: USD por millón de tokens para el coste estimado del panel |

## Panel SuperAdmin (`/admin`)
Acceso solo con sesión de un email de `SUPERADMIN_EMAILS` (comprobado en el servidor, `lib/admin.js`, servido por `api/app.js` → `/api/admin`).
- **Resumen**: usuarios, activos y nuevos 7 días, Pro, suspendidos, listas generadas 14 días, Claude hoy (llamadas, tope, coste estimado).
- **Usuarios**: búsqueda y filtros, CSV, crear cuenta (Gratis/Pro, con envío del enlace), ficha con plan, reinicio de cuota, cerrar sesiones, suspender/reactivar (con motivo), nota interna, historial y vista de listas (solo lectura), exportación RGPD y borrado con confirmación por email.
- **Uso y costes**: llamadas y coste estimado de Claude por día y modelo (30 días) e indicadores por supermercado.
- **Catálogos**: frescura del recolector por cadena, histórico, forzar recolección y diagnóstico en vivo (`/api/salud`).
- **Sistema**: despliegue, variables presentes (nunca sus valores), límites, avisos de configuración, email de prueba, tamaño de Blob por carpeta y limpieza de datos antiguos.
- **Auditoría**: toda acción del panel queda registrada cifrada en `admin/audit/`.
Las acciones POST exigen origen propio y la cabecera `x-mb-admin: 1`. Los SuperAdmin no se pueden suspender ni borrar desde el panel.

## Desarrollo
`npm i` y `vercel dev`. Cada push a `main` despliega en producción.

## Despliegue
Push a `main` → Vercel publica en producción (mojobasket.es). Otras ramas → preview.
Límite Hobby: 12 funciones en `api/` (hoy 12). `/api/evento`, `/api/informe`, `/api/cuenta` y `/api/admin` se sirven desde `api/app.js` vía rewrite.
Tests: `npm test`.
