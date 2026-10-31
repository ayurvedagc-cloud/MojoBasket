import { test } from "node:test";
import assert from "node:assert/strict";
import { limpia, agrega } from "../lib/metricas.js";

test("limpia descarta tipos desconocidos y campos extra", () => {
  assert.equal(limpia({ tipo: "otro" }), null);
  const e = limpia({ tipo: "lista", supers: ["mercadona", "<x>"], lista_tipo: "mix", total: "18.09", ip: "1.2.3.4", por_cadena: { spar: { eur: 3.67, items: 2, ofertas: 2 }, "bad key": {} } });
  assert.deepEqual(e.supers, ["mercadona"]);
  assert.equal(e.combinada, true);
  assert.equal(e.total, 18.09);
  assert.equal(e.ip, undefined);
  assert.deepEqual(Object.keys(e.por_cadena), ["spar"]);
});

test("agrega indicadores por cadena", () => {
  const evs = [
    limpia({ tipo: "lista", supers: ["spar", "hiperdino"], lista_tipo: "mix", total: 18, zona: "gps", por_cadena: { spar: { eur: 4, items: 2, ofertas: 1 }, hiperdino: { eur: 14, items: 6, ofertas: 3 } } }),
    limpia({ tipo: "lista", supers: ["spar"], lista_tipo: "super", total: 20, zona: "San Fernando", por_cadena: { spar: { eur: 20, items: 9, ofertas: 2 } } }),
    limpia({ tipo: "clic", accion: "ver", cadena: "spar" }),
    limpia({ tipo: "clic", accion: "carrito", cadena: "spar" }),
    limpia({ tipo: "copiar", cadena: "hiperdino" }),
  ];
  const r = agrega(evs, "spar");
  assert.equal(r.listas, 2); assert.equal(r.cesta_eur, 24); assert.equal(r.cesta_media, 12);
  assert.equal(r.ofertas_usadas, 3); assert.equal(r.clics, 1); assert.equal(r.carrito, 1);
  assert.deepEqual(r.zonas, { gps: 1, "San Fernando": 1 });
  assert.equal(agrega(evs).total.combinadas, 1);
  assert.equal(agrega(evs).por_cadena.hiperdino.copiar, 1);
});

test("uso de Claude: nombres por llamada y suma sin carreras", async () => {
  const { nombreUso, sumaNombres } = await import("../lib/metricas.js");
  const d = new Date("2026-10-28T04:45:33.123Z");
  const a = nombreUso("anthropic/claude-sonnet-5.5", 9496, 23855, d), b = nombreUso("anthropic/claude-haiku-5.5", 5528, 5136, d), c = nombreUso("anthropic/claude-haiku-5.5", 5157, 5196, d);
  assert.match(a, /^uso\/2026-10-28\/044533123-[a-z0-9]{1,4}_anthropic~claude-sonnet-5\.5_9496_23855\.json$/);
  const u = sumaNombres("2026-10-28", [a, b, c], { modelos: { "anthropic/claude-sonnet-5.5": { llamadas: 4, in: 9390, out: 63075 } } });
  assert.equal(u.llamadas, 7);
  assert.deepEqual(u.modelos["anthropic/claude-haiku-5.5"], { llamadas: 2, in: 10685, out: 10332 });
  assert.equal(u.modelos["anthropic/claude-sonnet-5.5"].llamadas, 5);
});

test("lotes: nombre con recuentos, recuento sin descargar y uso agrupado", async () => {
  const { nombreLote, cuentaNombre, agrupaUso, nombreUso, sumaNombres } = await import("../lib/metricas.js");
  const evs = [limpia({ tipo: "lista", supers: ["mercadona"] }), limpia({ tipo: "clic", cadena: "spar" }), limpia({ tipo: "clic", cadena: "spar" }), limpia({ tipo: "copiar" })];
  const p = nombreLote("2026-10-31", evs, new Date("2026-10-31T03:41:05Z"));
  assert.match(p, /^ev\/2026-10-31\/034105-lote-L1-C2-P1-H0-[a-z0-9]{1,4}\.json$/);
  const c = { lista: 0, clic: 0, copiar: 0, claude_chrome: 0 };
  cuentaNombre(p, c); cuentaNombre("ev/2026-10-30/120000-lista-ab12.json", c);
  assert.deepEqual(c, { lista: 2, clic: 2, copiar: 1, claude_chrome: 0 });
  const g = agrupaUso([{ d: "2026-10-31", model: "m/a", in: 10, out: 5 }, { d: "2026-10-31", model: "m/a", in: 1, out: 2 }, { d: "2026-10-31", model: "m/b", in: 3, out: 3 }]);
  assert.equal(g.length, 2);
  const nombres = g.map((a) => nombreUso(a.model, a.in, a.out, new Date("2026-10-31T03:00:00Z"), a.n));
  const u = sumaNombres("2026-10-31", nombres);
  assert.equal(u.llamadas, 3);
  assert.deepEqual(u.modelos["m/a"], { llamadas: 2, in: 11, out: 7 });
});
