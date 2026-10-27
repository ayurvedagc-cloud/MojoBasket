// GET /api/nutricion?cp=35100&p=mercadona:4240|spar_gc:9001199|hiperdino:11730~HiperDino garbanzos cocidos 580 g
// → { "cadena:id": {nutriscore, nova, alergenos[], trazas[], vegano, vegetariano, kcal_100, proteinas_100, ...} | null }
// Fuente: Open Food Facts (ODbL). Con EAN (SPAR, Mercadona) o por nombre (≥70 % de coincidencia) si no lo hay.
import { wrap, CP_DEFECTO } from "../lib/api.js";
import { nutricion } from "../lib/off.js";

export default wrap(async (q) => {
  const cp = q.cp || CP_DEFECTO;
  const items = String(q.p || "").split("|").map((s) => s.trim()).filter(Boolean).slice(0, 60).map((s) => {
    const [ref, nombre] = s.split("~");
    const i = ref.indexOf(":");
    return { cadena: ref.slice(0, i), id: ref.slice(i + 1), nombre: nombre || null };
  }).filter((x) => x.cadena && x.id);
  if (!items.length) throw Object.assign(new Error("Falta p=cadena:id|…"), { status: 400 });
  const datos = await nutricion(items, { cp });
  return { cp, fuente: "Open Food Facts (ODbL)", encontrados: Object.values(datos).filter(Boolean).length, de: items.length, datos };
});
