// Persistencia en Vercel Blob: instantáneas de catálogo e histórico compacto de precios
import { cached, uncache } from "./util.js";

export const hayBlob = () => !!process.env.BLOB_READ_WRITE_TOKEN;
export const ruta = (cadena, cp, nombre) => `snap/${cadena}/${cp}/${nombre}.json`;
export const rutaHist = (cadena, cp, dia) => `hist/${cadena}/${cp}/${dia}.json`;

let blob;
const sdk = async () => (blob ||= await import("@vercel/blob"));

export async function guarda(path, obj) {
  const { put } = await sdk();
  const r = await put(path, JSON.stringify(obj), {
    access: "public", addRandomSuffix: false, allowOverwrite: true,
    contentType: "application/json", cacheControlMaxAge: 60,
  });
  uncache(`blob:${path}`);
  return r.url;
}

export async function lee(path, ttlMs = 5 * 60 * 1000) {
  if (!hayBlob()) return null;
  return cached(`blob:${path}`, ttlMs, async () => {
    const { head } = await sdk();
    let h;
    try { h = await head(path); } catch (e) {
      if (e instanceof (await sdk()).BlobNotFoundError || /not.?found|does not exist/i.test(`${e?.name} ${e?.message}`)) return null;
      throw e;
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
