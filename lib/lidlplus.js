// Adaptador Lidl Plus — API de la app (sin login) para ofertas semanales POR TIENDA.
// Canarias es un "país" propio en Lidl Plus: CS ("España | Canarias"); la Península es ES.
//   tiendas:  GET https://stores.lidlplus.com/api/v4/{CS|ES}
//   ofertas:  GET https://offers.lidlplus.com/app/api/v4/{país}/{storeKey}/offers
// Precio en priceBox.largePartNumeric; precio anterior en smallPartNumeric (si strikethrough); €/kg si priceSymbol = "€/kg".
import { fetchRetry, producto, cached, norm } from "./util.js";

const APP = "17.0.5";
const H = { accept: "application/json", "accept-language": "es-ES", "user-agent": `LidlPlus/${APP} Android okhttp/4.12.0`, "x-client-version": APP, "x-client-platform": "android" };
const H6 = 6 * 3600 * 1000, H24 = 24 * 3600 * 1000;

export const paisDeCP = (cp) => (/^3[58]\d{3}$/.test(String(cp)) ? "CS" : "ES");

const get = async (url) => {
  const r = await fetchRetry(url, { headers: H }, { timeout: 20000 });
  if (!r.ok) throw new Error(`Lidl Plus HTTP ${r.status} ${new URL(url).pathname}`);
  return r.json();
};

export async function tiendas(pais = "CS") {
  return cached(`lp:tiendas:${pais}`, H24, async () => {
    const j = await get(`https://stores.lidlplus.com/api/v4/${pais}`);
    return (Array.isArray(j) ? j : []).map((s) => ({
      key: s.storeKey, nombre: String(s.name || "").replace(/^CAN-[A-Z]{2}-/, ""), direccion: s.address, cp: s.postalCode,
      localidad: s.locality, provincia: s.province, lat: s.location?.latitude, lon: s.location?.longitude,
    })).filter((s) => s.key);
  });
}

/** Tienda para un CP: misma CP → mismo prefijo de 3 cifras → misma provincia */
export async function tiendaPorCP(cp, { tienda } = {}) {
  const pais = paisDeCP(cp);
  const ts = await tiendas(pais);
  if (tienda) { const t = ts.find((x) => x.key === tienda); if (t) return { pais, ...t }; }
  const c = String(cp);
  const t = ts.find((x) => x.cp === c) || ts.find((x) => String(x.cp).slice(0, 3) === c.slice(0, 3)) || ts.find((x) => String(x.cp).slice(0, 2) === c.slice(0, 2)) || ts[0];
  if (!t) throw Object.assign(new Error(`Lidl Plus: sin tiendas para CP ${cp}`), { status: 404 });
  return { pais, ...t };
}

export function normalizaOferta(o, { cp, tienda } = {}) {
  const pb = o.priceBox || {};
  const precio = pb.largePartNumeric ?? null;
  const antes = pb.strikethrough && pb.smallPartNumeric > precio ? pb.smallPartNumeric : null;
  const porKg = /\/\s*kg/i.test(pb.priceSymbol || "");
  const marca = o.brand && !/^-+$|^null$/i.test(o.brand) ? o.brand : null;
  const fmt = (o.title || "").match(/(\d+(?:[.,]\d+)?)\s*(kg|g|gr|ml|cl|l)\b/i);
  const f = { kg: 1, g: 0.001, gr: 0.001, l: 1, ml: 0.001, cl: 0.01 };
  const cant = fmt ? +fmt[1].replace(",", ".") * f[fmt[2].toLowerCase()] : null;
  return producto({
    cadena: "lidl", cp, id: (o.productIds && o.productIds[0]) || o.id,
    nombre: [o.title, marca && !norm(o.title).includes(norm(marca)) ? marca : null].filter(Boolean).join(" · "),
    marca, categoria: o.category || null,
    formato: porKg ? "precio por kg" : o.packaging || (fmt ? fmt[0] : null),
    precio, precio_ud: porKg ? precio : cant ? Math.round((precio / cant) * 100) / 100 : null,
    ud: porKg ? "kg" : fmt ? (/l$/i.test(fmt[2]) ? "l" : "kg") : null,
    oferta: true, precio_antes: antes, promo: pb.discountMessage || null,
    imagen: o.imageUrl || null, url: null,
  });
}

/** Ofertas vigentes y próximas de la tienda del CP */
export async function ofertas(cp, { tienda: forzada } = {}) {
  const t = await tiendaPorCP(cp, { tienda: forzada });
  return cached(`lp:of:${t.pais}:${t.key}`, H6, async () => {
    const j = await get(`https://offers.lidlplus.com/app/api/v4/${t.pais}/${t.key}/offers`);
    const ahora = Date.now();
    const lista = (j.offers || []).filter((o) => o.priceBox?.largePartNumeric != null).map((o) => ({
      ...normalizaOferta(o, { cp, tienda: t.key }),
      desde: o.startValidityDate?.slice(0, 10) || null, hasta: o.endValidityDate?.slice(0, 10) || null,
      vigente: (!o.startValidityDateUTC || Date.parse(o.startValidityDateUTC) <= ahora) && (!o.endValidityDateUTC || Date.parse(o.endValidityDateUTC) >= ahora),
    }));
    return { tienda: { key: t.key, nombre: t.nombre, direccion: t.direccion, cp: t.cp, localidad: t.localidad, pais: t.pais }, total: lista.length, productos: lista };
  });
}
