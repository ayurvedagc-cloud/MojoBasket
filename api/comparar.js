import { wrap, CADENAS, productosDe, filtra, CP_DEFECTO } from "../lib/api.js";
import { relevancia } from "../lib/util.js";
// GET /api/comparar?q=garbanzos cocidos&cp=35100&n=3 → los n más baratos por €/ud en cada cadena
export default wrap(async (q) => {
  if (!q.q) throw Object.assign(new Error("Falta q"), { status: 400 });
  const cp = q.cp || CP_DEFECTO, n = Math.min(+q.n || 3, 20);
  const resultado = {};
  for (const c of CADENAS) {
    try {
      const r = await productosDe(c, { cp });
      resultado[c] = filtra(r.productos, { q: q.q, orden: "precio_ud", limit: n });
    } catch (e) { resultado[c] = { error: String(e.message || e) }; }
  }
  const cands = Object.entries(resultado).flatMap(([, v]) => v.productos || []);
  const top = Math.max(0, ...cands.map((p) => relevancia(p, q.q)));
  const mejor = cands.filter((p) => relevancia(p, q.q) === top).sort((a, b) => (a.precio_ud ?? 1e9) - (b.precio_ud ?? 1e9))[0] || null;
  return { cp, q: q.q, mejor, resultado };
});
