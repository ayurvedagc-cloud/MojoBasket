// /api/cuenta?accion=… (servido desde api/app.js)
//   POST enlace {email}        → envía el enlace mágico            GET  entrar?t=…      → abre sesión y redirige a /
//   GET  yo                    → sesión, plan y cuota              POST salir           → cierra sesión
//   GET  listas                → índice del historial              GET  lista?id=…      → lista completa
//   POST guardar {plan}        → guarda/actualiza en la nube       POST borrar_lista {id}
//   GET  exportar              → todos tus datos (JSON)            POST borrar_cuenta   → borra cuenta e historial
//   POST plan?key=INFORME_KEY {email, plan:"gratis"|"pro"}        → cambia el plan (administración)
//   GET  entrar?t=… muestra una página con botón; POST entrar?t=… consume el enlace (los escáneres de correo solo hacen GET)
//   POST canjear {codigo}      → código Pro                        POST pagar → enlace de aprobación de PayPal
//   GET  pago_ok?subscription_id=… → confirma en PayPal y vuelve a /  POST cancelar_sub → cancela la suscripción de PayPal
//   POST paypal_webhook        → eventos de PayPal (se vuelve a pedir la suscripción a la API)
import * as C from "./cuenta.js";
import * as P from "./pagos.js";

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
      const b = cuerpo(req), email = C.normEmail(b.email);
      if (!C.emailValido(email)) return json(res, 400, { ok: false, error: "Escribe un email válido." });
      if (!frena("e:" + email, 3, 15 * 60_000) || !frena("i:" + C.ipDe(req), 10, 3600_000))
        return json(res, 429, { ok: false, code: "rate_limited", error: "Has pedido varios enlaces seguidos. Espera unos minutos." });
      const url = `${base(req)}/api/cuenta?accion=entrar&t=${encodeURIComponent(C.tokenEnlace(email))}${b.volver === "admin" ? "&r=admin" : ""}`;
      if (process.env.CUENTAS_DEV === "1") return json(res, 200, { ok: true, dev_url: url });
      await C.enviaEnlace(email, url);
      return json(res, 200, { ok: true });
    }
    if (accion === "entrar" && req.method === "GET") {
      // No consume el enlace: Gmail, Outlook, antivirus y el seguimiento de clics abren los enlaces antes que la persona.
      const t = C.verifica(String(q.t || ""), "l");
      res.setHeader("cache-control", "no-store"); res.setHeader("x-robots-tag", "noindex"); res.setHeader("referrer-policy", "same-origin"); // no-referrer haría que el POST llegue con Origin: null
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (!t) { res.setHeader("location", "/?cuenta=caducado"); return res.status(302).end(); }
      const accionUrl = `/api/cuenta?accion=entrar&t=${encodeURIComponent(String(q.t))}${q.r === "admin" ? "&r=admin" : ""}`;
      return res.status(200).send(paginaEntrar(t.e, accionUrl, q.r === "admin"));
    }
    if (accion === "entrar" && req.method === "POST") {
      const t = C.verifica(String(q.t || ""), "l");
      const fin = (estado, cookie) => { res.setHeader("cache-control", "no-store"); if (cookie) res.setHeader("set-cookie", cookie); res.setHeader("location", (q.r === "admin" && (estado === "ok" || estado === "nueva") ? "/admin" : "/") + "?cuenta=" + estado); return res.status(303).end(); };
      if (!t) return fin("caducado");
      const r = await C.entra(t.e, t.j);
      if (r.error) return fin(r.error === "bloqueado" ? "bloqueado" : "usado");
      return fin(r.nuevo ? "nueva" : "ok", C.cookieSesion(req, r.u, r.usr.email, r.usr.sv || 0));
    }
    if (accion === "paypal_webhook" && req.method === "POST") {
      try { return json(res, 200, await P.webhook(req.body)); }
      catch (e) {
        console.error("paypal_webhook", e?.message || e, e?.detalle || "");
        await C.guardaJ("pagos/error.json", { t: new Date().toISOString(), error: String(e?.message || e).slice(0, 300) }, false).catch(() => {});
        return json(res, 500, { ok: false });
      }
    }
    if (accion === "pago_ok" && req.method === "GET") {
      let estado = "pro";
      try { const r = await P.confirma(String(q.subscription_id || "")); if (!r || r.estado !== "activa") estado = "pago_pendiente"; } catch (e) { console.error("pago_ok", e?.message || e); estado = "pago_pendiente"; }
      res.setHeader("cache-control", "no-store"); res.setHeader("location", "/?cuenta=" + estado); return res.status(302).end();
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
      const st = e.usr.sub;
      return json(res, 200, { ok: true, sesion: true, entrar: true, email: e.usr.email, admin: C.esAdmin(e.usr.email), plan: e.plan, creado: e.usr.creado, cuota: C.publicoCuota(e), listas: idx.length,
        pro_hasta: e.plan === "pro" && !C.suscripcionActiva(e.usr) && !C.esAdmin(e.usr.email) ? e.usr.pro_hasta || null : null,
        suscripcion: st ? { proveedor: st.proveedor, estado: st.estado, hasta: st.hasta, impago: !!st.impago, gestion: P.urlGestion() } : null, pagos: P.activo() ? { proveedor: "paypal", precio: P.precioTexto() } : null });
    }
    if (accion === "salir") return json(res, 200, { ok: true }, C.cookieFuera(req));

    const s = await C.sesionValida(req);
    if (!s) return json(res, 401, { ok: false, code: "sin_sesion", error: "Entra con tu email para usar tu historial." }, C.sesion(req) ? C.cookieFuera(req) : null);

    if (accion === "listas") return json(res, 200, { ok: true, listas: await C.indice(s.u) });
    if (accion === "canjear" && req.method === "POST") {
      if (!frena("c:" + s.u, 8, 3600_000)) return json(res, 429, { ok: false, code: "rate_limited", error: "Demasiados intentos. Prueba dentro de un rato." });
      const codigo = C.normCodigo(cuerpo(req).codigo);
      if (!codigo) return json(res, 400, { ok: false, error: "Escribe el código." });
      return json(res, 200, await C.canjea(s.u, codigo));
    }
    if (accion === "pagar" && req.method === "POST") return json(res, 200, { ok: true, url: await P.suscribir(s.u, s.usr, base(req)) });
    if (accion === "cancelar_sub" && req.method === "POST") { await P.cancelar(s.usr); return json(res, 200, { ok: true }); }
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

