// Adaptador Mercadona — API interna (no oficial) de tienda.mercadona.es
// Precios zonificados por almacén ("wh"), que se resuelve a partir del código postal.
import { fetchRetry, num, unidad, producto, pool, cached, uncache, sleep } from "./util.js";

const BASE = "https://tienda.mercadona.es/api";
const H6 = 6 * 3600 * 1000;

/** CP → almacén. Override manual: env MERCADONA_WH_35100=xxx1 */
export async function warehouse(cp) {
  const env = process.env[`MERCADONA_WH_${cp}`];
  if (env) return { wh: env, fuente: "env" };
  return cached(`mc:wh:${cp}`, 24 * 3600 * 1000, async () => {
    // 1) PUT change-pc (lo que hace la web al introducir el CP)
    let r = await fetchRetry(`${BASE}/postal-codes/actions/change-pc/`, {
      method: "PUT",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ new_postal_code: String(cp) }),
    });
    let wh = r.headers.get("x-customer-wh");
    if (wh) return { wh, fuente: "change-pc" };
    const st1 = r.status;
    // 2) GET retrieve-pc
    r = await fetchRetry(`${BASE}/postal-codes/actions/retrieve-pc/${cp}/`, { headers: { accept: "application/json" } });
    wh = r.headers.get("x-customer-wh");
    if (wh) return { wh, fuente: "retrieve-pc" };
    const err = new Error(`Mercadona no devuelve almacén para CP ${cp} (HTTP ${st1}/${r.status}). ¿CP sin servicio online?`);
    err.status = 404;
    throw err;
  });
}

export async function categorias(wh) {
  return cached(`mc:cats:${wh}`, H6, async () => {
    const r = await fetchRetry(`${BASE}/categories/?lang=es&wh=${wh}`, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`categorías HTTP ${r.status}`);
    const j = await r.json();
    return (j.results || []).map((c) => ({
      id: c.id,
      nombre: c.name,
      sub: (c.categories || []).map((s) => ({ id: s.id, nombre: s.name })),
    }));
  });
}

export function normaliza(p, { cp, categoria }) {
  const pi = p.price_instructions || {};
  const precio = num(pi.unit_price) ?? num(pi.bulk_price);
  const antes = num(pi.previous_unit_price);
  const formato = [
    pi.unit_size != null && pi.size_format ? `${String(pi.unit_size).replace(".", ",")} ${pi.size_format}` : null,
    p.packaging,
  ].filter(Boolean).join(" · ") || null;
  return producto({
    cadena: "mercadona",
    cp,
    id: p.id,
    ean: p.ean || null,
    nombre: p.display_name,
    marca: p.brand || null,
    formato,
    categoria,
    precio,
    precio_ud: num(pi.reference_price) ?? num(pi.bulk_price),
    ud: unidad(pi.reference_format),
    oferta: pi.price_decreased === true || (antes != null && precio != null && antes > precio),
    precio_antes: antes != null && precio != null && antes > precio ? antes : null,
    iva: pi.iva ?? null,
    imagen: p.thumbnail || null,
    url: p.share_url || null,
  });
}

/** Productos de una subcategoría (nivel 2) */
export async function subcategoria(wh, id, cp) {
  return cached(`mc:sub:${wh}:${id}`, H6, async () => {
    const r = await fetchRetry(`${BASE}/categories/${id}/?lang=es&wh=${wh}`, { headers: { accept: "application/json" } }, { tries: 5, timeout: 20000 });
    if (!r.ok) throw new Error(`subcategoría ${id} HTTP ${r.status}`);
    const j = await r.json();
    const out = [];
    for (const c3 of j.categories || []) {
      const cat = `${j.name} > ${c3.name}`;
      for (const p of c3.products || []) out.push(normaliza(p, { cp, categoria: cat }));
    }
    return out;
  });
}

/** Productos de una categoría raíz: subcategorías en serie con pausa (evita bloqueos 403) */
export async function categoriaTop(wh, topId, cp, { pausa = 350 } = {}) {
  const cats = await categorias(wh);
  const top = cats.find((c) => String(c.id) === String(topId));
  if (!top) throw Object.assign(new Error(`Categoría Mercadona desconocida: ${topId}`), { status: 400 });
  const productos = [], errores = [];
  for (const s of top.sub) {
    try { productos.push(...(await subcategoria(wh, s.id, cp))); } catch (e) { errores.push(String(e.message || e)); }
    await sleep(pausa);
  }
  return { id: top.id, nombre: top.nombre, productos, errores };
}

/** Catálogo completo (≈150 peticiones, concurrencia 6) */
export async function catalogo(cp, { soloTop = null } = {}) {
  const { wh } = await warehouse(cp);
  const key = `mc:cat:${wh}:${soloTop || "all"}`;
  const out = await cached(key, H6, async () => {
    const cats = await categorias(wh);
    const subs = cats
      .filter((c) => !soloTop || String(c.id) === String(soloTop))
      .flatMap((c) => c.sub.map((s) => s.id));
    const res = await pool(subs, 3, (id) => subcategoria(wh, id, cp));
    const errores = res.filter((x) => x && x.__error).map((x) => x.__error);
    const productos = res.filter(Array.isArray).flat();
    const uniq = [...new Map(productos.map((p) => [p.id, p])).values()];
    return { wh, productos: uniq, errores };
  });
  if (out.errores.length) uncache(key); // no fijar catálogos incompletos
  return out;
}

// Búsqueda en vivo (índice Algolia público que usa tienda.mercadona.es). Respaldo cuando no hay instantánea en Blob
// (cron pendiente o store caído): no depende del catálogo completo. Claves sobrescribibles por env.
const ALG_APP = process.env.MERCADONA_ALGOLIA_APP || "7UZJKL1DJ0";
const ALG_KEY = process.env.MERCADONA_ALGOLIA_KEY || "9d8f2e39e90df472b4f2e559a116fe17";
const catDe = (h) => {
  const c = h.categories?.[0];
  if (!c) return null;
  const ruta = [];
  for (let x = c; x; x = x.categories?.[0]) ruta.push(x.name);
  return ruta.slice(0, 3).join(" > ") || null;
};

/** Hasta `n` productos para la consulta `q` en el almacén del CP (caché 6 h por instancia) */
export async function busca(cp, q, n = 20) {
  const { wh } = await warehouse(cp);
  return cached(`mc:alg:${wh}:${q}:${n}`, H6, async () => {
    const url = `https://${ALG_APP.toLowerCase()}-dsn.algolia.net/1/indexes/products_prod_${wh}_es/query`;
    const r = await fetchRetry(url, {
      method: "POST",
      headers: { "x-algolia-application-id": ALG_APP, "x-algolia-api-key": ALG_KEY, "content-type": "application/json", accept: "application/json", origin: "https://tienda.mercadona.es", referer: "https://tienda.mercadona.es/" },
      body: JSON.stringify({ params: new URLSearchParams({ query: q, hitsPerPage: String(n) }).toString() }),
    }, { tries: 2, timeout: 10000 });
    if (!r.ok) throw new Error(`búsqueda Mercadona HTTP ${r.status}`);
    const j = await r.json();
    return (j.hits || []).filter((h) => h.published !== false && h.price_instructions).map((h) => normaliza(h, { cp, categoria: catDe(h) }));
  });
}
