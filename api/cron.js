// GET /api/cron?cadena=mercadona|spar_gc|hiperdino&cp=35100[&paso=N]   ·   GET /api/cron?tarea=alertas (email diario a los SuperAdmin)
// Recolector por tramos (categoría raíz) con auto-encadenado (<60 s por invocación). Vercel corta las cadenas de
// autollamadas (508 Loop Detected) hacia el 4.º salto, así que el progreso se guarda en Blob (progreso.json) y varios
// disparos de cron al día reanudan donde se quedó; cuando el catálogo del día está completo, los siguientes no hacen nada.
// Guarda en Blob:
//   snap/{cadena}/{cp}/cat-{id}.json  → tramo        snap/{cadena}/{cp}/catalogo.json → fusión final
//   hist/{cadena}/{cp}/{YYYY-MM-DD}.json → histórico compacto {id: precio | [precio, antes]}
import { waitUntil } from "@vercel/functions";
import * as mc from "../lib/mercadona.js";
import * as spar from "../lib/spar.js";
import * as hd from "../lib/hiperdino.js";
import { guarda, lee, ruta, guardaHistorico, hayBlob } from "../lib/store.js";
import { send, CP_DEFECTO } from "../lib/api.js";
import { limpiaCuotas } from "../lib/cuenta.js";
import { ejecutaAlertas } from "../lib/alertas.js";

const PRESUPUESTO_MS = 30000;

async function plan(cadena, cp) {
  if (cadena === "mercadona") {
    const { wh } = await mc.warehouse(cp);
    const cats = await mc.categorias(wh);
    return { wh, unidades: cats.map((c) => ({ id: String(c.id), nombre: c.nombre })), recoge: (u) => mc.categoriaTop(wh, u.id, cp) };
  }
  if (cadena === "spar_gc") {
    return { wh: null, unidades: spar.CATEGORIAS.map((c) => ({ id: c.codigo, nombre: c.nombre })), recoge: (u) => spar.categoria(u.id, { cp }) };
  }
  if (cadena === "hiperdino") {
    return { wh: hd.ZONA, unidades: hd.CATEGORIAS.map((c) => ({ id: c.codigo, nombre: c.nombre })), recoge: (u) => hd.categoria(u.id, { cp }) };
  }
  throw Object.assign(new Error("cadena=mercadona|spar_gc|hiperdino"), { status: 400 });
}

export default async function handler(req, res) {
  const S = process.env.CRON_SECRET;
  const auth = req.headers["authorization"] || (req.query?.key ? `Bearer ${req.query.key}` : "");
  if (!S || auth !== `Bearer ${S}`) return send(res, 401, { ok: false, error: "no autorizado" }, { cache: false });
  if (!hayBlob()) return send(res, 500, { ok: false, error: "Falta BLOB_READ_WRITE_TOKEN" }, { cache: false });
  const q = req.query || {};
  if (q.tarea === "alertas") {
    try { const r = await ejecutaAlertas({ base: `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || req.headers.host}` }); return send(res, 200, { ok: true, avisos: r.avisos.length, enviado: r.enviado }, { cache: false }); }
    catch (e) { console.error("[alertas]", e); return send(res, 500, { ok: false, error: String(e.message || e) }, { cache: false }); }
  }
  const cadena = q.cadena === "spar" ? "spar_gc" : q.cadena;
  const cp = q.cp || CP_DEFECTO;
  if (!["mercadona", "spar_gc", "hiperdino"].includes(cadena)) return send(res, 400, { ok: false, error: "cadena=mercadona|spar_gc|hiperdino" }, { cache: false });
  const t0 = Date.now();
  const hoy = new Date().toISOString().slice(0, 10);
  if (cadena === "mercadona" && q.t === "1") waitUntil(limpiaCuotas().then((n) => n && console.log("cuotas borradas", n)).catch((e) => console.error("limpiaCuotas", e?.message || e)));
  const rutaProg = ruta(cadena, cp, "progreso");
  // Sin paso explícito (disparo del cron): reanuda desde el progreso guardado hoy; si ya está completo, no hace nada.
  let paso0 = Math.max(0, +q.paso || 0);
  if (q.paso == null) {
    const prog = await lee(rutaProg, 0).catch(() => null);
    if (prog?.dia === hoy && prog.completo && q.forzar !== "1") return send(res, 200, { ok: true, cadena, cp, completo: true, actualizado: prog.actualizado }, { cache: false });
    paso0 = prog?.dia === hoy && q.forzar !== "1" ? prog.paso || 0 : 0;
  }
  // Por defecto responde al instante (202) y trabaja en segundo plano (waitUntil); al agotar el presupuesto llama al
  // siguiente tramo, que también responde al instante → la cadena no depende de conexiones largas. sync=1 para depurar.
  const trabajo = async () => {
    const { wh, unidades, recoge } = await plan(cadena, cp);
    let paso = paso0;
    const hechas = [];
    while (paso < unidades.length && Date.now() - t0 < PRESUPUESTO_MS) {
      const u = unidades[paso];
      const r = await recoge(u);
      await guarda(ruta(cadena, cp, `cat-${u.id.replace(/\//g, "_")}`), { id: u.id, nombre: u.nombre, actualizado: new Date().toISOString(), errores: r.errores?.length || 0, productos: r.productos });
      hechas.push({ id: u.id, n: r.productos.length, errores: r.errores?.length || 0 });
      paso++;
      await guarda(rutaProg, { dia: hoy, paso, de: unidades.length, completo: false, actualizado: new Date().toISOString() });
    }
    if (paso < unidades.length) {
      const base = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || req.headers.host}`;
      const sig = await fetch(`${base}/api/cron?cadena=${cadena}&cp=${cp}&paso=${paso}`, { headers: { authorization: auth }, signal: AbortSignal.timeout(15000) })
        .then((r) => r.status).catch((e) => String(e?.message || e));
      console.log(`[cron] ${cadena} ${paso0}→${paso}/${unidades.length} siguiente=${sig}`);
      return { ok: true, ms: Date.now() - t0, cadena, siguiente: paso, de: unidades.length, hechas, encadenado: sig };
    }
    const partes = await Promise.all(unidades.map((u) => lee(ruta(cadena, cp, `cat-${u.id.replace(/\//g, "_")}`), 0)));
    const productos = [...new Map(partes.filter(Boolean).flatMap((p) => p.productos).map((p) => [p.id, p])).values()];
    const errores = partes.filter(Boolean).reduce((a, p) => a + (p.errores || 0), 0);
    const meta = { cadena, cp, wh, actualizado: new Date().toISOString(), n: productos.length, tramos: partes.filter(Boolean).length, de: unidades.length, errores };
    await guarda(ruta(cadena, cp, "catalogo"), { ...meta, productos });
    await guardaHistorico(cadena, cp, productos);
    await guarda(rutaProg, { dia: hoy, paso: unidades.length, de: unidades.length, completo: true, actualizado: meta.actualizado, n: productos.length });
    console.log(`[cron] ${cadena} completo n=${productos.length} errores=${errores}`);
    return { ok: true, ms: Date.now() - t0, hechas, ...meta };
  };
  if (q.sync === "1") {
    try { const r = await trabajo(); return send(res, r.siguiente != null ? 202 : 200, r, { cache: false }); }
    catch (e) { console.error(e); return send(res, e.status || 502, { ok: false, error: String(e.message || e) }, { cache: false }); }
  }
  waitUntil(trabajo().catch((e) => console.error(`[cron] ${cadena} paso ${paso0}:`, e)));
  return send(res, 202, { ok: true, cadena, cp, paso: paso0, modo: "segundo plano" }, { cache: false });
}
