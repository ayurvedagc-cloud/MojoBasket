// Función única para /api/evento, /api/informe y /api/cuenta (rewrites en vercel.json → ?r=…).
// Unificadas para no pasar de 12 funciones (límite Hobby).
// POST /api/evento  {tipo:"lista"|"clic"|"copiar"|"claude_chrome", ...} → 204
// Métricas anónimas de la web (sendBeacon). Solo acepta peticiones de los orígenes de MojoBasket.
import { limpia, registra } from "../lib/metricas.js";
import { informe } from "../lib/informe.js";
import { cuenta } from "../lib/cuentaApi.js";

const ORIGENES = /^https:\/\/(www\.)?mojobasket\.es$|^https:\/\/quecompro-precios(-[a-z0-9-]+)?\.vercel\.app$|^http:\/\/localhost(:\d+)?$/;

export default async function handler(req, res) {
  const r = req.query?.r || "evento";
  if (r === "cuenta") return cuenta(req, res);
  if (r === "informe" || req.method === "GET") return informe(req, res);
  if (req.method !== "POST") return res.status(405).end();
  const origin = req.headers.origin || "";
  if (origin && !ORIGENES.test(origin)) return res.status(403).end();
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = null; } }
  if (Buffer.isBuffer?.(b)) { try { b = JSON.parse(b.toString("utf8")); } catch { b = null; } }
  const ev = limpia(b);
  if (!ev) return res.status(400).end();
  try { await registra(ev); } catch (e) { console.error("evento", e?.message || e); }
  res.setHeader("cache-control", "no-store");
  return res.status(204).end();
}
