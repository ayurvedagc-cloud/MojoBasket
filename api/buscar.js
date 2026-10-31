// GET /api/buscar?cadena=mercadona|spar_gc&cp=35100&q=garbanzos cocidos|calabacin|jengibre&n=5
// Búsqueda por lotes (separador "|"): por cada consulta, los n mejores (relevancia → €/ud), formato compacto.
import { wrap, cadenasDe, productosDe, filtra, CP_DEFECTO } from "../lib/api.js";
import * as mc from "../lib/mercadona.js";
import { pool } from "../lib/util.js";

export const compacto = (p) => ({
  id: p.id, cadena: p.cadena, nombre: p.nombre, formato: p.formato, precio: p.precio,
  precio_ud: p.precio_ud, ud: p.ud, oferta: p.oferta, precio_antes: p.precio_antes, promo: p.promo,
  categoria: p.categoria, url: p.url,
});

export default wrap(async (q) => {
  const cp = q.cp || CP_DEFECTO;
  const [cadena] = cadenasDe({ cadena: q.cadena || "mercadona" });
  const consultas = String(q.q || "").split("|").map((s) => s.trim()).filter(Boolean).slice(0, 80);
  if (!consultas.length) throw Object.assign(new Error("Falta q (separa varias con |)"), { status: 400 });
  const n = Math.min(+q.n || 5, 15);
  const resultados = {};
  let snap;
  try { snap = await productosDe(cadena, { cp }); } catch (e) {
    if (cadena !== "mercadona") throw e;
    // Sin instantánea (cron pendiente o Blob caído): búsqueda en vivo consulta a consulta.
    console.warn("buscar: mercadona en vivo —", e.message);
    const res = await pool(consultas, 8, async (c) => {
      // Orden del buscador de Mercadona (entiende sinónimos: «leche de avena» → «bebida de avena»).
      return (await mc.busca(cp, c, n)).map(compacto);
    });
    const fallos = res.filter((x) => x?.__error);
    if (fallos.length === consultas.length) throw Object.assign(new Error(`Mercadona en vivo: ${fallos[0].__error}`), { status: 502 });
    consultas.forEach((c, i) => { resultados[c] = Array.isArray(res[i]) ? res[i] : []; });
    return { cp, cadena, fuente: "vivo", actualizado: new Date().toISOString(), resultados };
  }
  for (const c of consultas) resultados[c] = filtra(snap.productos, { q: c, orden: "precio_ud", limit: n }).productos.map(compacto);
  return { cp, cadena, actualizado: snap.meta.actualizado || null, resultados };
});
