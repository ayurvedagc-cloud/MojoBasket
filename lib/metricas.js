// Métricas anónimas en Vercel Blob. Para no gastar operaciones (límite del plan), eventos y uso de Claude se acumulan
// en memoria por instancia y se vuelcan en lote cada LOTE_MS (o al llegar a LOTE_MAX): un blob por lote, no por evento.
//   ev/AAAA-MM-DD/HHMMSS-lote-L{listas}-C{clics}-P{copiar}-H{claude_chrome}-xxxx.json → {eventos:[…]}
//   (formato anterior, aún legible: ev/AAAA-MM-DD/HHMMSS-tipo-xxxx.json → un evento)
// Sin datos personales: ni IP, ni coordenadas, ni texto libre del usuario.
import { hayBlob, guarda, lee, blobCaido, marcaCaido } from "./store.js";

let blob;
const sdk = async () => (blob ||= await import("@vercel/blob"));
export const dia = (d = new Date()) => d.toISOString().slice(0, 10);

const TIPOS = new Set(["lista", "clic", "copiar", "claude_chrome"]);
const CADENAS = /^[a-z_]{2,20}$/;
const n = (v, max = 1e6) => (Number.isFinite(+v) ? Math.max(0, Math.min(max, Math.round(+v * 100) / 100)) : 0);
const txt = (v, max = 40) => (typeof v === "string" ? v.slice(0, max) : null);

/** Valida y reduce un evento del cliente a campos conocidos */
export function limpia(e) {
  if (!e || !TIPOS.has(e.tipo)) return null;
  const out = { tipo: e.tipo, t: new Date().toISOString() };
  if (e.tipo === "lista") {
    out.supers = (Array.isArray(e.supers) ? e.supers : []).filter((s) => CADENAS.test(s)).slice(0, 6);
    out.combinada = e.lista_tipo === "mix";
    out.total = n(e.total, 5000); out.viaje = n(e.viaje, 500); out.faltan = n(e.faltan, 200);
    out.personas = n(e.personas, 20); out.presupuesto = n(e.presupuesto, 2000); out.recetas = n(e.recetas, 50);
    out.zona = txt(e.zona);
    out.por_cadena = {};
    for (const [k, v] of Object.entries(e.por_cadena || {}).slice(0, 8)) if (CADENAS.test(k)) out.por_cadena[k] = { eur: n(v?.eur, 5000), items: n(v?.items, 200), ofertas: n(v?.ofertas, 200) };
  } else {
    out.accion = txt(e.accion, 20) || e.tipo;
    out.cadena = CADENAS.test(e.cadena || "") ? e.cadena : null;
  }
  return out;
}

export const LOTE_MS = +process.env.METRICAS_LOTE_MS || 20_000, LOTE_MAX = 200;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
/** Cola con volcado diferido: add() devuelve la promesa del volcado (pásala a waitUntil). */
function cola(vuelca) {
  let items = [], pendiente = null;
  const flush = async () => {
    const lote = items; items = []; pendiente = null;
    if (!lote.length || !hayBlob() || blobCaido()) return; // con Blob caído se descarta (métricas, no datos críticos)
    try { await vuelca(lote); } catch (e) { marcaCaido(e); console.error("metricas lote", e?.message || e); }
  };
  return {
    add(x) {
      items.push(x);
      if (items.length >= LOTE_MAX) return flush();
      return (pendiente ||= espera(LOTE_MS).then(flush));
    },
    flush, get n() { return items.length; },
  };
}
const hhmmss = (d = new Date()) => d.toISOString().slice(11, 19).replace(/:/g, "");
const sufijo = () => Math.random().toString(36).slice(2, 6);
export const nombreLote = (d, evs, now = new Date()) => {
  const c = { lista: 0, clic: 0, copiar: 0, claude_chrome: 0 };
  for (const e of evs) if (e.tipo in c) c[e.tipo]++;
  return `ev/${d}/${hhmmss(now)}-lote-L${c.lista}-C${c.clic}-P${c.copiar}-H${c.claude_chrome}-${sufijo()}.json`;
};
/** Recuento por tipo a partir del nombre (lote o evento suelto), sin descargar. */
export function cuentaNombre(pathname, c) {
  const m = /-lote-L(\d+)-C(\d+)-P(\d+)-H(\d+)/.exec(pathname);
  if (m) { c.lista += +m[1]; c.clic += +m[2]; c.copiar += +m[3]; c.claude_chrome += +m[4]; return; }
  const s = /\d{6}-(lista|clic|copiar|claude_chrome)/.exec(pathname); if (s) c[s[1]]++;
}
const colaEv = cola(async (lote) => {
  const { put } = await sdk();
  const porDia = {};
  for (const e of lote) (porDia[e.t.slice(0, 10)] ||= []).push(e);
  for (const [d, evs] of Object.entries(porDia))
    await put(nombreLote(d, evs), JSON.stringify({ eventos: evs }), { access: "public", addRandomSuffix: false, contentType: "application/json" });
});
/** Encola el evento; devuelve la promesa del volcado (para waitUntil). */
export function registra(ev) {
  if (!hayBlob()) return Promise.resolve(null);
  return colaEv.add(ev);
}

