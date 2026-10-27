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
