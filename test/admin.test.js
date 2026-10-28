import { test } from "node:test";
import assert from "node:assert/strict";

process.env.CUENTAS_SECRET = "a".repeat(32);
process.env.CUENTAS_DEV = "1";
process.env.SUPERADMIN_EMAILS = "jefe@ejemplo.com";

const C = await import("../lib/cuenta.js");
const mem = new Map();
C.usaBlob({
  async put(p, t) { mem.set(p, t); }, async get(p) { return mem.get(p) ?? null; },
  async del(p) { mem.delete(p); }, async delPrefix(pre) { for (const k of [...mem.keys()]) if (k.startsWith(pre)) mem.delete(k); },
  async list(pre) { return [...mem.keys()].filter((k) => k.startsWith(pre)).map((k) => ({ pathname: k, size: mem.get(k).length, uploadedAt: new Date() })); },
});
const { cuenta } = await import("../lib/cuentaApi.js");
const { admin, coste } = await import("../lib/admin.js");

const res = () => ({ s: 0, h: {}, body: null, status(c) { this.s = c; return this; }, setHeader(k, v) { this.h[k.toLowerCase()] = v; }, send(b) { try { this.body = JSON.parse(b); } catch { this.body = b; } }, end() {} });
const req = (accion, { method = "GET", body, cookie, q = {}, h = {} } = {}) => ({ method, body, query: { accion, ...q }, headers: { host: "localhost:3000", cookie: cookie || "", "x-forwarded-for": "9.9.9.9", ...h } });
const C_ = async (...a) => { const r = res(); await cuenta(req(...a), r); return r; };
const A = async (accion, o = {}) => { const r = res(); await admin(req(accion, { ...o, h: o.method === "POST" ? { "x-mb-admin": "1", origin: "http://localhost:3000", ...(o.h || {}) } : o.h }), r); return r; };
async function entra(email) {
  const e = await C_("enlace", { method: "POST", body: { email } });
  const t = new URL(e.body.dev_url).searchParams.get("t");
  const r = await C_("entrar", { method: "POST", q: { t } });
  return { loc: r.h.location, cookie: r.h["set-cookie"]?.split(";")[0] };
}

