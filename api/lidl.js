// GET /api/lidl?cp=35100[&tienda=CS0977][&q=platano][&todas=1] → ofertas de la tienda Lidl Plus del CP (Canarias = país CS)
import { wrap, filtra, CP_DEFECTO } from "../lib/api.js";
import * as lp from "../lib/lidlplus.js";

export default wrap(async (q) => {
  const cp = q.cp || CP_DEFECTO;
  if (q.tiendas === "1") return { cp, pais: lp.paisDeCP(cp), tiendas: await lp.tiendas(lp.paisDeCP(cp)) };
  const r = await lp.ofertas(cp, { tienda: q.tienda });
  const base = q.todas === "1" ? r.productos : r.productos.filter((p) => p.vigente);
  const f = filtra(base, { q: q.q, orden: q.orden || (q.q ? "precio_ud" : "descuento"), limit: q.limit || 300 });
  const fechas = base.map((p) => [p.desde, p.hasta]).filter(([a, b]) => a && b);
  return { cp, cadena: "lidl", tienda: r.tienda, desde: fechas.length ? fechas.map((x) => x[0]).sort()[0] : null, hasta: fechas.length ? fechas.map((x) => x[1]).sort().pop() : null, ...f };
});