/** Lee los eventos de un rango de días (máx. 62) */
export async function eventos(desde, hasta, { max = 20000 } = {}) {
  const { list } = await sdk();
  const out = [];
  for (let d = new Date(desde + "T00:00:00Z"), i = 0; dia(d) <= hasta && i < 62; d.setUTCDate(d.getUTCDate() + 1), i++) {
    let cursor;
    do {
      const r = await list({ prefix: `ev/${dia(d)}/`, cursor, limit: 1000 });
      const lotes = [];
      for (let k = 0; k < r.blobs.length; k += 25) lotes.push(r.blobs.slice(k, k + 25));
      for (const l of lotes) out.push(...(await Promise.all(l.map((b) => fetch(b.url).then((x) => x.json()).catch(() => null)))).filter(Boolean).flatMap((j) => (Array.isArray(j.eventos) ? j.eventos : [j])));
      cursor = r.hasMore ? r.cursor : null;
    } while (cursor && out.length < max);
  }
  return out;
}

/** Agregado por cadena con los indicadores prometidos en el kit comercial */
export function agrega(evs, cadena = null) {
  const listas = evs.filter((e) => e.tipo === "lista");
  const clics = evs.filter((e) => e.tipo !== "lista");
  const porCadena = {};
  const c = (k) => (porCadena[k] ||= { listas: 0, cesta_eur: 0, items: 0, ofertas_usadas: 0, clics: 0, carrito: 0, copiar: 0, claude_chrome: 0, zonas: {} });
  for (const e of listas) {
    for (const [k, v] of Object.entries(e.por_cadena || {})) {
      const x = c(k); x.listas++; x.cesta_eur = Math.round((x.cesta_eur + v.eur) * 100) / 100; x.items += v.items; x.ofertas_usadas += v.ofertas;
      if (e.zona) x.zonas[e.zona] = (x.zonas[e.zona] || 0) + 1;
    }
  }
  for (const e of clics) {
    if (!e.cadena) continue;
    const x = c(e.cadena);
    if (e.tipo === "clic") { if (e.accion === "carrito") x.carrito++; else x.clics++; }
    else if (e.tipo === "copiar") x.copiar++;
    else if (e.tipo === "claude_chrome") x.claude_chrome++;
  }
  for (const x of Object.values(porCadena)) x.cesta_media = x.listas ? Math.round((x.cesta_eur / x.listas) * 100) / 100 : 0;
  const total = { listas: listas.length, cesta_media: listas.length ? Math.round((listas.reduce((a, e) => a + e.total, 0) / listas.length) * 100) / 100 : 0, combinadas: listas.filter((e) => (e.supers || []).length > 1).length };
  return cadena ? { total, cadena, ...(porCadena[cadena] || c(cadena)) } : { total, por_cadena: porCadena };
}

