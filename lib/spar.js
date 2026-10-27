// Adaptador SPAR Gran Canaria — API GraphQL del storefront (Apollo) de spargrancanariaonline.es
// Tienda maestra por defecto (precio de cadena); las ofertas aplican a la mayoría de puntos de venta.
import { fetchRetry, num, unidad, producto, pool, cached, sleep } from "./util.js";

const ORIGIN = "https://www.spargrancanariaonline.es";
const GQL = `${ORIGIN}/api/graphql`;
export const STORE_ID = process.env.SPAR_STORE_ID || "e5d11f85-5e3a-4508-a58a-65001d12beb9";
const H6 = 6 * 3600 * 1000;
const PAGE = 100;

export const CATEGORIAS = [
  ["001", "Frutas y verduras"], ["002", "Carnes"], ["003", "Charcutería y quesos"], ["004", "Panadería y pastelería"],
  ["005", "Huevos y derivados lácteos"], ["006", "Bebidas"], ["007", "Aperitivos"], ["008", "Gourmet"],
  ["009", "Arroz, legumbres y pasta"], ["010", "Conservas"], ["011", "Caldos, sopas y cremas"], ["012", "Chocolates y golosinas"],
  ["013", "Café, cacao e infusiones"], ["014", "Azúcar y edulcorantes"], ["015", "Galletas y cereales"], ["016", "Aceites, salsas y especias"],
  ["017", "Platos preparados y pizzas"], ["018", "Congelados"], ["021", "Alimentos dietéticos y complementos"],
].map(([codigo, nombre]) => ({ codigo, nombre }));
// Excluidas (no alimentación): 019 droguería, 020 perfumería, 022 bebé, 023 mascotas, 024 bazar

const QUERY = (codigo, page) => `{ products(input:{filters:{category_path_ids:["${codigo}"]},language:"es",meta:{pagination:{page:${page},page_size:${PAGE}}},store_id:"${STORE_ID}",tree:"NAVEO"}) {
  pagination { page totalPages totalCount nextPage }
  items { id extId gtin name { es } brand { default }
    prices { clicksUnitPrice bricksUnitPrice comparisonPrices { comparisonPrice comparisonPriceText measurementUnitName unitValue } }
    netContent { value measurementUnitCode }
    media { mediaStorageKey mediaSequence }
    offers { type subType effect { price totalprice } startsAt endsAt }
    categories { extId level name { es } } } } }`;

const UNI = { KGM: "kg", GRM: "g", LTR: "l", MLT: "ml", CLT: "cl", H87: "ud", EA: "ud", XPK: "pack" };

