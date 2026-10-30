// POST /api/claude {prompt, images:[{media_type,data}], tier:"default"|"rapido"} → texto en streaming (text/plain)
// Proxy de la web pública mojobasket.es hacia Claude.
// Con ANTHROPIC_API_KEY → API de Anthropic. Sin ella → Vercel AI Gateway autenticado con el token OIDC del propio despliegue
// (sin claves; se factura en Vercel). GET /api/claude?diag=1 → estado; ?diag=2 → además una llamada mínima de prueba.
// tier "rapido" (elegir productos, estimar precios) usa Haiku; "default" (menú y recetas) usa Sonnet.
// Tope diario global de llamadas (CLAUDE_TOPE_DIA, por defecto 600) y uso por modelo en Blob (uso/AAAA-MM-DD.json).
import { waitUntil } from "@vercel/functions";
import { usoHoy, sumaUso } from "../lib/metricas.js";
// Tokens de entrada: el Gateway puede informarlos en message_start o en message_delta, e incluir caché.
const entrada = (u) => (u ? (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) : 0);
import { hayBlob } from "../lib/store.js";
import * as C from "../lib/cuenta.js";

const ORIGENES = /^https:\/\/(www\.)?mojobasket\.es$|^https:\/\/quecompro-precios(-[a-z0-9-]+)?-admin3198s-projects\.vercel\.app$|^https:\/\/quecompro-precios\.vercel\.app$|^http:\/\/localhost(:\d+)?$/;
const MAX_PROMPT = 80000, MAX_IMG = 6, MAX_IMG_B64 = 2_000_000;
const LIMITE_HORA = +process.env.CLAUDE_LIMITE_HORA || 30; // peticiones por IP y hora (por instancia)
const TOPE_DIA = +process.env.CLAUDE_TOPE_DIA || 600; // llamadas a Claude al día, todas las IP
const vistos = new Map();
const GW = "https://ai-gateway.vercel.sh";

/** Modelos del AI Gateway por nivel: AI_GATEWAY_MODEL(_RAPIDO) o el catálogo público, del más reciente al más antiguo. */
let catalogoGW = null;
const idxGW = { default: 0, rapido: 0 };
async function modelosGateway(tier) {
  const fijo = tier === "rapido" ? process.env.AI_GATEWAY_MODEL_RAPIDO : process.env.AI_GATEWAY_MODEL;
  if (fijo) return [fijo];
  if (!catalogoGW) {
    const ver = (id) => (id.match(/(\d+)(?:[.-](\d+))?/) || []).slice(1).map((n) => +n || 0);
    const orden = (a, b) => { const x = ver(a), y = ver(b); return (y[0] - x[0]) || (y[1] - x[1]); };
    try {
      const ids = ((await (await fetch(GW + "/v1/models")).json()).data || []).map((m) => m.id);
      const fam = (f) => ids.filter((id) => new RegExp("^anthropic/claude-" + f + "-\\d+([.-]\\d+)?$").test(id)).sort(orden);
      catalogoGW = { sonnet: fam("sonnet"), haiku: fam("haiku") };
    } catch {}
    if (!catalogoGW?.sonnet?.length) catalogoGW = { sonnet: ["anthropic/claude-sonnet-5.5"], haiku: ["anthropic/claude-haiku-5.5"] };
  }
  return tier === "rapido" ? [...catalogoGW.haiku, ...catalogoGW.sonnet] : [...catalogoGW.sonnet, ...catalogoGW.haiku];
}
const esPlanGratis = (st, msg) => st === 403 && /free tier|do not have access to this model/i.test(msg || "");

/** Destino según la configuración disponible y el nivel pedido. */
async function destino(req, tier = "default") {
  if (process.env.ANTHROPIC_API_KEY) {
    const model = tier === "rapido" ? process.env.ANTHROPIC_MODEL_RAPIDO || "claude-haiku-5-5" : process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
    return { via: "anthropic", tier, url: "https://api.anthropic.com/v1/messages", headers: { "x-api-key": process.env.ANTHROPIC_API_KEY }, model, cands: [model] };
  }
  const tok = process.env.AI_GATEWAY_API_KEY || req.headers["x-vercel-oidc-token"] || process.env.VERCEL_OIDC_TOKEN;
  if (!tok) return null;
  const cands = await modelosGateway(tier);
  return { via: "gateway", tier, url: GW + "/v1/messages", headers: { authorization: "Bearer " + tok }, model: cands[Math.min(idxGW[tier], cands.length - 1)], cands };
}

