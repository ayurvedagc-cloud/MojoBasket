import { test } from "node:test";
import assert from "node:assert/strict";

process.env.CUENTAS_SECRET = "s".repeat(32);
process.env.CUENTAS_DEV = "1";
process.env.LISTAS_ANON_SEMANA = "1";
process.env.LISTAS_GRATIS_SEMANA = "2";
process.env.HISTORIAL_GRATIS = "2";
process.env.INFORME_KEY = "adm";

const C = await import("../lib/cuenta.js");
const mem = new Map();
C.usaBlob({
  async put(p, t) { mem.set(p, t); }, async get(p) { return mem.get(p) ?? null; },
  async del(p) { mem.delete(p); }, async delPrefix(pre) { for (const k of [...mem.keys()]) if (k.startsWith(pre)) mem.delete(k); },
});
const { cuenta } = await import("../lib/cuentaApi.js");

const res = () => ({ s: 0, h: {}, body: null, status(c) { this.s = c; return this; }, setHeader(k, v) { this.h[k.toLowerCase()] = v; }, send(b) { this.body = JSON.parse(b); }, end() {} });
const req = (accion, { method = "GET", body, cookie, q = {}, ip = "1.1.1.1" } = {}) => ({ method, body, query: { accion, ...q }, headers: { host: "localhost:3000", cookie: cookie || "", "x-forwarded-for": ip } });
const llama = async (...a) => { const r = res(); await cuenta(req(...a), r); return r; };

test("tokens, cifrado y semana", () => {
  const t = C.firma({ t: "l", e: "a@b.es" }, 60);
  assert.equal(C.verifica(t, "l").e, "a@b.es");
  assert.equal(C.verifica(t, "s"), null);
  assert.equal(C.verifica(t.slice(0, -2) + "xx", "l"), null);
  assert.deepEqual(C.descifra(C.cifra({ x: [1, "ñ"] })), { x: [1, "ñ"] });
  assert.equal(C.semana(new Date("2026-10-28T12:00:00Z")), "2026-W44");
  assert.equal(C.renueva(new Date("2026-10-28T12:00:00Z")), "2026-11-02");
  assert.equal(C.renueva(new Date("2026-11-02T12:00:00Z")), "2026-11-09");
});

test("flujo completo de cuenta", async () => {
  assert.equal((await llama("enlace", { method: "POST", body: { email: "malo" } })).s, 400);
  const e = await llama("enlace", { method: "POST", body: { email: " Ana@Ejemplo.ES " } });
  assert.equal(e.s, 200);
  const t = new URL(e.body.dev_url).searchParams.get("t");
  const en = await llama("entrar", { q: { t } });
  assert.equal(en.s, 302); assert.equal(en.h.location, "/?cuenta=nueva");
  const cookie = en.h["set-cookie"].split(";")[0];
  assert.match(cookie, /^mb_s=/);
  assert.equal((await llama("entrar", { q: { t } })).h.location, "/?cuenta=usado");
  assert.equal((await llama("entrar", { q: { t: "x.y" } })).h.location, "/?cuenta=caducado");

  const yo = await llama("yo", { cookie });
  assert.equal(yo.body.sesion, true); assert.equal(yo.body.email, "ana@ejemplo.es"); assert.equal(yo.body.cuota.limite, 2);
  assert.ok(![...mem.values()].some((v) => v.includes("ana@ejemplo.es")), "el email no se guarda en claro");

  const plan = (n) => ({ fecha: `2026-10-2${n}T10:00:00Z`, super: "SPAR", superIds: ["spar"], listas: [{ id: "u", total: 30 + n }], activa: "u", recetas: [{ nombre: "Potaje " + n }] });
  const g1 = await llama("guardar", { method: "POST", body: { plan: plan(1) }, cookie });
  await llama("guardar", { method: "POST", body: { plan: plan(2) }, cookie });
  const g3 = await llama("guardar", { method: "POST", body: { plan: plan(3) }, cookie });
  assert.equal(g3.body.recortadas, 1);
  const ls = await llama("listas", { cookie });
  assert.deepEqual(ls.body.listas.map((x) => x.total), [33, 32]);
  assert.equal(ls.body.listas[0].recetas[0], "Potaje 3");
  assert.equal((await llama("lista", { cookie, q: { id: g1.body.id } })).s, 404, "la más antigua se recorta");
  const l3 = await llama("lista", { cookie, q: { id: g3.body.id } });
  assert.equal(l3.body.plan.nubeId, g3.body.id);
  // re-guardar la misma lista la actualiza, no la duplica
  await llama("guardar", { method: "POST", body: { plan: { ...l3.body.plan, listas: [{ id: "u", total: 99 }] } }, cookie });
  assert.deepEqual((await llama("listas", { cookie })).body.listas.map((x) => x.total), [99, 32]);

  assert.equal((await llama("listas")).s, 401);
  const ex = await llama("exportar", { cookie });
  assert.equal(ex.body.usuario.email, "ana@ejemplo.es"); assert.equal(ex.body.listas.length, 2);

  assert.equal((await llama("plan", { method: "POST", body: { email: "ana@ejemplo.es", plan: "pro" }, q: { key: "no" } })).s, 401);
  assert.equal((await llama("plan", { method: "POST", body: { email: "ana@ejemplo.es", plan: "pro" }, q: { key: "adm" } })).body.plan, "pro");
  assert.equal((await llama("yo", { cookie })).body.cuota.limite, null);

  const b = await llama("borrar_cuenta", { method: "POST", cookie });
  assert.equal(b.s, 200); assert.match(b.h["set-cookie"], /Max-Age=0/);
  assert.ok(![...mem.keys()].some((k) => k.startsWith("cuentas/")));
  assert.equal((await llama("yo", { cookie })).body.sesion, false);
});

