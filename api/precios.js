import { wrap, cadenasDe, productosDe, filtra, CP_DEFECTO } from "../lib/api.js";
// GET /api/precios?cadena=mercadona|spar_gc|todas&cp=35100&q=garbanzos&cat=&oferta=1&orden=precio_ud|precio|descuento&limit=200
export default wrap(async (q) => {
  const cp = q.cp || CP_DEFECTO;
  const cadenas = cadenasDe(q);
  const fuentes = {};
  let todos = [];
  for (const c of cadenas) {
    try {
      const r = await productosDe(c, { cp, cat: cadenas.length === 1 ? q.cat : null });
      fuentes[c] = { ok: true, n: r.productos.length, ...r.meta };
      todos = todos.concat(r.productos);
    } catch (e) { fuentes[c] = { ok: false, error: String(e.message || e) }; }
  }
  return { cp, fuentes, ...filtra(todos, q) };
});
