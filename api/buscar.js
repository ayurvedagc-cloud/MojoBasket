// GET /api/buscar?cadena=mercadona|spar_gc&cp=35100&q=garbanzos cocidos|calabacin|jengibre&n=5
// Búsqueda por lotes (separador "|"): por cada consulta, los n mejores (relevancia → €/ud), formato compacto.
import { wrap, cadenasDe, productosDe, filtra, CP_DEFECTO } from "../lib/api.js";

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
  const { productos, meta } = await productosDe(cadena, { cp });
  const resultados = {};
  for (const c of consultas) resultados[c] = filtra(productos, { q: c, orden: "precio_ud", limit: n }).productos.map(compacto);
  return { cp, cadena, actualizado: meta.actualizado || null, resultados };
});
