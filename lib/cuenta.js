// Cuentas de MojoBasket: acceso por enlace mágico al email, sesión en cookie firmada, listas e historial en la nube,
// y cuota semanal de la versión gratuita.
//
// Almacenamiento (Vercel Blob, store público): todo lo personal va CIFRADO (AES-256-GCM) en rutas impredecibles
// derivadas de CUENTAS_SECRET con HMAC. Sin CUENTAS_SECRET las cuentas y las cuotas quedan desactivadas.
//   cuentas/{uid}/u.json        usuario {email, plan, creado, cuota:{semana,n}, jti:[]}
//   cuentas/{uid}/i.json        índice del historial [{id, fecha, titulo, total, supers}]
//   cuentas/{uid}/l/{id}.json   lista completa (plan)
//   cuota/{semana}/{hash-ip}.json  contador anónimo {n} (sin IP en claro)
import crypto from "node:crypto";

export const COOKIE = "mb_s";
const SESION_DIAS = 90, ENLACE_MIN = 20;

const num = (k, d) => (Number.isFinite(+process.env[k]) && process.env[k] !== "" ? +process.env[k] : d);
export const LIMITES = () => ({
  anonimo: { listas: num("LISTAS_ANON_SEMANA", 2), historial: 0 },
  gratis: { listas: num("LISTAS_GRATIS_SEMANA", 4), historial: num("HISTORIAL_GRATIS", 10) },
  pro: { listas: Infinity, historial: num("HISTORIAL_PRO", 200) },
});

const SECRET = () => process.env.CUENTAS_SECRET || "";
export const activas = () => SECRET().length >= 16;
/** Se puede entrar si hay proveedor de email (o en modo desarrollo). Sin él no se limita a los anónimos: no tendrían salida. */
const resendKey = () => process.env.RESEND_API_KEY || process.env.RESEND_APIKEY || "";
export const emailListo = () => !!resendKey() || process.env.CUENTAS_DEV === "1";
const hmac = (s) => crypto.createHmac("sha256", SECRET()).update(s).digest("base64url");
const iguales = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export const normEmail = (e) => String(e || "").trim().toLowerCase();
export const emailValido = (e) => /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,24}$/i.test(e) && e.length <= 254;
export const uid = (email) => hmac("uid:" + normEmail(email)).slice(0, 32);
export const hashIp = (ip) => hmac("ip:" + ip).slice(0, 24);

