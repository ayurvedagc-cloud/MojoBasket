// Función única para /api/evento, /api/informe, /api/cuenta y /api/admin (rewrites en vercel.json → ?r=…).
// Unificadas para no pasar de 12 funciones (límite Hobby).
// POST /api/evento  {tipo:"lista"|"clic"|"copiar"|"claude_chrome", ...} → 204
// Métricas anónimas de la web (sendBeacon). Solo acepta peticiones de los orígenes de MojoBasket.
import { waitUntil } from "@vercel/functions";
import { limpia, registra } from "../lib/metricas.js";
import { informe } from "../lib/informe.js";
import { cuenta } from "../lib/cuentaApi.js";
import { admin } from "../lib/admin.js";

const ORIGENES = /^https:\/\/(www\.)?mojobasket\.es$|^https:\/\/quecompro-precios(-[a-z0-9-]+)?-admin3198s-projects\.vercel\.app$|^https:\/\/quecompro-precios\.vercel\.app$|^http:\/\/localhost(:\d+)?$/;

export default async function handler(req, res) {
  const r = req.query?.r || "evento";
  if (r === "cuenta") return cuenta(req, res);
  if (r === "admin") return admin(req, res);
  if (r === "informe" || req.method === "GET") return informe(req, res);
  if (req.method !== "POST") return res.status(405).end();
  const origin = req.headers.origin || "";
  if (origin && !ORIGENES.test(origin)) return res.status(403).end();
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = null; } }
  if (Buffer.isBuffer?.(b)) { try { b = JSON.parse(b.toString("utf8")); } catch { b = null; } }
  const ev = limpia(b);
  if (!ev) return res.status(400).end();
  waitUntil(registra(ev).catch((e) => console.error("evento", e?.message || e))); // volcado en lote, diferido
  res.setHeader("cache-control", "no-store");
  return res.status(204).end();
}
