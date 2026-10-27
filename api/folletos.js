// GET /api/folletos?cadena=lidl[&q=aguacate]  → folletos de alimentación vigentes y próximos (texto por página)
// Lidl no publica precios de alimentación online; el folleto es la única fuente oficial de precios/ofertas.
import { wrap } from "../lib/api.js";
import * as lidl from "../lib/lidl.js";
import { norm } from "../lib/util.js";

export default wrap(async (q) => {
  if ((q.cadena || "lidl") !== "lidl") throw Object.assign(new Error("cadena=lidl"), { status: 400 });
  const r = await lidl.folletosVigentes();
  const t = q.q ? norm(q.q).split(/\s+/).filter(Boolean) : null;
  const filtra = (f) => (t ? { ...f, paginas: f.paginas.filter((p) => t.some((w) => norm(`${p.texto} ${p.descripcion}`).includes(w))) } : f);
  return {
    cadena: "lidl",
    aviso: "Folleto nacional de lidl.es (región 0). Precios orientativos para Canarias: pueden variar en tienda.",
    vigentes: r.vigentes.map(filtra), proximos: r.proximos.map(filtra), errores: r.errores,
  };
});