/** Semana ISO en hora de Canarias (UTC±1; el desfase no cambia la semana salvo en la medianoche del domingo). */
export function semana(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dia = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - dia);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y0) / 864e5 + 1) / 7)).padStart(2, "0")}`;
}
/** Próximo lunes 00:00 UTC (renovación de la cuota). */
export function renueva(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + ((8 - (t.getUTCDay() || 7)) % 7 || 7));
  return t.toISOString().slice(0, 10);
}

/* ---------- tokens firmados (enlace, sesión, pase) ---------- */
export function firma(obj, segundos) {
  const p = Buffer.from(JSON.stringify({ ...obj, exp: Math.floor(Date.now() / 1000) + segundos })).toString("base64url");
  return p + "." + hmac("tok:" + p);
}
export function verifica(tok, tipo) {
  if (!activas() || typeof tok !== "string" || tok.length > 2000) return null;
  const [p, s] = tok.split(".");
  if (!p || !s || !iguales(s, hmac("tok:" + p))) return null;
  let o; try { o = JSON.parse(Buffer.from(p, "base64url").toString("utf8")); } catch { return null; }
  if (!o || o.t !== tipo || !(o.exp > Date.now() / 1000)) return null;
  return o;
}

/* ---------- cifrado ---------- */
const clave = () => crypto.createHash("sha256").update(SECRET() + ":enc:v1").digest();
export function cifra(obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", clave(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return { v: 1, d: Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url") };
}
export function descifra(o) {
  if (!o || o.v !== 1 || typeof o.d !== "string") return null;
  const b = Buffer.from(o.d, "base64url"), d = crypto.createDecipheriv("aes-256-gcm", clave(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"));
}

/* ---------- Blob (inyectable para tests) ---------- */
let blobImpl = null;
export const usaBlob = (impl) => { blobImpl = impl; };
async function B() {
  if (blobImpl) return blobImpl;
  const sdk = await import("@vercel/blob");
  return (blobImpl = {
    async put(path, txt) { await sdk.put(path, txt, { access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json", cacheControlMaxAge: 60 }); },
    async get(path) {
      let h; try { h = await sdk.head(path); } catch (e) { if (/not.?found/i.test(`${e?.name} ${e?.message}`)) return null; throw e; }
      const r = await fetch(`${h.url}?v=${encodeURIComponent(h.uploadedAt?.toISOString?.() || Date.now())}`, { cache: "no-store" });
      if (r.status === 404) return null; if (!r.ok) throw new Error(`Blob HTTP ${r.status}`);
      return r.text();
    },
    async delPrefix(prefix) {
      let cursor; do { const l = await sdk.list({ prefix, cursor, limit: 1000 }); if (l.blobs.length) await sdk.del(l.blobs.map((b) => b.url)); cursor = l.hasMore ? l.cursor : null; } while (cursor);
    },
    async del(path) { try { const h = await sdk.head(path); await sdk.del(h.url); } catch {} },
  });
}
const leeJ = async (path, privado = true) => { const t = await (await B()).get(path); if (t == null) return null; const o = JSON.parse(t); return privado ? descifra(o) : o; };
const guardaJ = async (path, obj, privado = true) => (await B()).put(path, JSON.stringify(privado ? cifra(obj) : obj));

const pU = (u) => `cuentas/${u}/u.json`, pI = (u) => `cuentas/${u}/i.json`, pL = (u, id) => `cuentas/${u}/l/${id}.json`;

/* ---------- usuarios ---------- */
export const leeUsuario = (u) => leeJ(pU(u));
export const guardaUsuario = (u, obj) => guardaJ(pU(u), obj);
export async function entra(email, jti) {
  const u = uid(email);
  const prev = await leeUsuario(u);
  if (prev?.jti?.includes(jti)) return { error: "usado" };
  const usr = prev || { email: normEmail(email), plan: "gratis", creado: new Date().toISOString(), cuota: { semana: semana(), n: 0 }, jti: [] };
  usr.jti = [...(usr.jti || []), jti].slice(-20); usr.ultimo = new Date().toISOString();
  await guardaUsuario(u, usr);
  return { u, usr, nuevo: !prev };
}

/* ---------- cookies y sesión ---------- */
export function leeCookie(req, nombre = COOKIE) {
  const c = String(req.headers?.cookie || "");
  for (const p of c.split(/;\s*/)) { const i = p.indexOf("="); if (i > 0 && p.slice(0, i) === nombre) return decodeURIComponent(p.slice(i + 1)); }
  return null;
}
export function sesion(req) { const o = verifica(leeCookie(req), "s"); return o ? { u: o.u, email: o.e } : null; }
const seguro = (req) => !/^localhost|^127\./.test(String(req.headers?.host || ""));
export const cookieSesion = (req, u, email) => `${COOKIE}=${encodeURIComponent(firma({ t: "s", u, e: email }, SESION_DIAS * 86400))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESION_DIAS * 86400}${seguro(req) ? "; Secure" : ""}`;
export const cookieFuera = (req) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${seguro(req) ? "; Secure" : ""}`;
export const tokenEnlace = (email) => firma({ t: "l", e: normEmail(email), j: crypto.randomBytes(9).toString("base64url") }, ENLACE_MIN * 60);

/* ---------- cuota ---------- */
export const ipDe = (req) => String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "?";

/** Estado de la cuota sin consumir. */
export async function estadoCuota(req) {
  const L = LIMITES(), s = sesion(req), sem = semana();
  if (s) {
    const usr = await leeUsuario(s.u);
    if (usr) {
      const plan = usr.plan === "pro" ? "pro" : "gratis";
      const n = usr.cuota?.semana === sem ? usr.cuota.n : 0;
      return { quien: "cuenta", u: s.u, usr, plan, usadas: n, limite: L[plan].listas, historial: L[plan].historial, renueva: renueva() };
    }
  }
  const k = `cuota/${sem}/${hashIp(ipDe(req))}.json`;
  const c = await leeJ(k, false).catch(() => null);
  return { quien: "anonimo", k, plan: "anonimo", usadas: c?.n || 0, limite: L.anonimo.listas, historial: 0, renueva: renueva() };
}

/** Consume una lista si queda cuota. → {ok, estado} */
export async function consumeLista(req) {
  if (!activas()) return { ok: true, estado: null };
  const e = await estadoCuota(req);
  if (e.usadas >= e.limite && (e.quien === "cuenta" || emailListo())) return { ok: false, estado: e };
  if (e.quien === "cuenta") {
    e.usr.cuota = { semana: semana(), n: e.usadas + 1 };
    await guardaUsuario(e.u, e.usr);
  } else await guardaJ(e.k, { n: e.usadas + 1 }, false);
  e.usadas++;
  return { ok: true, estado: e };
}
/** Devuelve una lista consumida (Claude falló antes de empezar). */
export async function devuelveLista(e) {
  if (!e) return;
  const n = Math.max(0, e.usadas - 1);
  if (e.quien === "cuenta") { const usr = await leeUsuario(e.u); if (usr?.cuota?.semana === semana()) { usr.cuota.n = Math.min(usr.cuota.n, n); await guardaUsuario(e.u, usr); } }
  else await guardaJ(e.k, { n }, false);
}
export const publicoCuota = (e) => e && ({ plan: e.plan, usadas: e.usadas, limite: Number.isFinite(e.limite) ? e.limite : null, renueva: e.renueva, historial: e.historial });

