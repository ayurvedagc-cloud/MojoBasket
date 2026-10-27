// Open Food Facts: alérgenos, Nutri-Score, NOVA y nutrientes por EAN (o, si no hay EAN, búsqueda prudente por nombre).
// EAN: SPAR (instantánea), Mercadona (ficha de producto /api/products/{id}/). HiperDino y Lidl no publican EAN → búsqueda por nombre.
import { fetchRetry, cached, norm, pool, sleep } from "./util.js";
import { lee, ruta } from "./store.js";
import * as mc from "./mercadona.js";

const UA = "QueCompro/1.0 (+https://quecompro-precios.vercel.app)";
const D7 = 7 * 24 * 3600 * 1000;
const CAMPOS = "code,product_name,product_name_es,brands,nutriscore_grade,nova_group,allergens_tags,traces_tags,ingredients_analysis_tags,nutriments";

export const ALERGENOS = {
  "en:gluten": "gluten", "en:milk": "leche", "en:eggs": "huevo", "en:nuts": "frutos de cáscara", "en:peanuts": "cacahuete",
  "en:soybeans": "soja", "en:fish": "pescado", "en:crustaceans": "crustáceos", "en:molluscs": "moluscos", "en:celery": "apio",
  "en:mustard": "mostaza", "en:sesame-seeds": "sésamo", "en:sulphur-dioxide-and-sulphites": "sulfitos", "en:lupin": "altramuces",
};

export function resume(p, fuente) {
  if (!p) return null;
  const n = p.nutriments || {};
  const tags = p.ingredients_analysis_tags || [];
  const r1 = (v) => (v == null || v === "" ? null : Math.round(+v * 10) / 10);
  const g = String(p.nutriscore_grade || "").toLowerCase();
  return {
    ean: p.code, nombre_off: p.product_name_es || p.product_name || null, fuente,
    nutriscore: /^[a-e]$/.test(g) ? g.toUpperCase() : null,
    nova: p.nova_group ? +p.nova_group : null,
    alergenos: (p.allergens_tags || []).map((t) => ALERGENOS[t]).filter(Boolean),
    trazas: (p.traces_tags || []).map((t) => ALERGENOS[t]).filter(Boolean),
    vegano: tags.includes("en:vegan") ? true : tags.includes("en:non-vegan") ? false : null,
    vegetariano: tags.includes("en:vegetarian") ? true : tags.includes("en:non-vegetarian") ? false : null,
    aceite_palma: tags.includes("en:palm-oil") ? true : tags.includes("en:palm-oil-free") ? false : null,
    kcal_100: r1(n["energy-kcal_100g"]), proteinas_100: r1(n.proteins_100g), azucares_100: r1(n.sugars_100g), sal_100: r1(n.salt_100g), grasas_sat_100: r1(n["saturated-fat_100g"]),
  };
}

const offJSON = async (url) => {
  const r = await fetchRetry(url, { headers: { "user-agent": UA, accept: "application/json" } }, { timeout: 15000 });
  if (r.status === 404) return { status: 0, hits: [] };
  if (!r.ok) throw new Error(`OFF HTTP ${r.status}`);
  return r.json();
};

/** Varios EAN: ficha por EAN (/api/v2/product, estable; /api/v2/search devuelve 503 con frecuencia) */
export async function porEANs(eans) {
  const out = {};
  const pend = [];
  for (const e of eans) { const c = cachedGet(`off:ean:${e}`); if (c !== undefined) out[e] = c; else pend.push(e); }
  await pool(pend, 4, async (e) => {
    try {
      const j = await offJSON(`https://world.openfoodfacts.org/api/v2/product/${e}?fields=${CAMPOS}`);
      const r = j.status === 1 && j.product ? resume({ code: e, ...j.product }, "ean") : null;
      out[e] = r; cachedSet(`off:ean:${e}`, r);
    } catch { out[e] = null; } // 404 = no está en OFF; errores transitorios no se cachean
  });
  return out;
}

const STOP = new Set(["de", "del", "la", "el", "los", "las", "con", "sin", "y", "en", "al", "para", "pack", "bote", "lata", "bolsa", "tarro", "botella", "brik", "hacendado", "hiperdino", "spar"]);
const tokens = (s) => norm(s).replace(/\d+([.,]\d+)?\s*(kg|g|gr|ml|cl|l|ud|uds|x)\b/g, " ").split(/[^a-z0-9ñ]+/).filter((t) => t.length > 2 && !STOP.has(t));

/** Búsqueda por nombre: solo acepta si ≥70 % de las palabras del producto aparecen en el nombre/marca de OFF */
export async function porNombre(nombre, marca) {
  const key = `off:nom:${norm(nombre)}`;
  const c = cachedGet(key); if (c !== undefined) return c;
  const q = [marca, nombre].filter(Boolean).join(" ");
  let res = null;
  try {
    const j = await offJSON(`https://search.openfoodfacts.org/search?q=${encodeURIComponent(q + ' countries_tags:"en:spain"')}&langs=es&page_size=6&fields=${CAMPOS}`);
    j.products = j.hits || [];
    const ts = tokens(nombre);
    let mejor = null, score = 0;
    for (const p of j.products || []) {
      const pal = new Set(tokens(`${p.product_name_es || p.product_name || ""} ${[].concat(p.brands || []).join(" ")}`));
      const s = ts.length ? ts.filter((t) => [...pal].some((w) => w.startsWith(t) || t.startsWith(w))).length / ts.length : 0;
      if (s > score) { score = s; mejor = p; }
    }
    res = mejor && score >= 0.7 ? { ...resume(mejor, "nombre"), coincidencia: Math.round(score * 100) } : null;
  } catch (e) { res = null; }
  cachedSet(key, res);
  return res;
}

// caché simple en memoria (se reutiliza entre invocaciones de la misma instancia)
const MEM = new Map();
function cachedGet(k) { const h = MEM.get(k); return h && Date.now() - h.t < D7 ? h.v : undefined; }
function cachedSet(k, v) { MEM.set(k, { t: Date.now(), v }); }

/** EAN de un producto Mercadona (ficha) */
export async function eanMercadona(id, cp) {
  return cached(`mc:ean:${id}`, D7, async () => {
    const { wh } = await mc.warehouse(cp);
    const r = await fetchRetry(`https://tienda.mercadona.es/api/products/${id}/?lang=es&wh=${wh}`, { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    const j = await r.json();
    return j.ean || null;
  });
}

/** items: [{cadena, id, nombre?, marca?}] → { "cadena:id": resumen|null } */
export async function nutricion(items, { cp }) {
  const spar = items.some((x) => x.cadena === "spar_gc") ? await lee(ruta("spar_gc", cp, "catalogo")).catch(() => null) : null;
  const eanSpar = new Map((spar?.productos || []).map((p) => [String(p.id), p.ean]));
  const eans = {};
  await pool(items, 3, async (x) => {
    if (x.cadena === "spar_gc") eans[`${x.cadena}:${x.id}`] = eanSpar.get(String(x.id)) || null;
    else if (x.cadena === "mercadona") { eans[`${x.cadena}:${x.id}`] = await eanMercadona(x.id, cp).catch(() => null); await sleep(200); }
  });
  const conEan = Object.values(eans).filter(Boolean);
  const off = conEan.length ? await porEANs([...new Set(conEan)]) : {};
  const out = {};
  await pool(items, 3, async (x) => {
    const k = `${x.cadena}:${x.id}`;
    out[k] = eans[k] ? off[eans[k]] || null : null;
    if (!out[k] && x.nombre) out[k] = await porNombre(x.nombre, x.marca);
  });
  return out;
}
