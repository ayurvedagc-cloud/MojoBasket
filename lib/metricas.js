// Métricas anónimas en Vercel Blob: un objeto por evento (ev/AAAA-MM-DD/HHMMSS-xxxx.json) y un resumen de uso de Claude por día.
// Sin datos personales: ni IP, ni coordenadas, ni texto libre del usuario.
import { hayBlob, guarda, lee } from "./store.js";

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

export async function registra(ev) {
  if (!hayBlob()) return null;
  const { put } = await sdk();
  const t = ev.t.replace(/[-:]/g, "").slice(9, 15);
  return put(`ev/${ev.t.slice(0, 10)}/${t}-${ev.tipo}.json`, JSON.stringify(ev), { access: "public", addRandomSuffix: true, contentType: "application/json" });
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
      for (const l of lotes) out.push(...(await Promise.all(l.map((b) => fetch(b.url).then((x) => x.json()).catch(() => null)))).filter(Boolean));
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
export const nombreUso = (model, inTok, outTok, d = new Date()) =>
  `uso/${dia(d)}/${d.toISOString().slice(11, 23).replace(/[:.]/g, "")}-${Math.random().toString(36).slice(2, 6)}_${String(model || "?").replace(/[^a-z0-9.-]/gi, "~")}_${Math.round(inTok || 0)}_${Math.round(outTok || 0)}.json`;
export function sumaNombres(d, nombres, previo) {
  const u = { dia: d, llamadas: 0, modelos: {} };
  const add = (model, l, i, o) => { const m = (u.modelos[model] ||= { llamadas: 0, in: 0, out: 0 }); m.llamadas += l; m.in += i; m.out += o; u.llamadas += l; };
  if (previo?.modelos) for (const [k, v] of Object.entries(previo.modelos)) add(k, v.llamadas || 0, v.in || 0, v.out || 0);
  for (const p of nombres) {
    const m = /_([^_/]+)_(\d+)_(\d+)\.json$/.exec(p); if (!m) continue;
    add(m[1].replace(/~/g, "/"), 1, +m[2], +m[3]);
  }
  return u;
}
export async function usoDia(d = dia(), { fresco = false } = {}) {
  const c = cacheUso.get(d);
  if (!fresco && c && Date.now() - c.t < 60_000) return c.u;
  const { list } = await sdk();
  const nombres = []; let cursor;
  do { const l = await list({ prefix: `uso/${d}/`, cursor, limit: 1000 }); nombres.push(...l.blobs.map((b) => b.pathname)); cursor = l.hasMore ? l.cursor : null; } while (cursor);
  const previo = await lee(`uso/${d}.json`, 3600_000).catch(() => null);
  const u = sumaNombres(d, nombres, previo);
  cacheUso.set(d, { t: Date.now(), u });
  return u;
}
export async function usoHoy() { return usoDia(dia()); }
export async function sumaUso(u, model, inTok, outTok) {
  const { put } = await sdk();
  await put(nombreUso(model, inTok, outTok), "{}", { access: "public", addRandomSuffix: false, contentType: "application/json" }).catch((e) => console.error("uso", e?.message || e));
  const c = cacheUso.get(dia()); // suma local inmediata para que el tope diario no espere a la caché
  if (c) { c.u = sumaNombres(c.u.dia, [nombreUso(model, inTok, outTok)], c.u); }
}
