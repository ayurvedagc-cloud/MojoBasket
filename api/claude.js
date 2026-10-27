// POST /api/claude {prompt, images:[{media_type,data}]} → texto en streaming (text/plain)
// Proxy de la web pública mojobasket.es hacia Claude.
// Con ANTHROPIC_API_KEY → API de Anthropic. Sin ella → Vercel AI Gateway autenticado con el token OIDC del propio despliegue
// (sin claves; se factura en Vercel). GET /api/claude?diag=1 → estado; ?diag=2 → además una llamada mínima de prueba.
const ORIGENES = /^https:\/\/(www\.)?mojobasket\.es$|^https:\/\/quecompro-precios(-[a-z0-9-]+)?\.vercel\.app$|^http:\/\/localhost(:\d+)?$/;
const MAX_PROMPT = 80000, MAX_IMG = 6, MAX_IMG_B64 = 2_000_000;
const LIMITE_HORA = +process.env.CLAUDE_LIMITE_HORA || 30; // peticiones por IP y hora (por instancia)
const vistos = new Map();
const GW = "https://ai-gateway.vercel.sh";
let modeloGW = null;

/** Modelos candidatos del AI Gateway: AI_GATEWAY_MODEL, o del catálogo público Sonnet → Haiku, del más reciente al más antiguo. */
let candidatosGW = null, idxGW = 0;
async function modelosGateway() {
  if (process.env.AI_GATEWAY_MODEL) return [process.env.AI_GATEWAY_MODEL];
  if (candidatosGW) return candidatosGW;
  const ver = (id) => (id.match(/(\d+)(?:[.-](\d+))?/) || []).slice(1).map((n) => +n || 0);
  const orden = (a, b) => { const x = ver(a), y = ver(b); return (y[0] - x[0]) || (y[1] - x[1]); };
  try {
    const ids = ((await (await fetch(GW + "/v1/models")).json()).data || []).map((m) => m.id);
    const fam = (f) => ids.filter((id) => new RegExp("^anthropic/claude-" + f + "-\\d+([.-]\\d+)?$").test(id)).sort(orden);
    candidatosGW = [...fam("sonnet"), ...fam("haiku")];
  } catch {}
  if (!candidatosGW?.length) candidatosGW = ["anthropic/claude-sonnet-5", "anthropic/claude-haiku-5"];
  return candidatosGW;
}
const esPlanGratis = (st, msg) => st === 403 && /free tier|do not have access to this model/i.test(msg || "");

/** POST al destino; en el Gateway, si el plan gratuito no da acceso al modelo, prueba el siguiente candidato. */
async function llama(dst, cuerpo) {
  const go = (model) => fetch(dst.url, { method: "POST", headers: { ...dst.headers, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ ...cuerpo, model }) });
  if (dst.via !== "gateway") return { r: await go(dst.model), model: dst.model };
  const cands = await modelosGateway();
  for (let i = idxGW; i < cands.length; i++) {
    const r = await go(cands[i]);
    if (r.status === 403) { const t = await r.clone().text(); let m = t; try { m = JSON.parse(t)?.error?.message || t; } catch {} if (esPlanGratis(403, m) && i < cands.length - 1) continue; }
    if (r.status === 404 && i < cands.length - 1) continue;
    if (r.ok) idxGW = i;
    return { r, model: cands[i] };
  }
}

/** Destino de la llamada según la configuración disponible. */
async function destino(req) {
  if (process.env.ANTHROPIC_API_KEY) return { via: "anthropic", url: "https://api.anthropic.com/v1/messages", headers: { "x-api-key": process.env.ANTHROPIC_API_KEY }, model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5" };
  const tok = process.env.AI_GATEWAY_API_KEY || req.headers["x-vercel-oidc-token"] || process.env.VERCEL_OIDC_TOKEN;
  if (!tok) return null;
  const c = await modelosGateway();
  return { via: "gateway", url: GW + "/v1/messages", headers: { authorization: "Bearer " + tok }, model: c[Math.min(idxGW, c.length - 1)] };
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
    const d = await destino(req);
    const out = { ok: !!d, via: d?.via || null, model: d?.model || null };
    if (d && req.query.diag === "2" && limita("diag")) {
      const { r, model } = await llama(d, { max_tokens: 5, messages: [{ role: "user", content: "Di ok" }] });
      out.model = model; out.prueba = r.status; try { const j = await r.json(); out.respuesta = j?.content?.[0]?.text || j?.error?.message || j?.error || null; } catch {}
    }
    return res.status(200).json(out);
  }
  if (req.method !== "POST") return res.status(405).json({ error: "solo POST" });
  if (origin && !ORIGENES.test(origin)) return res.status(403).json({ error: "origen no permitido" });
  const dst = await destino(req);
  if (!dst) return res.status(503).json({ error: "Claude no está configurado en el servidor", code: "sin_clave" });
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "?";
  if (!limita(ip)) return res.status(429).json({ error: "Demasiadas peticiones. Espera un rato.", code: "rate_limited" });

  const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const prompt = String(b.prompt || "");
  if (!prompt || prompt.length > MAX_PROMPT) return res.status(400).json({ error: "prompt vacío o demasiado largo" });
  const imgs = (Array.isArray(b.images) ? b.images : []).slice(0, MAX_IMG)
    .filter((i) => /^image\/(jpeg|png|webp|gif)$/.test(i?.media_type) && typeof i.data === "string" && i.data.length <= MAX_IMG_B64);

  const content = [...imgs.map((i) => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.data } })), { type: "text", text: prompt }];
  const { r } = await llama(dst, { max_tokens: +process.env.ANTHROPIC_MAX_TOKENS || 16000, stream: true, messages: [{ role: "user", content }] });
  if (!r.ok || !r.body) {
    let msg = ""; try { msg = (await r.json())?.error?.message || ""; } catch {}
    console.error(dst.via, r.status, msg);
    return res.status(r.status === 429 ? 429 : 502).json({ error: r.status === 429 ? "Claude está saturado; inténtalo en un minuto." : "Error de Claude (" + r.status + (msg ? ": " + msg.slice(0, 160) : "") + ")", code: r.status === 429 ? "rate_limited" : "anthropic" });
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
  const rd = r.body.getReader(), dec = new TextDecoder();
  let buf = "";
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
        else if (d.type === "error") res.write("\u0000ERR:" + (d.error?.message || "error"));
      }
    }
  } catch (e) { res.write("\u0000ERR:" + String(e.message || e)); }
  res.end();
}