/** Uso diario de Claude. Un blob por llamada con los datos en el propio nombre
 *  (uso/AAAA-MM-DD/HHMMSSmmm-xxxx_modelo_in_out.json): sin lectura-escritura, así las llamadas simultáneas no se pisan.
 *  El total del día se obtiene listando el prefijo (sin descargar nada) y se cachea 60 s por instancia para el tope diario.
 *  Incluye el formato anterior (uso/AAAA-MM-DD.json) si existe. */
const cacheUso = new Map();
// Nombre: …_modelo_in_out.json (1 llamada) o …_modelo_in_out_n.json (lote de n llamadas).
export const nombreUso = (model, inTok, outTok, d = new Date(), n = 1) =>
  `uso/${dia(d)}/${d.toISOString().slice(11, 23).replace(/[:.]/g, "")}-${Math.random().toString(36).slice(2, 6)}_${String(model || "?").replace(/[^a-z0-9.-]/gi, "~")}_${Math.round(inTok || 0)}_${Math.round(outTok || 0)}${n > 1 ? "_" + n : ""}.json`;
export function sumaNombres(d, nombres, previo) {
  const u = { dia: d, llamadas: 0, modelos: {} };
  const add = (model, l, i, o) => { const m = (u.modelos[model] ||= { llamadas: 0, in: 0, out: 0 }); m.llamadas += l; m.in += i; m.out += o; u.llamadas += l; };
  if (previo?.modelos) for (const [k, v] of Object.entries(previo.modelos)) add(k, v.llamadas || 0, v.in || 0, v.out || 0);
  for (const p of nombres) {
    const m = /_([^_/]+)_(\d+)_(\d+)(?:_(\d+))?\.json$/.exec(p); if (!m) continue;
    add(m[1].replace(/~/g, "/"), +m[4] || 1, +m[2], +m[3]);
  }
  return u;
}
const CACHE_USO_MS = 10 * 60_000; // list() es operación avanzada: el tope diario usa la suma local entre lecturas
export async function usoDia(d = dia(), { fresco = false } = {}) {
  const c = cacheUso.get(d);
  if (!fresco && c && Date.now() - c.t < CACHE_USO_MS) return c.u;
  const { list } = await sdk();
  const nombres = []; let cursor;
  do { const l = await list({ prefix: `uso/${d}/`, cursor, limit: 1000 }); nombres.push(...l.blobs.map((b) => b.pathname)); cursor = l.hasMore ? l.cursor : null; } while (cursor);
  const previo = await lee(`uso/${d}.json`, 3600_000).catch(() => null);
  const u = sumaNombres(d, nombres, previo);
  cacheUso.set(d, { t: Date.now(), u });
  return u;
}
export async function usoHoy() { return usoDia(dia()); }
/** Agrupa las llamadas del lote por día y modelo: un blob por (día, modelo) y lote. */
export function agrupaUso(lote) {
  const g = {};
  for (const x of lote) { const k = x.d + "|" + x.model; const a = (g[k] ||= { d: x.d, model: x.model, n: 0, in: 0, out: 0 }); a.n++; a.in += x.in; a.out += x.out; }
  return Object.values(g);
}
const colaUso = cola(async (lote) => {
  const { put } = await sdk();
  for (const a of agrupaUso(lote))
    await put(nombreUso(a.model, a.in, a.out, new Date(a.d + "T" + new Date().toISOString().slice(11)), a.n), "{}", { access: "public", addRandomSuffix: false, contentType: "application/json" });
});
export function sumaUso(u, model, inTok, outTok) {
  const c = cacheUso.get(dia()); // suma local inmediata: entre lecturas, el tope diario cuenta con ella
  if (c) { c.u = sumaNombres(c.u.dia, [nombreUso(model, inTok, outTok)], c.u); }
  return colaUso.add({ d: dia(), model: model || "?", in: Math.round(inTok || 0), out: Math.round(outTok || 0) });
}
