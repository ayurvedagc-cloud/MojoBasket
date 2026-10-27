// Adaptador Lidl — Lidl no publica online precios de alimentación por tienda (su web solo vende bazar).
// Fuente disponible: folletos semanales vía API de folletos Schwarz (endpoints.leaflets.schwarz).
// Cada página trae texto indexado (keyWords: nombres + precios en céntimos, p. ej. "Secreto Cerdo 599 499 -16%"),
// una descripción (altText) y la imagen. La interpretación fina la hace el cliente (Claude) o se usa como pista de ofertas.
import { fetchRetry, cached } from "./util.js";

const API = "https://endpoints.leaflets.schwarz/v4";
export const WIDGET = process.env.LIDL_WIDGET || "01a1627e-32b1-7541-9924-bcae8ec8047b"; // "Flyer slider home" lidl.es
const H3 = 3 * 3600 * 1000;

const get = async (path) => {
  const r = await fetchRetry(`${API}/${path}`, { headers: { accept: "application/json" } });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.success) throw new Error(`Lidl folletos HTTP ${r.status}: ${j?.message || "sin cuerpo"}`);
  return j;
};

const idDe = (url) => String(url || "").match(/\/l\/folletos\/([^/]+)/)?.[1] || null;

/** Lista de folletos de alimentación activos o próximos */
export async function listaFolletos({ todos = false } = {}) {
  return cached(`lidl:lista:${todos}`, H3, async () => {
    const j = await get(`widget?widget_id=${WIDGET}&store_id=0&region_id=0`);
    return (j.widget?.flyers || [])
      .filter((f) => todos || /alimentaci/i.test(f.name))
      .map((f) => ({ id: idDe(f.url), nombre: f.name, titulo: f.title, url: f.url, miniatura: f.image }))
      .filter((f) => f.id);
  });
}

/** Páginas de un folleto: [{ n, texto, descripcion, imagen }] + vigencia */
export async function folleto(id) {
  return cached(`lidl:fl:${id}`, H3, async () => {
    const { flyer: f } = await get(`flyer?flyer_identifier=${encodeURIComponent(id)}&region_id=0`);
    return {
      id, nombre: f.name, titulo: f.title, desde: f.offerStartDate || f.startDate, hasta: f.offerEndDate || f.endDate,
      url: f.flyerUrlAbsolute, pdf: f.pdfUrl,
      paginas: (f.pages || []).filter((p) => p.pageType === "page" || !p.pageType).map((p) => ({
        n: p.number, texto: (p.keyWords || "").replace(/\s+/g, " ").trim(), descripcion: (p.altText || "").trim(), imagen: p.image,
      })).filter((p) => p.texto || p.descripcion),
    };
  });
}

/** Folletos de alimentación vigentes (o el próximo) con sus páginas */
export async function folletosVigentes({ hoy = new Date().toISOString().slice(0, 10) } = {}) {
  const lista = await listaFolletos();
  const det = await Promise.all(lista.map((f) => folleto(f.id).catch((e) => ({ id: f.id, error: String(e.message || e) }))));
  const ok = det.filter((d) => !d.error);
  const vigentes = ok.filter((d) => (!d.desde || d.desde <= hoy) && (!d.hasta || d.hasta >= hoy));
  const proximos = ok.filter((d) => d.desde && d.desde > hoy);
  return { vigentes, proximos, errores: det.filter((d) => d.error) };
}
