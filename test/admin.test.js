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

const res = () => ({ s: 0, h: {}, body: null, status(c) { this.s = c; return this; }, setHeader(k, v) { this.h[k.toLowerCase()] = v; }, send(b) { this.body = JSON.parse(b); }, end() {} });
const req = (accion, { method = "GET", body, cookie, q = {}, h = {} } = {}) => ({ method, body, query: { accion, ...q }, headers: { host: "localhost:3000", cookie: cookie || "", "x-forwarded-for": "9.9.9.9", ...h } });
const C_ = async (...a) => { const r = res(); await cuenta(req(...a), r); return r; };
const A = async (accion, o = {}) => { const r = res(); await admin(req(accion, { ...o, h: o.method === "POST" ? { "x-mb-admin": "1", origin: "http://localhost:3000", ...(o.h || {}) } : o.h }), r); return r; };
async function entra(email) {
  const e = await C_("enlace", { method: "POST", body: { email } });
  const t = new URL(e.body.dev_url).searchParams.get("t");
  const r = await C_("entrar", { q: { t } });
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