export function normaliza(it, { cp = null, ahora = Date.now() } = {}) {
  const base = num(it.prices?.clicksUnitPrice) ?? num(it.prices?.bricksUnitPrice);
  const vigentes = (it.offers || []).filter((o) => (!o.startsAt || Date.parse(o.startsAt) <= ahora) && (!o.endsAt || Date.parse(o.endsAt) >= ahora));
  const rebaja = vigentes.filter((o) => o.type === "price_reduction" && num(o.effect?.price) != null && num(o.effect.price) < base)
    .sort((a, b) => a.effect.price - b.effect.price)[0];
  const otras = vigentes.filter((o) => o !== rebaja).map((o) => [o.type, o.subType].filter(Boolean).join(":"));
  const precio = rebaja ? num(rebaja.effect.price) : base;
  // comparisonPrices: { comparisonPrice = precio artículo, unitValue = cantidad en la unidad de referencia, texto "KG sale a 2,38€" }
  const cmp = (it.prices?.comparisonPrices || []).find((c) => c.unitValue > 0 || /sale a/i.test(c.comparisonPriceText || "")) || it.prices?.comparisonPrices?.[0];
  const udTxt = cmp?.comparisonPriceText?.match(/^\s*(.*?)\s+sale a\s+([\d.,]+)/i);
  const udNombre = (cmp?.measurementUnitName || udTxt?.[1] || "").toUpperCase();
  const escurrido = /^PNE/.test(udNombre);
  const precio_ud = cmp?.unitValue > 0 ? Math.round((precio / cmp.unitValue) * 100) / 100
    : udTxt ? num(udTxt[2]) : cmp?.comparisonPrice != null && base ? Math.round(num(cmp.comparisonPrice) * (precio / base) * 100) / 100 : null;
  const nc = it.netContent?.[0];
  const cats = (it.categories || []).slice().sort((a, b) => a.level - b.level);
  const top = cats.find((c) => c.level === 1);
  const hoja = cats.filter((c) => c.level > 1).map((c) => c.name?.es).filter(Boolean);
  const imgs = (it.media || []).filter((m) => m.mediaStorageKey).sort((a, b) => (a.mediaSequence ?? 0) - (b.mediaSequence ?? 0));
  const img = (imgs.find((m) => /width=320/.test(m.mediaStorageKey)) || imgs[0])?.mediaStorageKey || null;
  const formatoNombre = (it.name?.es || "").match(/(\d+(?:[.,]\d+)?\s*(?:x\s*\d+(?:[.,]\d+)?\s*)?(?:kg|gr?|ml|cl|l|lt|ud|uds)\b\.?)/i)?.[1] || null;
  return producto({
    cadena: "spar_gc",
    cp,
    id: it.extId || it.id,
    ean: it.gtin || null,
    nombre: (it.name?.es || "").replace(/\s+/g, " ").trim(),
    marca: it.brand?.default || null,
    formato: nc ? `${String(nc.value).replace(".", ",")} ${UNI[nc.measurementUnitCode] || nc.measurementUnitCode}`
      : cmp?.unitValue ? `${String(cmp.unitValue).replace(".", ",")} ${unidad(udNombre.replace(/^PNE\s*/, "")) || udNombre.toLowerCase()}${escurrido ? " escurrido" : ""}` : formatoNombre,
    categoria: [top?.name?.es, ...new Set(hoja)].filter(Boolean).join(" > ") || null,
    precio,
    precio_ud,
    ud: udNombre ? unidad(udNombre.replace(/^PNE\s*/, "")) : null,
    oferta: !!rebaja || otras.length > 0,
    precio_antes: rebaja ? base : null,
    promo: otras.length ? otras.join(", ") : null,
    imagen: img ? (img.startsWith("http") ? img : `https://image.api.tisaone.net/api/product/${img}?width=320&height=320`) : null,
    url: `${ORIGIN}/search?q=${encodeURIComponent(it.name?.es || "")}`,
  });
}

async function gql(query) {
  const r = await fetchRetry(GQL, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ query }) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.errors) throw new Error(`SPAR GraphQL ${r.status}: ${j?.errors?.[0]?.message || "sin cuerpo"}`);
  return j.data;
}

/** Todos los productos de una categoría raíz (paginado de 100) */
export async function categoria(codigo, { cp = null } = {}) {
  const raiz = CATEGORIAS.find((c) => c.codigo === String(codigo));
  if (!raiz) throw Object.assign(new Error(`Categoría SPAR desconocida: ${codigo}`), { status: 400 });
  return cached(`spar:cat:${codigo}`, H6, async () => {
    const productos = new Map();
    let page = 1, total = null, paginas = 0;
    while (page && paginas < 60) {
      const d = await gql(QUERY(codigo, page));
      const p = d.products;
      paginas++;
      total = p.pagination?.totalCount ?? total;
      for (const it of p.items || []) { const n = normaliza(it, { cp }); productos.set(n.id, n); }
      page = p.pagination?.nextPage || null;
      if (page) await sleep(150);
    }
    return { codigo, nombre: raiz.nombre, paginas, total, productos: [...productos.values()], errores: [], truncado: total != null && productos.size < total };
  });
}

export async function catalogo({ cp = null, codigos = CATEGORIAS.map((c) => c.codigo) } = {}) {
  const res = await pool(codigos, 3, (c) => categoria(c, { cp }));
  const productos = new Map();
  const errores = [];
  for (const r of res) {
    if (!r || r.__error) { errores.push(r?.__error); continue; }
    r.productos.forEach((p) => productos.set(p.id, p));
  }
  return { productos: [...productos.values()], errores: errores.filter(Boolean) };
}
