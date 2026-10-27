// Adaptador HiperDino (Dinosol) — tienda online Magento 2, listado renderizado en servidor.
// Ruta de tienda/zona por defecto c9499 (precio online HiperDino Canarias). Paginación ?p=N (30 por página).
import * as cheerio from "cheerio";
import { fetchRetry, num, producto, pool, cached, sleep } from "./util.js";

const ORIGIN = "https://www.hiperdino.es";
export const ZONA = process.env.HIPERDINO_ZONA || "c9499";
const BASE = `${ORIGIN}/${ZONA}`;
const H6 = 6 * 3600 * 1000;

const C = (grupo, nombre, slugs) => slugs.map((s) => ({ codigo: `${grupo}/${s}`, nombre: `${nombre} > ${s.replace(/-/g, " ")}` }));
export const CATEGORIAS = [
  ...C("alimentacion", "Alimentación", ["aceites", "aperitivo", "arroz", "azucar-y-edulcorantes", "cacao-y-cafe", "caldos-sopas-y-cremas", "cereales",
    "chocolate", "comida-internacional", "condimentos", "conservas-carne", "conservas-fruta-y-dulces", "conservas-pescado", "conservas-platos-preparados",
    "conservas-vegetales", "dieteticos", "galletas", "golosinas", "harinas-y-gofio", "infusiones-y-tes", "legumbres-cocidas", "legumbres-secas",
    "panaderia", "pasta", "pasteleria-industrial", "pates", "reposteria", "salsas"]),
  ...C("frescos", "Frescos", ["carne", "carnicos-envasados", "charcuteria-al-corte", "charcuteria-envasada", "fruta", "pescado-y-marisco",
    "pescado-y-marisco-en-bandeja", "platos-preparados", "quesos-al-corte", "quesos-envasados", "salsas-refrigeradas", "verduras-y-hortalizas",
    "zumos-y-sopas-refrigeradas"]),
  ...C("derivados-lacteos-y-huevos", "Lácteos y huevos", ["batidos", "bebidas-vegetales", "huevos", "leches", "mantequilla", "nata-liquida",
    "natillas", "postres", "yogur-y-petit"]),
  ...C("congelados", "Congelados", ["carne", "verduras-y-hortalizas", "helados", "panaderia-y-pasteleria", "pescado-y-marisco", "bases-y-masas",
    "platos-preparados"]),
];

const FACTOR = { kg: [1, "kg"], g: [0.001, "kg"], gr: [0.001, "kg"], l: [1, "l"], lt: [1, "l"], ml: [0.001, "l"], cl: [0.01, "l"] };

/** Formato desde el nombre: "580 g", "pack 6 x 1 l", "6x200 ml", "12 uds", "granel kg" → { cant (en kg/l/ud), ud, texto } */
export function formatoDe(nombre) {
  const s = String(nombre || "").toLowerCase().replace(/,/g, ".");
  // Pieza de peso variable ("Salmón pieza entera 5 -6 kg"): el precio publicado es €/kg
  if (/\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*kg\b/.test(s)) return { cant: 1, ud: "kg", texto: "precio por kg (peso variable)" };
  let m = s.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(kg|gr|g|ml|cl|lt|l)\b/);
  if (m) { const [f, u] = FACTOR[m[3]]; return { cant: +m[1] * +m[2] * f, ud: u, texto: `${m[1]} x ${m[2].replace(".", ",")} ${m[3]}` }; }
  const todos = [...s.matchAll(/(\d+(?:\.\d+)?)\s*(kg|gr|g|ml|cl|lt|l)\b/g)];
  if (todos.length) { m = todos[todos.length - 1]; const [f, u] = FACTOR[m[2]]; return { cant: +m[1] * f, ud: u, texto: `${m[1].replace(".", ",")} ${m[2]}` }; }
  m = s.match(/(\d+)\s*(uds?|unidades|piezas|rollos|bolsitas|sobres|cápsulas|capsulas)\b/);
  if (m) return { cant: +m[1], ud: "ud", texto: `${m[1]} ud` };
  if (/\bdocena\b/.test(s)) return { cant: 12, ud: "ud", texto: "12 ud" };
  if (/(\bkg\b|al peso|granel|€\/kg)\s*$/.test(s.trim())) return { cant: 1, ud: "kg", texto: "1 kg (al peso)" };
  return null;
}

