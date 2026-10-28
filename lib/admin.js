// /api/admin?accion=… (servido desde api/app.js) — Panel SuperAdmin (/admin).
// Acceso: sesión válida de una cuenta incluida en SUPERADMIN_EMAILS. Toda la autorización se hace aquí, en el servidor.
// Las acciones POST exigen origen de MojoBasket y la cabecera x-mb-admin: 1 (fuerza preflight si viniera de fuera).
// Cada acción que cambia algo queda en la auditoría (admin/audit/AAAA-MM-DD/…json, cifrada: contiene emails).
//
// GET  resumen                     KPIs: usuarios, actividad 14 días, Claude hoy
// GET  usuarios?q=&plan=&estado=   listado con búsqueda          GET  usuario?uid=   ficha + historial
// GET  lista?uid=&id=              ver una lista (solo lectura)  GET  exportar?uid=  datos del usuario (RGPD)
// POST usuario_plan {uid, plan}    POST usuario_bloquear {uid, bloqueado, motivo}    POST usuario_revocar {uid}
// POST usuario_cuota {uid}         POST usuario_nota {uid, nota}                     POST usuario_borrar {uid, confirma, motivo}
// POST usuario_crear {email, plan, enviar}   crea (o actualiza el plan) y opcionalmente envía el enlace de acceso
// GET  uso?dias=30                 Claude por día y modelo + coste estimado
// GET  embudo?desde=&hasta=        indicadores por cadena (descarga eventos: bajo demanda)
// GET  catalogos                   frescura del recolector     POST catalogo_forzar {cadena}
// GET  sistema                     configuración (solo presencia de variables, nunca valores) y límites
// GET  almacenamiento              tamaño de Blob por carpeta (bajo demanda: usa operaciones list)
// POST limpieza {tipo:"cuotas"|"eventos"|"uso", dias}
// POST email_prueba                envía un email de prueba al admin
// GET  auditoria                   últimas acciones del panel
import crypto from "node:crypto";
import * as C from "./cuenta.js";
import { CADENAS, CP_DEFECTO } from "./api.js";
import { lee, ruta } from "./store.js";
import { dia, usoDia, eventos, agrega } from "./metricas.js";

const ORIGENES = /^https:\/\/(www\.)?mojobasket\.es$|^https:\/\/quecompro-precios(-[a-z0-9-]+)?\.vercel\.app$|^http:\/\/localhost(:\d+)?$/;
const UID = /^[A-Za-z0-9_-]{16,40}$/;
const err = (status, message, code) => Object.assign(new Error(message), { status, code });

const json = (res, st, obj, extra = {}) => {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-robots-tag", "noindex");
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.status(st).send(JSON.stringify(obj));
};
function cuerpo(req) {
  let b = req.body;
  if (Buffer.isBuffer?.(b)) b = b.toString("utf8");
  if (typeof b === "string") { try { b = JSON.parse(b || "{}"); } catch { b = null; } }
  return b && typeof b === "object" ? b : {};
}
const base = (req) => {
  const host = String(req.headers?.["x-forwarded-host"] || req.headers?.host || "mojobasket.es");
  return (/^localhost|^127\./.test(host) ? "http://" : "https://") + host;
};
const diaMenos = (n, d = new Date()) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() - n); return dia(x); };
const esDia = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

/** map con concurrencia limitada */
async function pmap(arr, n, fn) {
  const out = new Array(arr.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, arr.length) }, async () => { while (i < arr.length) { const k = i++; out[k] = await fn(arr[k], k); } }));
  return out;
}

/* ---------- auditoría ---------- */
async function audita(admin, accion, objetivo = null, detalle = null) {
  const t = new Date().toISOString();
  const p = `admin/audit/${t.slice(0, 10)}/${t.slice(11, 23).replace(/[:.]/g, "")}-${crypto.randomBytes(3).toString("hex")}.json`;
  await C.guardaJ(p, { t, admin, accion, objetivo, detalle }).catch((e) => console.error("audita", e?.message || e));
}

