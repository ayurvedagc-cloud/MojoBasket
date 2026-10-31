// Persistencia en Vercel Blob: instantáneas de catálogo e histórico compacto de precios
import { cached, uncache } from "./util.js";

export const hayBlob = () => !!process.env.BLOB_READ_WRITE_TOKEN;
export const ruta = (cadena, cp, nombre) => `snap/${cadena}/${cp}/${nombre}.json`;
export const rutaHist = (cadena, cp, dia) => `hist/${cadena}/${cp}/${dia}.json`;

let blob;
const sdk = async () => (blob ||= await import("@vercel/blob"));

export async function guarda(path, obj) {
  const { put } = await sdk();
  if (blobCaido()) throw new Error("Blob no disponible (reintento en 2 min)");
  const r = await put(path, JSON.stringify(obj), {
    access: "public", addRandomSuffix: false, allowOverwrite: true,
    contentType: "application/json", cacheControlMaxAge: 60,
  });
  uncache(`blob:${path}`);
  return r.url;
}

// Si Blob falla (suspendido, caído), se deja de consultar 2 min por instancia: cada head cuenta como operación.
let caidoHasta = 0;
export const blobCaido = () => Date.now() < caidoHasta;
export const marcaCaido = (e) => { if (/suspend|forbidden|unauthori|ECONN|fetch failed|timeout|5\d\d/i.test(`${e?.name} ${e?.message}`)) caidoHasta = Date.now() + 120_000; };

export async function lee(path, ttlMs = 5 * 60 * 1000) {
  if (!hayBlob()) return null;
  if (blobCaido()) throw new Error("Blob no disponible (reintento en 2 min)");
  return cached(`blob:${path}`, ttlMs, async () => {
    const { head } = await sdk();
    let h;
    try { h = await head(path); } catch (e) {
      if (e instanceof (await sdk()).BlobNotFoundError || /not.?found|does not exist/i.test(`${e?.name} ${e?.message}`)) return null;
      marcaCaido(e); throw e;
    }
    const r = await fetch(`${h.url}?v=${encodeURIComponent(h.uploadedAt?.toISOString?.() || Date.now())}`);
    if (!r.ok) throw new Error(`Blob HTTP ${r.status} ${path}`);
    return r.json();
  });
}

/** Histórico compacto: { id: precio } por día */
export async function guardaHistorico(cadena, cp, productos) {
  const dia = new Date().toISOString().slice(0, 10);
  const mapa = Object.fromEntries(productos.map((p) => [p.id, p.oferta && p.precio_antes ? [p.precio, p.precio_antes] : p.precio]));
  return guarda(rutaHist(cadena, cp, dia), { dia, n: productos.length, precios: mapa });
}