const escH = (x) => String(x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/** Página intermedia del enlace mágico: un botón que envía POST. Sin JavaScript que lo pulse solo (los escáneres lo ejecutarían). */
function paginaEntrar(email, accionUrl, admin) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Entrar en MojoBasket</title><link rel="icon" href="/icon.svg"><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4e7cf;color:#1f1d1b;font-family:"Hanken Grotesk",system-ui,sans-serif}
main{background:#fffcf5;border-radius:24px;box-shadow:0 6px 30px rgba(31,29,27,.12);padding:28px 24px;width:min(420px,calc(100vw - 32px));text-align:center}
h1{font-family:Fraunces,Georgia,serif;font-size:28px;margin:6px 0 8px}p{color:#5e5547;margin:0 0 20px;overflow-wrap:anywhere}
button{width:100%;height:56px;border:0;border-radius:16px;background:#ffc72c;color:#1f1d1b;font:700 18px system-ui,sans-serif;cursor:pointer}
small{display:block;color:#5e5547;margin-top:14px;font-size:13px}</style></head><body><main>
<img src="/icon.svg" alt="" width="56" height="56"><h1>${admin ? "Entrar al panel" : "Entrar en MojoBasket"}</h1>
<p>Vas a entrar como <b>${escH(email)}</b>.</p>
<form method="post" action="${escH(accionUrl)}"><button type="submit">Entrar</button></form>
<small>Si no lo has pedido tú, cierra esta página: nadie entra sin pulsar el botón.</small></main></body></html>`;
}