/* ---------- usuarios ---------- */
let cacheUsr = null;
const invalida = () => { cacheUsr = null; };
export async function usuarios({ fresco = false } = {}) {
  if (!fresco && cacheUsr && Date.now() - cacheUsr.t < 20_000) return cacheUsr.v;
  const b = await C.blobs();
  const todo = await b.list("cuentas/");
  const por = new Map();
  for (const x of todo) {
    const [, u, f] = x.pathname.split("/"); if (!u) continue;
    const e = por.get(u) || { uid: u, bytes: 0, listas: 0, tieneU: false };
    e.bytes += x.size || 0; if (f === "l") e.listas++; if (f === "u.json") e.tieneU = true;
    por.set(u, e);
  }
  const sem = C.semana(), L = C.LIMITES();
  const v = (await pmap([...por.values()].filter((e) => e.tieneU), 20, async (e) => {
    const usr = await C.leeUsuario(e.uid).catch(() => null);
    if (!usr) return null;
    const admin = C.esAdmin(usr.email), plan = usr.plan === "pro" || admin ? "pro" : "gratis";
    return {
      uid: e.uid, email: usr.email, plan, plan_guardado: usr.plan || "gratis", admin,
      creado: usr.creado || null, ultimo: usr.ultimo || null,
      cuota: { usadas: usr.cuota?.semana === sem ? usr.cuota.n : 0, limite: Number.isFinite(L[plan].listas) ? L[plan].listas : null },
      bloqueado: !!usr.bloqueado, motivo: usr.motivo || null, nota: usr.nota || "", sesiones_revocadas: usr.sv || 0,
      listas: e.listas, bytes: e.bytes,
    };
  })).filter(Boolean).sort((a, b) => String(b.ultimo || b.creado).localeCompare(String(a.ultimo || a.creado)));
  cacheUsr = { t: Date.now(), v };
  return v;
}
async function usuarioDe(uid) {
  if (!UID.test(String(uid || ""))) throw err(400, "uid no válido");
  const usr = await C.leeUsuario(uid);
  if (!usr) throw err(404, "No existe esa cuenta.");
  return usr;
}

/* ---------- métricas ---------- */
const PRECIOS = () => ({ // USD por millón de tokens (estimación; ajustable por variables)
  sonnet: [+process.env.PRECIO_SONNET_IN || 3, +process.env.PRECIO_SONNET_OUT || 15],
  haiku: [+process.env.PRECIO_HAIKU_IN || 1, +process.env.PRECIO_HAIKU_OUT || 5],
  opus: [+process.env.PRECIO_OPUS_IN || 5, +process.env.PRECIO_OPUS_OUT || 25],
});
export function coste(modelos) {
  const P = PRECIOS(); let usd = 0;
  for (const [m, v] of Object.entries(modelos || {})) {
    const f = /haiku/i.test(m) ? "haiku" : /opus/i.test(m) ? "opus" : "sonnet";
    usd += (v.in / 1e6) * P[f][0] + (v.out / 1e6) * P[f][1];
  }
  return Math.round(usd * 100) / 100;
}
/** Eventos por día y tipo contando nombres (sin descargar): ev/AAAA-MM-DD/HHMMSS-tipo-xxxx.json */
async function actividad(dias) {
  const b = await C.blobs(), out = [];
  for (let i = dias - 1; i >= 0; i--) {
    const d = diaMenos(i), c = { dia: d, lista: 0, clic: 0, copiar: 0, claude_chrome: 0 };
    for (const x of await b.list(`ev/${d}/`, 20_000)) { const m = /\d{6}-(lista|clic|copiar|claude_chrome)/.exec(x.pathname); if (m) c[m[1]]++; }
    out.push(c);
  }
  return out;
}

