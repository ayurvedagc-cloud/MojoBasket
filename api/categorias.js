import { wrap, CP_DEFECTO } from "../lib/api.js";
import * as mc from "../lib/mercadona.js";
import { CATEGORIAS } from "../lib/spar.js";
import * as hd from "../lib/hiperdino.js";
// GET /api/categorias?cp=35100
export default wrap(async (q) => {
  const cp = q.cp || CP_DEFECTO;
  let mercadona;
  try { const { wh } = await mc.warehouse(cp); mercadona = { wh, categorias: await mc.categorias(wh) }; }
  catch (e) { mercadona = { error: String(e.message || e) }; }
  return { cp, mercadona, spar_gc: { categorias: CATEGORIAS.map(({ codigo, nombre }) => ({ id: codigo, nombre })) },
    hiperdino: { zona: hd.ZONA, categorias: hd.CATEGORIAS.map(({ codigo, nombre }) => ({ id: codigo, nombre })) } };
});
