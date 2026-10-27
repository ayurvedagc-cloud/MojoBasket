import { send, CP_DEFECTO } from "../lib/api.js";
import * as mc from "../lib/mercadona.js";
import * as spar from "../lib/spar.js";
import * as hd from "../lib/hiperdino.js";
import * as lidl from "../lib/lidl.js";
import * as lp from "../lib/lidlplus.js";
// GET /api/salud?cp=35100 → diagnóstico rápido de cada fuente (sin caché)
export default async function handler(req, res) {
  const cp = (req.query && req.query.cp) || CP_DEFECTO;
  const out = { cp, fecha: new Date().toISOString() };
  try {
    const { wh, fuente } = await mc.warehouse(cp);
    const cats = await mc.categorias(wh);
    const sub = cats[0]?.sub[0];
    const prods = sub ? await mc.subcategoria(wh, sub.id, cp) : [];
    out.mercadona = { ok: prods.length > 0, wh, fuente, categorias: cats.length, muestra: prods.slice(0, 3) };
  } catch (e) { out.mercadona = { ok: false, error: String(e.message || e) }; }
  try {
    const r = await spar.categoria("009", { cp, maxPaginas: 4 });
    out.spar_gc = { ok: r.productos.length > 0, paginas: r.paginas, productos: r.productos.length, muestra: r.productos.slice(0, 3), errores: r.errores };
  } catch (e) { out.spar_gc = { ok: false, error: String(e.message || e) }; }
  try {
    const r = await hd.categoria("alimentacion/legumbres-cocidas", { cp, maxPaginas: 1, lote: 1 });
    out.hiperdino = { ok: r.productos.length > 0, zona: hd.ZONA, productos: r.productos.length, muestra: r.productos.slice(0, 3) };
  } catch (e) { out.hiperdino = { ok: false, error: String(e.message || e) }; }
  try {
    const l = await lidl.listaFolletos();
    out.lidl = { ok: l.length > 0, folletos: l.map((f) => `${f.nombre} ${f.titulo}`) };
  } catch (e) { out.lidl = { ok: false, error: String(e.message || e) }; }
  try {
    const r = await lp.ofertas(cp);
    out.lidl_plus = { ok: r.productos.length > 0, tienda: r.tienda, ofertas: r.productos.length, muestra: r.productos.slice(0, 3) };
  } catch (e) { out.lidl_plus = { ok: false, error: String(e.message || e) }; }
  const ok = ["mercadona", "spar_gc", "hiperdino", "lidl_plus"].every((k) => out[k]?.ok);
  send(res, ok ? 200 : 503, out, { cache: false });
}