/** POST al destino; si un modelo no está disponible (plan o catálogo), prueba el siguiente candidato. */
async function llama(dst, cuerpo) {
  const go = (model) => fetch(dst.url, { method: "POST", headers: { ...dst.headers, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ ...cuerpo, model }) });
  const ini = dst.via === "gateway" ? Math.min(idxGW[dst.tier], dst.cands.length - 1) : 0;
  for (let i = ini; i < dst.cands.length; i++) {
    const r = await go(dst.cands[i]);
    const ultimo = i === dst.cands.length - 1;
    if (r.status === 403 && !ultimo) { const t = await r.clone().text(); let m = t; try { m = JSON.parse(t)?.error?.message || t; } catch {} if (esPlanGratis(403, m)) continue; }
    if (r.status === 404 && !ultimo) continue;
    if (r.ok && dst.via === "gateway") idxGW[dst.tier] = i;
    return { r, model: dst.cands[i] };
  }
}

function limita(ip) {
  const ahora = Date.now(), h = 3600_000;
  const arr = (vistos.get(ip) || []).filter((t) => ahora - t < h);
  if (arr.length >= LIMITE_HORA) return false;
  arr.push(ahora); vistos.set(ip, arr);
  if (vistos.size > 5000) for (const [k, v] of vistos) if (!v.some((t) => ahora - t < h)) vistos.delete(k);
  return true;
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  if (ORIGENES.test(origin)) { res.setHeader("access-control-allow-origin", origin); res.setHeader("vary", "origin"); }
  if (req.method === "OPTIONS") { res.setHeader("access-control-allow-methods", "POST"); res.setHeader("access-control-allow-headers", "content-type"); return res.status(204).end(); }
  if (req.method === "GET" && req.query?.diag) {
    const tier = req.query.tier === "rapido" ? "rapido" : "default";
    const d = await destino(req, tier);
    const out = { ok: !!d, via: d?.via || null, tier, model: d?.model || null, tope_dia: TOPE_DIA };
    if (hayBlob()) { const u = await usoHoy().catch(() => null); if (u) out.uso_hoy = u; }
    if (d && req.query.diag === "2" && limita("diag")) {
      const { r, model } = await llama(d, { max_tokens: 5, messages: [{ role: "user", content: "Di ok" }] });
      out.model = model; out.prueba = r.status; try { const j = await r.json(); out.respuesta = j?.content?.find?.((c) => c.type === "text")?.text || j?.error?.message || j?.error || null; } catch {}
    }
    return res.status(200).json(out);
  }
  if (req.method !== "POST") return res.status(405).json({ error: "solo POST" });
  if (origin && !ORIGENES.test(origin)) return res.status(403).json({ error: "origen no permitido" });
  const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const dst = await destino(req, b.tier === "rapido" ? "rapido" : "default");
  if (!dst) return res.status(503).json({ error: "Claude no está configurado en el servidor", code: "sin_clave" });
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "?";
  if (!limita(ip)) return res.status(429).json({ error: "Demasiadas peticiones. Espera un rato.", code: "rate_limited" });
  const uso = hayBlob() ? await usoHoy().catch(() => null) : null;
  if (uso && uso.llamadas >= TOPE_DIA) return res.status(429).json({ error: "MojoBasket ha llegado al límite de uso de hoy. Vuelve a intentarlo mañana.", code: "tope_dia" });

  const prompt = String(b.prompt || "");
  if (!prompt || prompt.length > MAX_PROMPT) return res.status(400).json({ error: "prompt vacío o demasiado largo" });
  const imgs = (Array.isArray(b.images) ? b.images : []).slice(0, MAX_IMG)
    .filter((i) => /^image\/(jpeg|png|webp|gif)$/.test(i?.media_type) && typeof i.data === "string" && i.data.length <= MAX_IMG_B64);

  // Cuota de la versión gratuita: cada lista empieza con una llamada "default" (menú), que consume 1 y emite un pase
  // firmado de 30 min para las llamadas "rapido" de esa misma lista. Si Claude falla al empezar, se devuelve.
  let cuota = null;
  if (C.activas()) {
    if (dst.tier === "default") {
      const q = await C.consumeLista(req).catch((e) => { console.error("cuota", e?.message || e); return { ok: true, estado: null }; });
      if (!q.ok) {
        const e = q.estado, cuenta = e.quien === "cuenta";
        return res.status(402).json({ code: "cuota", sesion: cuenta, cuota: C.publicoCuota(e),
          error: cuenta ? (e.limite === 1 ? "Ya has usado tu lista de esta semana." : `Has usado tus ${e.limite} listas de esta semana.`) + " Se renuevan el lunes."
            : (e.limite === 1 ? "Ya has usado tu lista de prueba de esta semana." : `Has usado tus ${e.limite} listas de prueba de esta semana.`) + " Entra con tu email para tener más gratis y guardar tu historial." });
      }
      cuota = q.estado;
      res.setHeader("x-mb-pase", C.firma({ t: "p", i: C.hashIp(ip) }, 30 * 60));
      if (cuota) res.setHeader("x-mb-cuota", encodeURIComponent(JSON.stringify(C.publicoCuota(cuota))));
    } else if ((() => { const p = C.verifica(String(b.pase || req.headers["x-mb-pase"] || ""), "p"); return !p || (p.i && p.i !== C.hashIp(ip)); })()) {
      return res.status(402).json({ code: "pase", error: "Empieza una lista nueva para continuar." });
    }
  }

  const content = [...imgs.map((i) => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.data } })), { type: "text", text: prompt }];
  const { r, model } = await llama(dst, { max_tokens: +process.env.ANTHROPIC_MAX_TOKENS || (dst.tier === "rapido" ? 12000 : 32000), stream: true, messages: [{ role: "user", content }] });
  if (!r.ok || !r.body) {
    let msg = ""; try { msg = (await r.json())?.error?.message || ""; } catch {}
    console.error(dst.via, model, r.status, msg);
    if (cuota) waitUntil(C.devuelveLista(cuota).catch(() => {}));
    return res.status(r.status === 429 ? 429 : 502).json({ error: r.status === 429 ? "Claude está saturado; inténtalo en un minuto." : "Error de Claude (" + r.status + (msg ? ": " + msg.slice(0, 160) : "") + ")", code: r.status === 429 ? "rate_limited" : "anthropic" });
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
  const rd = r.body.getReader(), dec = new TextDecoder();
  let buf = "", inTok = 0, outTok = 0, parada = null, fallo = false;
  try {
    for (;;) {
      const { done, value } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const ev = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = ev.split("\n").find((l) => l.startsWith("data:")); if (!line) continue;
        let d; try { d = JSON.parse(line.slice(5)); } catch { continue; }
        if (d.type === "content_block_delta" && d.delta?.type === "text_delta") res.write(d.delta.text);
        else if (d.type === "message_start") inTok = entrada(d.message?.usage) || inTok;
        else if (d.type === "message_delta") { outTok = d.usage?.output_tokens || outTok; inTok = entrada(d.usage) || inTok; parada = d.delta?.stop_reason || parada; }
        else if (d.type === "error") { fallo = true; res.write("\u0000ERR:" + (d.error?.message || "error")); }
      }
    }
  } catch (e) { fallo = true; res.write("\u0000ERR:" + String(e.message || e)); }
  // Respuesta cortada por longitud: el JSON quedaría incompleto. Se avisa y no cuenta para la cuota.
  if (parada === "max_tokens" && !fallo) { fallo = true; res.write("\u0000ERR:La respuesta de Claude salió demasiado larga y se cortó. Vuelve a intentarlo (no cuenta para tu límite semanal)."); }
  res.end();
  if (fallo && cuota) waitUntil(C.devuelveLista(cuota).catch(() => {}));
  console.log(JSON.stringify({ claude: dst.via, tier: dst.tier, model, in: inTok, out: outTok, stop: parada }));
  if (uso) waitUntil(sumaUso(uso, model, inTok, outTok));
}
