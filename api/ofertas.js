import { wrap, cadenasDe, productosDe, filtra, CP_DEFECTO } from "../lib/api.js";
// GET /api/ofertas?cadena=todas&cp=35100&q=&limit=300  → solo productos rebajados, ordenados por % descuento
export default wrap(async (q) => {
  const cp = q.cp || CP_DEFECTO;
  const fuentes = {};
  let todos = [];
  for (const c of cadenasDe(q)) {
    try {
      const r = await productosDe(c, { cp, cat: q.cat });
      fuentes[c] = { ok: true, n: r.productos.length, ...r.meta };
      todos = todos.concat(r.productos);
    } catch (e) { fuentes[c] = { ok: false, error: String(e.message || e) }; }
  }
  return { cp, fuentes, ...filtra(todos, { ...q, oferta: "1", orden: q.orden || "descuento", limit: q.limit || 300 }) };
});
