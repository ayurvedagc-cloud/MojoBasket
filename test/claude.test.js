import { test } from "node:test";
import assert from "node:assert/strict";

process.env.VERCEL_OIDC_TOKEN = "x";
const llamadas = [];
globalThis.fetch = async (u, o) => {
  if (String(u).endsWith("/v1/models")) return new Response(JSON.stringify({ data: ["anthropic/claude-sonnet-5.5", "anthropic/claude-sonnet-5.5-batch", "anthropic/claude-haiku-5.5", "anthropic/claude-haiku-4.5", "openai/gpt"].map((id) => ({ id })) }));
  const m = JSON.parse(o.body).model; llamadas.push(m);
  return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
};
const { default: h } = await import("../api/claude.js");
const res = () => ({ s: 0, j: null, status(c) { this.s = c; return this; }, json(j) { this.j = j; }, setHeader() {} });

test("diag usa Sonnet por defecto y Haiku en rápido", async () => {
  const a = res(); await h({ method: "GET", headers: {}, query: { diag: "2" } }, a);
  assert.equal(a.j.model, "anthropic/claude-sonnet-5.5"); assert.equal(a.j.prueba, 200);
  const b = res(); await h({ method: "GET", headers: {}, query: { diag: "2", tier: "rapido" } }, b);
  assert.equal(b.j.model, "anthropic/claude-haiku-5.5");
  assert.ok(!llamadas.some((m) => m.endsWith("-batch")));
});