/** Borra los contadores anónimos de semanas anteriores a la pasada (se llama desde el cron). */
export async function limpiaCuotas() {
  if (!activas()) return 0;
  const sdk = await import("@vercel/blob"), d = new Date(); d.setUTCDate(d.getUTCDate() - 7);
  const minima = semana(d); let n = 0, cursor;
  do {
    const l = await sdk.list({ prefix: "cuota/", cursor, limit: 1000 });
    const viejos = l.blobs.filter((b) => (b.pathname.split("/")[1] || "") < minima).map((b) => b.url);
    if (viejos.length) { await sdk.del(viejos); n += viejos.length; }
    cursor = l.hasMore ? l.cursor : null;
  } while (cursor);
  return n;
}

/* ---------- historial ---------- */
export const indice = async (u) => (await leeJ(pI(u))) || [];
export const leeLista = (u, id) => (/^[A-Za-z0-9_-]{6,40}$/.test(id) ? leeJ(pL(u, id)) : null);
export async function guardaLista(u, plan, maxHist) {
  const idx = await indice(u);
  const id = plan.nubeId && /^[A-Za-z0-9_-]{6,40}$/.test(plan.nubeId) && idx.some((x) => x.id === plan.nubeId) ? plan.nubeId : crypto.randomBytes(9).toString("base64url");
  const meta = resumen(plan, id);
  await guardaJ(pL(u, id), { ...plan, nubeId: id });
  let nuevo = [meta, ...idx.filter((x) => x.id !== id)].sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  const fuera = nuevo.slice(Math.max(0, maxHist)); nuevo = nuevo.slice(0, Math.max(0, maxHist));
  await guardaJ(pI(u), nuevo);
  const b = await B(); for (const x of fuera) await b.del(pL(u, x.id));
  return { id, meta, recortadas: fuera.length };
}
export async function borraLista(u, id) {
  const idx = await indice(u);
  if (!idx.some((x) => x.id === id)) return false;
  await guardaJ(pI(u), idx.filter((x) => x.id !== id));
  await (await B()).del(pL(u, id));
  return true;
}
export async function borraCuenta(u) { await (await B()).delPrefix(`cuentas/${u}/`); }
export async function exporta(u) {
  const usr = await leeUsuario(u), idx = await indice(u);
  const listas = []; for (const x of idx) listas.push(await leeLista(u, x.id));
  return { usuario: usr && { email: usr.email, plan: usr.plan, creado: usr.creado }, listas: listas.filter(Boolean) };
}

const r2 = (x) => Math.round(x * 100) / 100;
export function resumen(plan, id) {
  const L = (plan.listas || []).find((l) => l.id === plan.activa) || (plan.listas || [])[0];
  const total = +(L?.total ?? plan.total ?? 0) || null;
  const recetas = (plan.recetas || []).slice(0, 3).map((r) => String(r.nombre || r.titulo || "").slice(0, 60)).filter(Boolean);
  return {
    id, fecha: String(plan.fecha || new Date().toISOString()).slice(0, 30),
    titulo: String(plan.super || (plan.superIds || []).join(" + ") || "Lista").slice(0, 80),
    total: total && r2(total), supers: (plan.superIds || []).slice(0, 6).map(String), recetas,
  };
}

/* ---------- email ---------- */
export async function enviaEnlace(email, url) {
  const key = resendKey();
  if (!key) throw Object.assign(new Error("El envío de emails no está configurado todavía."), { status: 503, code: "email_no_configurado" });
  const from = process.env.EMAIL_FROM || "MojoBasket <acceso@mojobasket.es>";
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;padding:24px;color:#1f1d1b">
<h2 style="font-family:Georgia,serif;margin:0 0 12px">Entra en MojoBasket</h2>
<p>Pulsa el botón para entrar. El enlace caduca en ${ENLACE_MIN} minutos y solo sirve una vez.</p>
<p style="margin:24px 0"><a href="${url}" style="background:#ffc72c;color:#1f1d1b;padding:14px 22px;border-radius:14px;font-weight:700;text-decoration:none;display:inline-block">Entrar en MojoBasket</a></p>
<p style="font-size:13px;color:#5e5547">Si no lo has pedido tú, ignora este mensaje: nadie podrá entrar sin abrir este enlace.</p></div>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [email], subject: "Tu enlace para entrar en MojoBasket", html, text: `Entra en MojoBasket: ${url}\n\nCaduca en ${ENLACE_MIN} minutos.` }),
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw Object.assign(new Error("No se pudo enviar el email (" + r.status + ")"), { status: 502, detalle: t.slice(0, 300) }); }
}
