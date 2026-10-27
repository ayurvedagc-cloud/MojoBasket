export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/** Número desde "1,25", "1.25", " 2,09 € " → 1.25 */
export const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[^\d,.\-]/g, "");
  if (!s) return null;
  const n = s.includes(",") ? Number(s.replace(/\./g, "").replace(",", ".")) : Number(s);
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null;
};

/** Unidad de referencia canónica: kg | l | ud | 100ml | 100g */
export const unidad = (u) => {
  const s = String(u || "").toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  if (/^(kg|kilo)/.test(s)) return "kg";
  if (/^(l|lt|litro)/.test(s)) return "l";
  if (/^100ml/.test(s)) return "100ml";
  if (/^100g/.test(s)) return "100g";
  if (/^(ud|u|unidad|docena)/.test(s)) return s.startsWith("docena") ? "docena" : "ud";
  if (/^ml/.test(s)) return "ml";
  if (/^g(r)?$/.test(s)) return "g";
  return s;
};

/** Esquema común de producto */
export const producto = (o) => ({
  cadena: o.cadena,
  cp: o.cp ?? null,
  id: String(o.id),
  ean: o.ean ?? null,
  nombre: o.nombre,
  marca: o.marca ?? null,
  formato: o.formato ?? null,
  categoria: o.categoria ?? null,
  precio: o.precio,
  precio_ud: o.precio_ud ?? null,
  ud: o.ud ?? null,
  oferta: !!o.oferta,
  precio_antes: o.precio_antes ?? null,
  promo: o.promo ?? null,
  iva: o.iva ?? null,
  imagen: o.imagen ?? null,
  url: o.url ?? null,
  fecha: o.fecha ?? new Date().toISOString(),
});

export async function fetchRetry(url, opt = {}, { tries = 3, timeout = 15000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, {
        ...opt,
        signal: ctl.signal,
        headers: { "user-agent": UA, "accept-language": "es-ES,es;q=0.9", ...(opt.headers || {}) },
      });
      clearTimeout(t);
      if (r.status === 429 || r.status === 403 || r.status >= 500) {
        last = new Error(`HTTP ${r.status} ${url}`);
        const ra = Number(r.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 10) * 1000 : (r.status === 403 ? 3000 : 800) * 2 ** i);
        continue;
      }
      return r;
    } catch (e) {
      clearTimeout(t);
      last = e;
      await sleep(400 * (i + 1));
    }
  }
  throw last;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** map con concurrencia limitada */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { __error: String(e?.message || e) }; }
    }
  });
  await Promise.all(workers);
  return out;
}

/** caché en memoria por instancia (fluid compute reutiliza instancias) */
const MEM = new Map();
export const uncache = (key) => MEM.delete(key);
export async function cached(key, ttlMs, fn) {
  const hit = MEM.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  MEM.set(key, { t: Date.now(), v });
  return v;
}

export const norm = (s) =>
  String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

/** raíz simple española: quita plural (-es/-s) para casar "garbanzos" ↔ "garbanzo" */
export const raiz = (w) => (w.length > 4 && /[^aeiou]es$/.test(w) ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
const STOP = new Set(["de", "del", "la", "el", "los", "las", "con", "sin", "y", "en", "al", "a"]);

/** búsqueda por términos: todos los términos (en singular) deben aparecer como prefijo de alguna palabra */
export const matches = (p, q, { soloNombre = false } = {}) => {
  const terms = norm(q).split(/[^a-z0-9ñ]+/).filter((t) => t && !STOP.has(t)).map(raiz);
  if (!terms.length) return true;
  const words = norm(soloNombre ? `${p.nombre} ${p.marca || ""}` : `${p.nombre} ${p.marca || ""} ${p.categoria || ""}`).split(/[^a-z0-9ñ]+/).filter(Boolean).map(raiz);
  return terms.every((t) => words.some((w) => w.startsWith(t)));
};

/** Relevancia: 3 = nombre empieza por la búsqueda, 2 = término en primera palabra, 1 = resto */
export const relevancia = (p, q) => {
  const n = norm(p.nombre).split(/[^a-z0-9ñ]+/).filter(Boolean).map(raiz);
  const t = norm(q).split(/[^a-z0-9ñ]+/).filter((x) => x && !STOP.has(x)).map(raiz);
  if (!t.length || !n.length) return 0;
  // 3 = el nombre empieza por la búsqueda, o tras la marca en cadenas que nombran "Marca producto" (HiperDino)
  const marcaDelante = p.cadena === "hiperdino" || (p.marca && norm(p.nombre).startsWith(norm(p.marca)));
  if ((marcaDelante ? [0, 1] : [0]).some((o) => t.every((x, i) => n[i + o]?.startsWith(x)))) return 3;
  return n[0].startsWith(t[0]) ? 2 : 1;
};
