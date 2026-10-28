// /api/cuenta?accion=… (servido desde api/app.js)
//   POST enlace {email}        → envía el enlace mágico            GET  entrar?t=…      → abre sesión y redirige a /
//   GET  yo                    → sesión, plan y cuota              POST salir           → cierra sesión
//   GET  listas                → índice del historial              GET  lista?id=…      → lista completa
//   POST guardar {plan}        → guarda/actualiza en la nube       POST borrar_lista {id}
//   GET  exportar              → todos tus datos (JSON)            POST borrar_cuenta   → borra cuenta e historial
//   POST plan?key=INFORME_KEY {email, plan:"gratis"|"pro"}        → cambia el plan (administración)
import * as C from "./cuenta.js";

const ORIGENES = /^https:\/\/(www\.)?mojobasket\.es$|^https:\/\/quecompro-precios(-[a-z0-9-]+)?\.vercel\.app$|^http:\/\/localhost(:\d+)?$/;
const golpes = new Map();
function frena(clave, max, ms) {
  const t = Date.now(), a = (golpes.get(clave) || []).filter((x) => t - x < ms);
  if (a.length >= max) return false;
  a.push(t); golpes.set(clave, a);
  if (golpes.size > 5000) for (const [k, v] of golpes) if (!v.some((x) => t - x < 3600_000)) golpes.delete(k);
  return true;
}
const json = (res, st, obj, cookie) => {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  if (cookie) res.setHeader("set-cookie", cookie);
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

export async function cuenta(req, res) {
  const q = req.query || {}, accion = String(q.accion || "yo");
  if (!C.activas()) return json(res, 503, { ok: false, code: "cuentas_off", error: "Las cuentas no están activadas." });
  if (req.method === "POST") {
    const o = req.headers?.origin || "";
    if (o && !ORIGENES.test(o)) return json(res, 403, { ok: false, error: "origen no permitido" });
  }
  try {
    if (accion === "enlace" && req.method === "POST") {
      const email = C.normEmail(cuerpo(req).email);
      if (!C.emailValido(email)) return json(res, 400, { ok: false, error: "Escribe un email válido." });
      if (!frena("e:" + email, 3, 15 * 60_000) || !frena("i:" + C.ipDe(req), 10, 3600_000))
        return json(res, 429, { ok: false, code: "rate_limited", error: "Has pedido varios enlaces seguidos. Espera unos minutos." });
      const url = `${base(req)}/api/cuenta?accion=entrar&t=${encodeURIComponent(C.tokenEnlace(email))}`;
      if (process.env.CUENTAS_DEV === "1") return json(res, 200, { ok: true, dev_url: url });
      await C.enviaEnlace(email, url);
      return json(res, 200, { ok: true });
    }
    if (accion === "entrar" && req.method === "GET") {
      const t = C.verifica(String(q.t || ""), "l");
      const fin = (estado, cookie) => { res.setHeader("cache-control", "no-store"); if (cookie) res.setHeader("set-cookie", cookie); res.setHeader("location", "/?cuenta=" + estado); return res.status(302).end(); };
      if (!t) return fin("caducado");
      const r = await C.entra(t.e, t.j);
      if (r.error) return fin("usado");
      return fin(r.nuevo ? "nueva" : "ok", C.cookieSesion(req, r.u, r.usr.email));
    }
    if (accion === "plan" && req.method === "POST") {
      if (!process.env.INFORME_KEY || q.key !== process.env.INFORME_KEY) return json(res, 401, { ok: false, error: "no autorizado" });
      const b = cuerpo(req), email = C.normEmail(b.email), plan = b.plan === "pro" ? "pro" : "gratis";
      const u = C.uid(email), usr = await C.leeUsuario(u);
      if (!usr) return json(res, 404, { ok: false, error: "no existe esa cuenta" });
      usr.plan = plan; await C.guardaUsuario(u, usr);
      return json(res, 200, { ok: true, email, plan });
    }

    if (accion === "yo") {
      const e = await C.estadoCuota(req);
      if (e.quien !== "cuenta") {
        const L = C.LIMITES().gratis;
        return json(res, 200, { ok: true, sesion: false, entrar: C.emailListo(), cuota: C.publicoCuota(e), gratis: { listas: L.listas, historial: L.historial } }, C.sesion(req) ? C.cookieFuera(req) : null);
      }
      const idx = await C.indice(e.u);
      return json(res, 200, { ok: true, sesion: true, entrar: true, email: e.usr.email, plan: e.plan, creado: e.usr.creado, cuota: C.publicoCuota(e), listas: idx.length });
    }
    if (accion === "salir") return json(res, 200, { ok: true }, C.cookieFuera(req));

    const s = C.sesion(req);
    if (!s) return json(res, 401, { ok: false, code: "sin_sesion", error: "Entra con tu email para usar tu historial." });

    if (accion === "listas") return json(res, 200, { ok: true, listas: await C.indice(s.u) });
    if (accion === "lista") {
      const l = await C.leeLista(s.u, String(q.id || ""));
      return l ? json(res, 200, { ok: true, plan: l }) : json(res, 404, { ok: false, error: "No encuentro esa lista." });
    }
    if (accion === "guardar" && req.method === "POST") {
      const plan = cuerpo(req).plan;
      if (!plan || typeof plan !== "object") return json(res, 400, { ok: false, error: "falta plan" });
      if (JSON.stringify(plan).length > 600_000) return json(res, 413, { ok: false, error: "lista demasiado grande" });
      const e = await C.estadoCuota(req);
      const r = await C.guardaLista(s.u, plan, e.historial || C.LIMITES().gratis.historial);
      return json(res, 200, { ok: true, ...r });
    }
    if (accion === "borrar_lista" && req.method === "POST") {
      const ok = await C.borraLista(s.u, String(cuerpo(req).id || ""));
      return json(res, ok ? 200 : 404, { ok });
    }
    if (accion === "exportar") {
      res.setHeader("content-disposition", 'attachment; filename="mojobasket-mis-datos.json"');
      return json(res, 200, await C.exporta(s.u));
    }
    if (accion === "borrar_cuenta" && req.method === "POST") {
      await C.borraCuenta(s.u);
      return json(res, 200, { ok: true }, C.cookieFuera(req));
    }
    return json(res, 400, { ok: false, error: "acción no válida" });
  } catch (e) {
    console.error("cuenta", accion, e?.message || e, e?.detalle || "");
    return json(res, e.status || 500, { ok: false, code: e.code, error: e.status ? e.message : "Error interno de cuentas." });
  }
}