test("panel admin: acceso, usuarios y acciones auditadas", async () => {
  const jefe = await entra("Jefe@Ejemplo.com"), ana = await entra("ana@ejemplo.es");
  assert.equal((await A("resumen")).s, 401);
  assert.equal((await A("resumen", { cookie: ana.cookie })).s, 403);
  assert.equal((await C_("yo", { cookie: jefe.cookie })).body.admin, true);
  assert.equal((await C_("yo", { cookie: ana.cookie })).body.admin, false);

  const r = await A("resumen", { cookie: jefe.cookie });
  assert.equal(r.s, 200); assert.equal(r.body.usuarios.total, 2); assert.equal(r.body.usuarios.pro, 1, "el superadmin cuenta como pro");

  const us = await A("usuarios", { cookie: jefe.cookie, q: { q: "ana" } });
  assert.equal(us.body.total, 1);
  const uid = us.body.usuarios[0].uid;

  // POST sin cabecera x-mb-admin → rechazado
  const sin = res(); await admin(req("usuario_plan", { method: "POST", cookie: jefe.cookie, body: { uid, plan: "pro" } }), sin);
  assert.equal(sin.s, 403);
  assert.equal((await A("usuario_plan", { method: "POST", cookie: jefe.cookie, body: { uid, plan: "pro" } })).s, 200);
  assert.equal((await C_("yo", { cookie: ana.cookie })).body.plan, "pro");

  // suspender: exige motivo, corta la sesión y el login
  assert.equal((await A("usuario_bloquear", { method: "POST", cookie: jefe.cookie, body: { uid, bloqueado: true } })).s, 400);
  assert.equal((await A("usuario_bloquear", { method: "POST", cookie: jefe.cookie, body: { uid, bloqueado: true, motivo: "spam" } })).s, 200);
  assert.equal((await C_("listas", { cookie: ana.cookie })).s, 401);
  assert.equal((await C_("yo", { cookie: ana.cookie })).body.sesion, false);
  assert.equal((await entra("ana@ejemplo.es")).loc, "/?cuenta=bloqueado");
  await A("usuario_bloquear", { method: "POST", cookie: jefe.cookie, body: { uid, bloqueado: false } });
  const ana2 = await entra("ana@ejemplo.es");
  assert.equal(ana2.loc, "/?cuenta=ok");
  assert.equal((await C_("listas", { cookie: ana2.cookie })).s, 200);

  // revocar sesiones
  assert.equal((await A("usuario_revocar", { method: "POST", cookie: jefe.cookie, body: { uid } })).s, 200);
  assert.equal((await C_("listas", { cookie: ana2.cookie })).s, 401);

  // no se puede suspender ni borrar a un superadmin
  const uJefe = C.uid("jefe@ejemplo.com");
  assert.equal((await A("usuario_bloquear", { method: "POST", cookie: jefe.cookie, body: { uid: uJefe, bloqueado: true, motivo: "x" } })).s, 400);

  // crear cuenta pro
  const cr = await A("usuario_crear", { method: "POST", cookie: jefe.cookie, body: { email: "nuevo@x.es", plan: "pro" } });
  assert.equal(cr.s, 200); assert.equal(cr.body.existia, false);
  assert.equal((await C.leeUsuario(cr.body.uid)).plan, "pro");

  // borrar: confirma con el email exacto
  assert.equal((await A("usuario_borrar", { method: "POST", cookie: jefe.cookie, body: { uid, confirma: "otro@x.es", motivo: "rgpd" } })).s, 400);
  assert.equal((await A("usuario_borrar", { method: "POST", cookie: jefe.cookie, body: { uid, confirma: "ana@ejemplo.es", motivo: "rgpd" } })).s, 200);
  assert.equal((await A("usuario", { cookie: jefe.cookie, q: { uid } })).s, 404);

  const au = await A("auditoria", { cookie: jefe.cookie });
  assert.deepEqual(new Set(au.body.eventos.map((e) => e.accion)), new Set(["usuario_plan", "usuario_bloquear", "usuario_revocar", "usuario_crear", "usuario_borrar"]));
  assert.ok(au.body.eventos.every((e) => e.admin === "jefe@ejemplo.com"));
  assert.ok(![...mem.entries()].some(([k, v]) => k.startsWith("admin/") && v.includes("ana@ejemplo.es")), "la auditoría va cifrada");

  const si = await A("sistema", { cookie: jefe.cookie });
  assert.equal(si.body.variables.CUENTAS_SECRET, true);
  assert.ok(!JSON.stringify(si.body).includes("a".repeat(32)), "nunca expone valores");
});

test("coste estimado por modelo", () => {
  assert.equal(coste({ "anthropic/claude-sonnet-5.5": { in: 1e6, out: 1e6 }, "claude-haiku-5-5": { in: 1e6, out: 0 } }), 19);
});

