import * as mc from "./mercadona.js";
import * as spar from "./spar.js";
import * as hd from "./hiperdino.js";
import { matches, relevancia } from "./util.js";
import { lee, ruta } from "./store.js";

export const CP_DEFECTO = process.env.CP_DEFECTO || "35100"; // Maspalomas · San Bartolomé de Tirajana
export const CADENAS = ["mercadona", "spar_gc", "hiperdino"];

export function send(res, status, body, { cache = true } = {}) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("content-type", "application/json; charset=utf-8");
  if (cache && status === 200) res.setHeader("cache-control", "public, s-maxage=21600, stale-while-revalidate=86400");
  else res.setHeader("cache-control", "no-store");
  res.status(status).send(JSON.stringify(body));
}

export const wrap = (fn) => async (req, res) => {
  if (req.method === "OPTIONS") { res.setHeader("access-control-allow-origin", "*"); return res.status(204).end(); }
  const t0 = Date.now();
  try {
    const body = await fn(req.query || {}, req);
    send(res, 200, { ok: true, ms: Date.now() - t0, ...body });
  } catch (e) {
    console.error(e);
    send(res, e.status || 502, { ok: false, error: String(e.message || e) }, { cache: false });
  }
};

export const cadenasDe = (q) => {
  const c = (q.cadena || "todas").toLowerCase();
  if (c === "todas") return CADENAS;
  const list = c.split(",").map((x) => (x === "spar" ? "spar_gc" : x === "hd" ? "hiperdino" : x));
  const bad = list.filter((x) => !CADENAS.includes(x));
  if (bad.length) throw Object.assign(new Error(`Cadena no soportada: ${bad.join(", ")}`), { status: 400 });
  return list;
};

/** Productos de una cadena: instantánea en Blob si existe; si no, en vivo */
/** CP cuya instantánea sirve para este CP: SPAR e HiperDino tienen catálogo de toda Gran Canaria; Mercadona, el del
 *  mismo almacén. Si el almacén es otro y aún no hay instantánea propia, se usa la de CP_DEFECTO marcada como aproximada. */
export async function cpInstantanea(cadena, cp) {
  cp = String(cp || CP_DEFECTO);
  if (cp === CP_DEFECTO) return { cp, aproximado: false };
  if (cadena === "spar_gc" || cadena === "hiperdino") return { cp: CP_DEFECTO, aproximado: false };
  if (cadena === "mercadona") {
    try { const [a, b] = await Promise.all([mc.warehouse(cp), mc.warehouse(CP_DEFECTO)]); if (a.wh === b.wh) return { cp: CP_DEFECTO, aproximado: false, wh: a.wh }; } catch {}
  }
  return { cp, aproximado: false };
}

export async function productosDe(cadena, { cp, cat }) {
  const ci = await cpInstantanea(cadena, cp);
  const TTL = 30 * 60 * 1000; // el catálogo cambia una vez al día
  let snap = await lee(ruta(cadena, ci.cp, "catalogo"), TTL).catch(() => null);
  if (!snap?.productos?.length && ci.cp !== CP_DEFECTO && !cat) { snap = await lee(ruta(cadena, CP_DEFECTO, "catalogo"), TTL).catch(() => null); if (snap) ci.aproximado = true; }
  if (snap && snap.productos?.length) {
    let productos = snap.productos;
    let filtrado = true;
    if (cat && cadena === "spar_gc") {
      const raiz = spar.CATEGORIAS.find((c) => c.codigo === String(cat));
      productos = raiz ? productos.filter((p) => p.categoria === raiz.nombre || p.categoria?.startsWith(raiz.nombre + " > ")) : [];
    } else if (cat && cadena === "hiperdino") {
      const c = hd.CATEGORIAS.find((x) => x.codigo === String(cat));
      productos = c ? productos.filter((p) => p.categoria === c.nombre) : [];
    } else if (cat) filtrado = false; // Mercadona por categoría → en vivo
    if (filtrado) return { productos, meta: { fuente: "instantanea", actualizado: snap.actualizado, wh: snap.wh, cp_catalogo: snap.cp || ci.cp, ...(ci.aproximado ? { aproximado: true } : {}) } };
  }
  return productosVivo(cadena, { cp, cat });
}

async function productosVivo(cadena, { cp, cat }) {
  if (cadena === "mercadona") {
    if (!cat) throw Object.assign(new Error("Mercadona: catálogo completo aún no recolectado (cron pendiente); usa cat=<id> para consulta en vivo"), { status: 503 });
    const r = await mc.catalogo(cp, { soloTop: cat });
    return { productos: r.productos, meta: { fuente: "vivo", wh: r.wh, errores: r.errores.length, errores_muestra: r.errores.slice(0, 3) } };
  }
  if (cadena === "spar_gc") {
    if (!cat) throw Object.assign(new Error("SPAR: catálogo completo aún no recolectado (cron pendiente); usa cat=NNN para consulta en vivo"), { status: 503 });
    const r = await spar.categoria(cat, { cp });
    return { productos: r.productos, meta: { fuente: "vivo", errores: r.errores.length, truncado: !!r.truncado } };
  }
  if (cadena === "hiperdino") {
    if (!cat) throw Object.assign(new Error("HiperDino: catálogo completo aún no recolectado (cron pendiente); usa cat=alimentacion/legumbres-cocidas para consulta en vivo"), { status: 503 });
    const r = await hd.categoria(cat, { cp });
    return { productos: r.productos, meta: { fuente: "vivo", zona: hd.ZONA } };
  }
}

export function filtra(list, q) {
  let out = list;
  if (q.q) {
    const porNombre = out.filter((p) => matches(p, q.q, { soloNombre: true }));
    out = porNombre.length ? porNombre : out.filter((p) => matches(p, q.q));
  }
  if (q.oferta === "1" || q.oferta === "true") out = out.filter((p) => p.oferta);
  const orden = q.orden || (q.q ? "precio_ud" : null);
  if (orden === "precio_ud") out = [...out].sort((a, b) => (q.q ? relevancia(b, q.q) - relevancia(a, q.q) : 0) || (a.precio_ud ?? 1e9) - (b.precio_ud ?? 1e9));
  if (orden === "precio") out = [...out].sort((a, b) => a.precio - b.precio);
  if (orden === "descuento") out = [...out].sort((a, b) => dto(b) - dto(a));
  const limit = Math.min(+q.limit || 200, 5000);
  return { total: out.length, productos: out.slice(0, limit) };
}
export const dto = (p) => (p.precio_antes ? 1 - p.precio / p.precio_antes : 0);