test("cuota en /api/claude: anónimo, pase y devolución", async () => {
  process.env.VERCEL_OIDC_TOKEN = "x";
  let falla = false;
  globalThis.fetch = async (u, o) => {
    if (String(u).endsWith("/v1/models")) return new Response(JSON.stringify({ data: [{ id: "anthropic/claude-sonnet-5.5" }, { id: "anthropic/claude-haiku-5.5" }] }));
    if (falla) return new Response(JSON.stringify({ error: { message: "caído" } }), { status: 500 });
    const sse = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n';
    return new Response(sse, { status: 200 });
  };
  const { default: h } = await import("../api/claude.js");
  const r2 = () => ({ s: 0, h: {}, j: null, out: "", status(c) { this.s = c; return this; }, json(j) { this.j = j; }, setHeader(k, v) { this.h[k.toLowerCase()] = v; }, writeHead(c, hh) { this.s = c; Object.assign(this.h, hh); }, write(t) { this.out += t; }, end() {} });
  const pide = async (body, ip = "9.9.9.9", cookie = "") => { const r = r2(); await h({ method: "POST", headers: { "x-forwarded-for": ip, cookie }, body: { prompt: "hola", ...body }, query: {} }, r); return r; };

  assert.equal((await pide({ tier: "rapido" })).j.code, "pase", "rápido sin pase");
  falla = true;
  assert.equal((await pide({})).s, 502);
  await new Promise((r) => setTimeout(r, 20));
  falla = false;
  const a = await pide({});
  assert.equal(a.s, 200, "la cuota fallida se devolvió"); assert.equal(a.out, "ok");
  const pase = a.h["x-mb-pase"]; assert.ok(pase);
  assert.equal((await pide({ tier: "rapido", pase })).s, 200);
  const b = await pide({});
  assert.equal(b.s, 402); assert.equal(b.j.code, "cuota"); assert.equal(b.j.sesion, false);
  assert.equal((await pide({}, "8.8.8.8")).s, 200, "otra IP tiene su propia cuota");
});

test("sin proveedor de email no se bloquea a los anónimos", async () => {
  delete process.env.CUENTAS_DEV; delete process.env.RESEND_API_KEY;
  const r = { headers: { "x-forwarded-for": "7.7.7.7" } };
  assert.equal((await C.consumeLista(r)).ok, true);
  assert.equal((await C.consumeLista(r)).ok, true, "límite 1 superado pero sin email no se bloquea");
  const y = res(); await cuenta({ method: "GET", query: { accion: "yo" }, headers: { host: "x" } }, y);
  assert.equal(y.body.entrar, false);
  process.env.CUENTAS_DEV = "1";
  assert.equal((await C.consumeLista(r)).ok, false);
});
