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

## Desarrollo
`npm i` y `vercel dev`. Cada push a `main` despliega en producción.

## Despliegue
Push a `main` → Vercel publica en producción (mojobasket.es). Otras ramas → preview.
Límite Hobby: 12 funciones en `api/` (hoy 12). `/api/informe` se sirve desde `api/evento.js` vía rewrite.
Tests: `npm test`.