/** Tarjetas de producto de un listado → esquema común */
export function parseListado(html, { cp = null, categoria = null } = {}) {
  const $ = cheerio.load(html);
  const out = [];
  $(".product-container[data-product-id]").each((_, el) => {
    const c = $(el);
    const id = c.attr("data-product-id");
    const nombre = c.find(".description__text.name").first().text().replace(/\s+/g, " ").trim() || c.find("img").attr("alt")?.trim();
    const precio = num(c.find(".price--final .price__text").first().text());
    if (!id || !nombre || precio == null) return;
    const antes = num(c.find(".price--previous .price__text").first().text());
    const badges = c.find(".top__badges .badge__text").map((_, b) => $(b).text().replace(/\s+/g, " ").trim()).get().filter(Boolean);
    const promo = c.find(".promotion--badge .badge__text").map((_, b) => $(b).text().replace(/\s+/g, " ").trim()).get().filter(Boolean).join(", ") || null;
    const img = c.find("img").attr("data-src") || null;
    const f = formatoDe(nombre);
    const rebaja = antes != null && antes > precio;
    out.push(producto({
      cadena: "hiperdino", cp, id, ean: null, nombre,
      marca: badges.includes("HiperDino") || /^hiperdino\b/i.test(nombre) ? "HiperDino" : null,
      formato: f?.texto || null, categoria,
      precio, precio_ud: f && f.cant > 0 ? Math.round((precio / f.cant) * 100) / 100 : null, ud: f?.ud || null,
      oferta: rebaja || badges.includes("Oferta") || !!promo, precio_antes: rebaja ? antes : null, promo,
      imagen: img ? img.replace("/200x200/", "/400x400/").replace(/\?.*$/, "") : null,
      url: `${BASE}/catalogsearch/result/?q=${encodeURIComponent(nombre)}`,
    }));
  });
  return out;
}

const pagina = async (codigo, p) => {
  const r = await fetchRetry(`${BASE}/${codigo}.html?p=${p}`, { headers: { accept: "text/html" } }, { timeout: 20000 });
  if (!r.ok) throw new Error(`HiperDino HTTP ${r.status} ${codigo} p${p}`);
  return r.text();
};

export async function categoria(codigo, { cp = null, maxPaginas = 30, lote = 4 } = {}) {
  const cat = CATEGORIAS.find((c) => c.codigo === codigo);
  if (!cat) throw Object.assign(new Error(`Categoría HiperDino desconocida: ${codigo}`), { status: 400 });
  return cached(`hd:cat:${codigo}:${maxPaginas}`, H6, async () => {
    // La web sirve 30 por página (ignora product_list_limit) y no expone el total: se piden páginas en tandas
    // paralelas hasta que una página llega incompleta o deja de aportar productos nuevos.
    const productos = new Map();
    let p = 1, fin = false, tam = 0;
    while (!fin && p <= maxPaginas) {
      const nums = Array.from({ length: Math.min(lote, maxPaginas - p + 1) }, (_, i) => p + i);
      const htmls = await Promise.all(nums.map((n) => pagina(codigo, n)));
      for (const html of htmls) {
        const l = parseListado(html, { cp, categoria: cat.nombre });
        tam ||= l.length;
        const nuevos = l.filter((x) => !productos.has(x.id));
        nuevos.forEach((x) => productos.set(x.id, x));
        if (!l.length || !nuevos.length || l.length < tam) { fin = true; break; } // Magento repite la última página fuera de rango
      }
      p += nums.length;
      if (!fin) await sleep(200);
    }
    return { codigo, nombre: cat.nombre, paginas: p - 1, productos: [...productos.values()], errores: [], truncado: !fin };
  });
}

export async function catalogo({ cp = null, codigos = CATEGORIAS.map((c) => c.codigo) } = {}) {
  const res = await pool(codigos, 3, (c) => categoria(c, { cp }));
  const productos = new Map();
  const errores = [];
  for (const r of res) { if (!r || r.__error) { errores.push(r?.__error); continue; } r.productos.forEach((p) => productos.set(p.id, p)); }
  return { productos: [...productos.values()], errores: errores.filter(Boolean) };
}
