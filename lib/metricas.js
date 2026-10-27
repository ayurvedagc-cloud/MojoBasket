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

/** Uso diario de Claude: llamadas y tokens por modelo (lectura-escritura aproximada, suficiente para un tope diario) */
export async function usoHoy() { return (await lee(`uso/${dia()}.json`, 0).catch(() => null)) || { dia: dia(), llamadas: 0, modelos: {} }; }
export async function sumaUso(u, model, inTok, outTok) {
  u.llamadas = (u.llamadas || 0) + 1;
  const m = (u.modelos[model] ||= { llamadas: 0, in: 0, out: 0 });
  m.llamadas++; m.in += inTok || 0; m.out += outTok || 0;
  await guarda(`uso/${u.dia}.json`, u).catch(() => null);
}
