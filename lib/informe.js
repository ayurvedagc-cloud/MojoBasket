// GET /api/informe?key=INFORME_KEY[&cadena=spar_gc][&desde=AAAA-MM-DD][&hasta=AAAA-MM-DD][&uso=1]
// Indicadores del piloto por cadena: listas, cesta asignada (€ y media), ofertas usadas, clics, carrito y zonas.
import { send } from "./api.js";
import { eventos, agrega, dia, usoDia } from "./metricas.js";
import { lee, hayBlob } from "./store.js";
import { claveOk } from "./cuenta.js";

export async function informe(req, res) {
  const q = req.query || {};
  if (!claveOk(req)) return send(res, 401, { ok: false, error: "no autorizado" }, { cache: false });
  if (!hayBlob()) return send(res, 500, { ok: false, error: "Falta BLOB_READ_WRITE_TOKEN" }, { cache: false });
  const hasta = /^\d{4}-\d{2}-\d{2}$/.test(q.hasta || "") ? q.hasta : dia();
  const d0 = new Date(hasta + "T00:00:00Z"); d0.setUTCDate(d0.getUTCDate() - 29);
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(q.desde || "") ? q.desde : dia(d0);
  try {
    const evs = await eventos(desde, hasta);
    const out = { ok: true, desde, hasta, eventos: evs.length, ...agrega(evs, q.cadena || null) };
    if (q.uso === "1") {
      out.uso_claude = [];
      for (let d = new Date(desde + "T00:00:00Z"); dia(d) <= hasta; d.setUTCDate(d.getUTCDate() + 1)) {
        const u = await usoDia(dia(d), { fresco: true }).catch(() => null);
        if (u?.llamadas) out.uso_claude.push(u);
      }
    }
    return send(res, 200, out, { cache: false });
  } catch (e) {
    console.error(e);
    return send(res, 502, { ok: false, error: String(e.message || e) }, { cache: false });
  }
}