/* ---------- handler ---------- */
export async function admin(req, res) {
  const q = req.query || {}, accion = String(q.accion || "resumen");
  if (!C.activas()) return json(res, 503, { ok: false, error: "Las cuentas no están activadas (CUENTAS_SECRET)." });
  let s;
  try { s = await C.sesionValida(req); } catch (e) { console.error("admin sesion", e?.message || e); return json(res, 500, { ok: false, error: "No se pudo comprobar la sesión." }); }
  if (!s) return json(res, 401, { ok: false, code: "sin_sesion", error: "Entra con tu email de SuperAdmin." });
  if (!C.esAdmin(s.usr.email)) return json(res, 403, { ok: false, code: "no_admin", error: "Esta cuenta no es SuperAdmin." });
  const yo = s.usr.email;
  if (req.method === "POST") {
    const o = req.headers?.origin || "";
    if ((o && !ORIGENES.test(o)) || req.headers?.["x-mb-admin"] !== "1") return json(res, 403, { ok: false, error: "origen no permitido" });
  }
  try {
    const b = req.method === "POST" ? cuerpo(req) : {};
    /* ---- lectura ---- */
    if (accion === "resumen" && req.method === "GET") {
      const [us, act, hoy] = await Promise.all([usuarios({ fresco: q.fresco === "1" }), actividad(14).catch(() => []), usoDia(dia(), { fresco: true }).catch(() => null)]);
      const h7 = new Date(Date.now() - 7 * 864e5).toISOString();
      return json(res, 200, {
        ok: true, yo, ahora: new Date().toISOString(),
        usuarios: { total: us.length, pro: us.filter((u) => u.plan === "pro").length, nuevos_7d: us.filter((u) => (u.creado || "") >= h7).length, activos_7d: us.filter((u) => (u.ultimo || "") >= h7).length, bloqueados: us.filter((u) => u.bloqueado).length, listas_guardadas: us.reduce((a, u) => a + u.listas, 0) },
        actividad: act,
        claude_hoy: hoy && { llamadas: hoy.llamadas, tope: +process.env.CLAUDE_TOPE_DIA || 600, coste_usd: coste(hoy.modelos), modelos: hoy.modelos },
        recientes: us.slice(0, 8).map(({ uid, email, plan, ultimo, creado, admin: a }) => ({ uid, email, plan, ultimo, creado, admin: a })),
      });
    }
    if (accion === "usuarios" && req.method === "GET") {
      const t = C.normEmail(q.q || ""); let us = await usuarios({ fresco: q.fresco === "1" });
      if (t) us = us.filter((u) => u.email.includes(t) || u.uid.startsWith(q.q));
      if (q.plan === "pro" || q.plan === "gratis") us = us.filter((u) => u.plan === q.plan);
      if (q.estado === "bloqueado") us = us.filter((u) => u.bloqueado); else if (q.estado === "activo") us = us.filter((u) => !u.bloqueado);
      return json(res, 200, { ok: true, total: us.length, usuarios: us.slice(0, 500) });
    }
    if (accion === "usuario" && req.method === "GET") {
      const usr = await usuarioDe(q.uid), idx = await C.indice(q.uid);
      const fila = (await usuarios()).find((u) => u.uid === q.uid) || null;
      return json(res, 200, { ok: true, usuario: { ...fila, uid: q.uid, email: usr.email, creado: usr.creado, ultimo: usr.ultimo, bloqueado: !!usr.bloqueado, motivo: usr.motivo || null, nota: usr.nota || "", accesos: (usr.jti || []).length }, historial: idx });
    }
    if (accion === "lista" && req.method === "GET") {
      const usr = await usuarioDe(q.uid);
      const l = await C.leeLista(q.uid, String(q.id || ""));
      if (!l) throw err(404, "No encuentro esa lista.");
      await audita(yo, "ver_lista", q.uid, { email: usr.email, id: q.id });
      return json(res, 200, { ok: true, plan: l });
    }
    if (accion === "exportar" && req.method === "GET") {
      const usr = await usuarioDe(q.uid);
      await audita(yo, "exportar", q.uid, { email: usr.email });
      return json(res, 200, await C.exporta(q.uid), { "content-disposition": `attachment; filename="mojobasket-${q.uid.slice(0, 8)}.json"` });
    }
    if (accion === "uso" && req.method === "GET") {
      const dias = Math.max(1, Math.min(62, +q.dias || 30)), out = [];
      await pmap(Array.from({ length: dias }, (_, i) => diaMenos(dias - 1 - i)), 6, async (d, i) => {
        const u = await usoDia(d, { fresco: true }).catch(() => null);
        out[i] = { dia: d, llamadas: u?.llamadas || 0, in: Object.values(u?.modelos || {}).reduce((a, m) => a + m.in, 0), out: Object.values(u?.modelos || {}).reduce((a, m) => a + m.out, 0), coste_usd: coste(u?.modelos), modelos: u?.modelos || {} };
      });
      const tot = out.reduce((a, d) => ({ llamadas: a.llamadas + d.llamadas, coste_usd: Math.round((a.coste_usd + d.coste_usd) * 100) / 100 }), { llamadas: 0, coste_usd: 0 });
      return json(res, 200, { ok: true, dias: out, total: tot, precios_usd_mtok: PRECIOS(), tope_dia: +process.env.CLAUDE_TOPE_DIA || 600, limite_hora_ip: +process.env.CLAUDE_LIMITE_HORA || 30 });
    }
    if (accion === "embudo" && req.method === "GET") {
      const hasta = esDia(q.hasta) ? q.hasta : dia(), desde = esDia(q.desde) ? q.desde : diaMenos(29, new Date(hasta + "T00:00:00Z"));
      const evs = await eventos(desde, hasta);
      return json(res, 200, { ok: true, desde, hasta, eventos: evs.length, ...agrega(evs) });
    }
    if (accion === "catalogos" && req.method === "GET") {
      const hoy = dia(), cp = String(q.cp || CP_DEFECTO), bl = await C.blobs();
      const cadenas = await pmap(CADENAS, 3, async (c) => {
        const prog = await lee(ruta(c, cp, "progreso"), 0).catch(() => null);
        const hist = await bl.list(`hist/${c}/${cp}/`).catch(() => []);
        const dias = hist.map((x) => /(\d{4}-\d{2}-\d{2})\.json$/.exec(x.pathname)?.[1]).filter(Boolean).sort();
        const estado = prog?.dia === hoy && prog.completo ? "ok" : prog?.dia === hoy ? "en_curso" : "atrasado";
        return { cadena: c, cp, estado, progreso: prog, historico: { dias: dias.length, primero: dias[0] || null, ultimo: dias.at(-1) || null } };
      });
      return json(res, 200, { ok: true, hoy, cadenas, crons: "04:00–07:20 UTC (4 disparos por cadena)" });
    }
    if (accion === "sistema" && req.method === "GET") {
      const hay = (k) => !!process.env[k];
      const L = C.LIMITES();
      return json(res, 200, {
        ok: true,
        despliegue: { entorno: process.env.VERCEL_ENV || "local", region: process.env.VERCEL_REGION || null, commit: (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7) || null, mensaje: (process.env.VERCEL_GIT_COMMIT_MESSAGE || "").split("\n")[0].slice(0, 120) || null, node: process.version },
        variables: Object.fromEntries(["CUENTAS_SECRET", "SUPERADMIN_EMAILS", "RESEND_API_KEY", "EMAIL_FROM", "BLOB_READ_WRITE_TOKEN", "CRON_SECRET", "INFORME_KEY", "ANTHROPIC_API_KEY", "AI_GATEWAY_API_KEY", "AI_GATEWAY_MODEL", "AI_GATEWAY_MODEL_RAPIDO", "CLAUDE_TOPE_DIA", "CLAUDE_LIMITE_HORA", "CP_DEFECTO", "CUENTAS_DEV"].map((k) => [k, k === "RESEND_API_KEY" ? hay(k) || hay("RESEND_APIKEY") : k === "SUPERADMIN_EMAILS" ? hay(k) || hay("SUPERADMIN_EMAIL") : hay(k)])),
        claude: { via: hay("ANTHROPIC_API_KEY") ? "anthropic" : "ai-gateway", modelo: process.env.ANTHROPIC_MODEL || process.env.AI_GATEWAY_MODEL || "auto", modelo_rapido: process.env.ANTHROPIC_MODEL_RAPIDO || process.env.AI_GATEWAY_MODEL_RAPIDO || "auto" },
        limites: { anonimo: L.anonimo, gratis: L.gratis, pro: { listas: null, historial: L.pro.historial } },
        avisos: [
          !hay("RESEND_API_KEY") && !hay("RESEND_APIKEY") && "Sin RESEND_API_KEY: nadie puede recibir el enlace de acceso.",
          !hay("CRON_SECRET") && "Sin CRON_SECRET: el recolector diario no se puede ejecutar.",
          !hay("BLOB_READ_WRITE_TOKEN") && "Sin BLOB_READ_WRITE_TOKEN: no hay catálogos, cuentas ni métricas.",
          process.env.CUENTAS_DEV === "1" && process.env.VERCEL_ENV === "production" && "CUENTAS_DEV=1 en producción: el enlace se devuelve sin email. Quítalo.",
        ].filter(Boolean),
      });
    }
    if (accion === "almacenamiento" && req.method === "GET") {
      const todo = await (await C.blobs()).list("", 200_000), por = {};
      for (const x of todo) {
        const p = x.pathname.split("/"), k = p[0] === "snap" || p[0] === "hist" ? `${p[0]}/${p[1] || ""}` : p[0];
        const e = (por[k] ||= { carpeta: k, blobs: 0, bytes: 0, ultimo: null });
        e.blobs++; e.bytes += x.size || 0;
        const t = x.uploadedAt ? new Date(x.uploadedAt).toISOString() : null; if (t && (!e.ultimo || t > e.ultimo)) e.ultimo = t;
      }
      const carpetas = Object.values(por).sort((a, b) => b.bytes - a.bytes);
      return json(res, 200, { ok: true, total: { blobs: todo.length, bytes: carpetas.reduce((a, c) => a + c.bytes, 0) }, carpetas, truncado: todo.length >= 200_000 });
    }
    if (accion === "auditoria" && req.method === "GET") {
      const ls = (await (await C.blobs()).list("admin/audit/", 5000)).map((x) => x.pathname).sort().reverse().slice(0, Math.min(500, +q.n || 150));
      const evs = (await pmap(ls, 20, (p) => C.leeJ(p).catch(() => null))).filter(Boolean);
      return json(res, 200, { ok: true, eventos: evs });
    }

    /* ---- acciones ---- */
    if (req.method !== "POST") return json(res, 400, { ok: false, error: "acción no válida" });
    if (accion.startsWith("usuario_") && accion !== "usuario_crear") {
      const usr = await usuarioDe(b.uid), esOtroAdmin = C.esAdmin(usr.email);
      let detalle = null;
      if (accion === "usuario_plan") { const plan = b.plan === "pro" ? "pro" : "gratis"; detalle = { de: usr.plan || "gratis", a: plan }; usr.plan = plan; }
      else if (accion === "usuario_bloquear") {
        if (esOtroAdmin) throw err(400, "No se puede suspender a un SuperAdmin (quítalo antes de SUPERADMIN_EMAILS).");
        const motivo = String(b.motivo || "").trim().slice(0, 300);
        if (b.bloqueado && !motivo) throw err(400, "Indica el motivo de la suspensión.");
        usr.bloqueado = !!b.bloqueado; usr.motivo = usr.bloqueado ? motivo : null; if (usr.bloqueado) usr.sv = (usr.sv || 0) + 1;
        detalle = { bloqueado: usr.bloqueado, motivo };
      } else if (accion === "usuario_revocar") { usr.sv = (usr.sv || 0) + 1; detalle = { sv: usr.sv }; }
      else if (accion === "usuario_cuota") { detalle = { antes: usr.cuota }; usr.cuota = { semana: C.semana(), n: 0 }; }
      else if (accion === "usuario_nota") { usr.nota = String(b.nota || "").slice(0, 2000); detalle = { largo: usr.nota.length }; }
      else if (accion === "usuario_borrar") {
        if (esOtroAdmin) throw err(400, "No se puede borrar una cuenta SuperAdmin desde el panel.");
        if (C.normEmail(b.confirma) !== usr.email) throw err(400, "Para borrar, escribe exactamente el email de la cuenta.");
        const motivo = String(b.motivo || "").trim().slice(0, 300);
        if (!motivo) throw err(400, "Indica el motivo del borrado.");
        const listas = (await C.indice(b.uid)).length;
        await C.borraCuenta(b.uid); invalida();
        await audita(yo, accion, b.uid, { email: usr.email, motivo, listas });
        return json(res, 200, { ok: true, borrado: true });
      } else return json(res, 400, { ok: false, error: "acción no válida" });
      await C.guardaUsuario(b.uid, usr); invalida();
      await audita(yo, accion, b.uid, { email: usr.email, ...detalle });
      return json(res, 200, { ok: true });
    }
    if (accion === "usuario_crear") {
      const email = C.normEmail(b.email);
      if (!C.emailValido(email)) throw err(400, "Email no válido.");
      const u = C.uid(email), prev = await C.leeUsuario(u), plan = b.plan === "pro" ? "pro" : "gratis";
      const usr = prev || { email, plan, creado: new Date().toISOString(), cuota: { semana: C.semana(), n: 0 }, jti: [] };
      usr.plan = plan;
      await C.guardaUsuario(u, usr); invalida();
      let enviado = false;
      if (b.enviar) { await C.enviaEnlace(email, `${base(req)}/api/cuenta?accion=entrar&t=${encodeURIComponent(C.tokenEnlace(email))}`); enviado = true; }
      await audita(yo, accion, u, { email, plan, existia: !!prev, enviado });
      return json(res, 200, { ok: true, uid: u, existia: !!prev, enviado });
    }
    if (accion === "catalogo_forzar") {
      const c = String(b.cadena || ""), cp = String(b.cp || CP_DEFECTO);
      if (!CADENAS.includes(c)) throw err(400, "cadena no válida");
      if (!process.env.CRON_SECRET) throw err(503, "Falta CRON_SECRET.");
      const r = await fetch(`${base(req)}/api/cron?cadena=${c}&cp=${encodeURIComponent(cp)}&forzar=1`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, signal: AbortSignal.timeout(20000) });
      const j = await r.json().catch(() => ({}));
      await audita(yo, accion, c, { cp, status: r.status });
      return json(res, r.ok ? 200 : 502, { ok: r.ok, status: r.status, respuesta: j });
    }
    if (accion === "limpieza") {
      const tipo = String(b.tipo || "");
      if (tipo === "cuotas") { const n = await C.limpiaCuotas(); await audita(yo, accion, tipo, { borrados: n }); return json(res, 200, { ok: true, borrados: n }); }
      if (tipo === "eventos" || tipo === "uso") {
        const dias = Math.max(30, +b.dias || 0), limite = diaMenos(dias), pre = tipo === "eventos" ? "ev/" : "uso/", bl = await C.blobs();
        const viejos = [...new Set((await bl.list(pre)).map((x) => /^(?:ev|uso)\/(\d{4}-\d{2}-\d{2})/.exec(x.pathname)?.[1]).filter((d) => d && d < limite))];
        for (const d of viejos) await bl.delPrefix(`${pre}${d}`);
        await audita(yo, accion, tipo, { dias, antes_de: limite, dias_borrados: viejos.length });
        return json(res, 200, { ok: true, dias_borrados: viejos.length, antes_de: limite });
      }
      throw err(400, "tipo = cuotas | eventos | uso");
    }
    if (accion === "email_prueba") {
      const r = await C.enviaEmail(yo, "Prueba del panel MojoBasket", `<p>Email de prueba enviado desde el panel SuperAdmin el ${new Date().toLocaleString("es-ES", { timeZone: "Atlantic/Canary" })}.</p><p>Si lo lees, Resend y el dominio funcionan.</p>`, "Email de prueba del panel SuperAdmin de MojoBasket.");
      await audita(yo, accion, yo, { id: r?.id || null });
      return json(res, 200, { ok: true, id: r?.id || null, a: yo });
    }
    return json(res, 400, { ok: false, error: "acción no válida" });
  } catch (e) {
    console.error("admin", accion, e?.message || e, e?.detalle || "");
    return json(res, e.status || 500, { ok: false, code: e.code, error: e.status ? e.message : "Error interno del panel: " + String(e?.message || e).slice(0, 200) });
  }
}