test("códigos Pro: crear, canjear, límites y desactivar", async () => {
  const jefe = await entra("jefe@ejemplo.com"), eva = await entra("eva@ejemplo.es"), leo = await entra("leo@ejemplo.es");
  const c = await A("codigo_crear", { method: "POST", cookie: jefe.cookie, body: { codigo: "verano-26", dias: 30, max: 1, nota: "prueba" } });
  assert.equal(c.s, 200); assert.equal(c.body.codigo.codigo, "VERANO-26");
  assert.equal((await A("codigo_crear", { method: "POST", cookie: jefe.cookie, body: { codigo: "VERANO-26" } })).s, 409);
  assert.equal((await C_("canjear", { method: "POST", cookie: eva.cookie, body: { codigo: "nope" } })).s, 404);
  const ok = await C_("canjear", { method: "POST", cookie: eva.cookie, body: { codigo: " verano-26 " } });
  assert.equal(ok.s, 200); assert.ok(Date.parse(ok.body.pro_hasta) > Date.now() + 29 * 864e5);
  const yo = await C_("yo", { cookie: eva.cookie });
  assert.equal(yo.body.plan, "pro"); assert.ok(yo.body.pro_hasta);
  assert.equal((await C_("canjear", { method: "POST", cookie: leo.cookie, body: { codigo: "VERANO-26" } })).s, 400, "agotado");
  // caducidad del Pro temporal
  const u = C.uid("eva@ejemplo.es"), usr = await C.leeUsuario(u);
  usr.pro_hasta = new Date(Date.now() - 1000).toISOString(); await C.guardaUsuario(u, usr);
  assert.equal((await C_("yo", { cookie: eva.cookie })).body.plan, "gratis");
  // desactivar
  const c2 = await A("codigo_crear", { method: "POST", cookie: jefe.cookie, body: { dias: 0, max: 5 } });
  assert.match(c2.body.codigo.codigo, /^MOJO-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  await A("codigo_estado", { method: "POST", cookie: jefe.cookie, body: { id: c2.body.codigo.id, activo: false } });
  assert.equal((await C_("canjear", { method: "POST", cookie: leo.cookie, body: { codigo: c2.body.codigo.codigo } })).s, 404);
  const pl = await A("planes", { cookie: jefe.cookie });
  assert.equal(pl.body.codigos.length, 2); assert.equal(pl.body.stripe.activo, false);
});

test("Stripe: checkout y webhook verificado contra la API", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_x"; process.env.STRIPE_PRICE_PRO = "price_1";
  const P = await import("../lib/pagos.js");
  const leo = await entra("leo@ejemplo.es"), u = C.uid("leo@ejemplo.es");
  let estado = "active"; const llamadas = [];
  P.usaFetch(async (url, o) => {
    llamadas.push([o.method, url.replace("https://api.stripe.com/v1", ""), o.body || ""]);
    const r = (j) => ({ ok: true, status: 200, json: async () => j });
    if (url.endsWith("/checkout/sessions")) return r({ url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    if (url.includes("/events/evt_")) return r({ type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: "cus_1", status: estado, metadata: { uid: u }, items: { data: [{ current_period_end: 1893456000 }] } } } });
    return { ok: false, status: 404, json: async () => ({ error: { message: "no" } }) };
  });
  const pg = await C_("pagar", { method: "POST", cookie: leo.cookie });
  assert.equal(pg.body.url, "https://checkout.stripe.com/c/pay/cs_test_1");
  assert.match(llamadas[0][2], /client_reference_id=/); assert.match(llamadas[0][2], /subscription_data%5Bmetadata%5D%5Buid%5D=/);
  // el cuerpo del webhook no se cree: solo se usa el id
  const w = await C_("stripe_webhook", { method: "POST", body: { id: "evt_1", type: "customer.subscription.updated", data: { object: { status: "active", metadata: { uid: "otro" } } } } });
  assert.equal(w.s, 200); assert.equal(w.body.aplicado, true);
  let yo = await C_("yo", { cookie: leo.cookie });
  assert.equal(yo.body.plan, "pro"); assert.equal(yo.body.suscripcion.estado, "active"); assert.equal(yo.body.suscripcion.hasta, "2030-01-01T00:00:00.000Z");
  estado = "canceled";
  await C_("stripe_webhook", { method: "POST", body: { id: "evt_2" } });
  yo = await C_("yo", { cookie: leo.cookie });
  assert.equal(yo.body.plan, "gratis");
  assert.equal((await C_("stripe_webhook", { method: "POST", body: { id: "malo" } })).body.ok, false);
  delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_PRICE_PRO;
});

test("alertas: detecta configuración peligrosa sin enviar", async () => {
  const { ejecutaAlertas } = await import("../lib/alertas.js");
  const r = await ejecutaAlertas({ enviar: false });
  assert.ok(r.avisos.some((a) => /BLOB_READ_WRITE_TOKEN/.test(a.texto)));
  assert.ok(r.avisos.some((a) => /RESEND_API_KEY/.test(a.texto)));
  assert.deepEqual(r.destinatarios, ["jefe@ejemplo.com"]);
});
