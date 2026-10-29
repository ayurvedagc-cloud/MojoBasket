// Suscripción Pro con PayPal (API REST v1 de Subscriptions, sin SDK).
// Variables: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_PLAN_ID (P-…), PAYPAL_ENV=live|sandbox (por defecto sandbox),
//            PAYPAL_PRECIO_TEXTO opcional ("2,99 €/mes"). Sin client id/secret/plan los pagos quedan desactivados.
//   suscribir(u, usr, base) → crea la suscripción (custom_id = uid) y devuelve el enlace de aprobación de PayPal
//   confirma(subId)          → al volver de PayPal: lee la suscripción en la API y la aplica
//   webhook(body)            → no se fía del cuerpo: toma el id de la suscripción y la vuelve a pedir a PayPal
//   cancelar(usr)            → cancela en PayPal (el Pro sigue hasta el final del periodo pagado)
//   creaPlan({precio,…})     → crea producto + plan en PayPal (desde el panel) y devuelve el id P-…
// Estado guardado en el usuario: usr.sub = {proveedor:"paypal", id, estado, hasta, impago, pagador, plan, actualizado}
//   estado: activa | pendiente | suspendida | cancelada | expirada
import * as C from "./cuenta.js";

// Valores tal cual se pegan en Vercel: sin espacios, saltos de línea ni comillas alrededor.
const env = (k) => String(process.env[k] || "").trim().replace(/^["']+|["']+$/g, "").trim();
export const modo = () => (/^(live|production|prod|real)$/i.test(env("PAYPAL_ENV")) ? "live" : "sandbox");
const URL_API = { live: "https://api-m.paypal.com", sandbox: "https://api-m.sandbox.paypal.com" };
const BASE = () => URL_API[modo()];
export const credenciales = () => !!(env("PAYPAL_CLIENT_ID") && env("PAYPAL_CLIENT_SECRET"));
export const activo = () => credenciales() && !!env("PAYPAL_PLAN_ID");
/** Versión vigente de las condiciones de contratación (legal.html#pro). Súbela al cambiarlas. */
export const CONDICIONES = "v1";
export const precioTexto = () => env("PAYPAL_PRECIO_TEXTO") || null;
const SUB_ID = /^I-[A-Z0-9]{6,30}$/;

let fetchImpl = (...a) => fetch(...a);
export const usaFetch = (f) => { fetchImpl = f; token = null; };
let token = null;
const pideToken = (entorno) => fetchImpl(URL_API[entorno] + "/v1/oauth2/token", {
  method: "POST", body: "grant_type=client_credentials", signal: AbortSignal.timeout(15000),
  headers: { authorization: "Basic " + Buffer.from(`${env("PAYPAL_CLIENT_ID")}:${env("PAYPAL_CLIENT_SECRET")}`).toString("base64"), "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
});
async function acceso() {
  if (token && token.exp > Date.now() + 60_000 && token.modo === modo()) return token.v;
  const r = await pideToken(modo());
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    // Diagnóstico: ¿las credenciales son del otro entorno?
    const otro = modo() === "live" ? "sandbox" : "live";
    const r2 = await pideToken(otro).catch(() => null);
    const id = env("PAYPAL_CLIENT_ID"), pista = `Client ID ${id.slice(0, 6)}…${id.slice(-4)} (${id.length} caracteres), PAYPAL_ENV interpretado como «${modo()}»`;
    const msg = r2?.ok
      ? `Tus credenciales son de PayPal ${otro.toUpperCase()}, pero PAYPAL_ENV está en «${modo()}». Cambia PAYPAL_ENV a «${otro}» en Vercel y redespliega.`
      : `PayPal rechazó las credenciales (${r.status}${j.error ? " " + j.error : ""}) en sandbox y en live. El Client ID y el Secret no coinciden o no son de la misma app: vuelve a copiarlos de developer.paypal.com → Apps & Credentials. ${pista}.`;
    throw Object.assign(new Error(msg), { status: 502, code: "paypal_credenciales" });
  }
  token = { v: j.access_token, exp: Date.now() + (j.expires_in || 3000) * 1000, modo: modo() };
  return token.v;
}
async function pp(path, body, method = body ? "POST" : "GET") {
  const r = await fetchImpl(BASE() + path, {
    method, signal: AbortSignal.timeout(15000), body: body ? JSON.stringify(body) : undefined,
    headers: { authorization: "Bearer " + (await acceso()), "content-type": "application/json", accept: "application/json", ...(body ? { "paypal-request-id": crypto.randomUUID() } : {}) },
  });
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j?.details?.[0]?.description || j?.message || `PayPal HTTP ${r.status}`), { status: r.status === 404 ? 404 : 502, detalle: JSON.stringify(j).slice(0, 300) });
  return j;
}
const err = (m, status, code) => Object.assign(new Error(m), { status, code });

const ESTADOS = { ACTIVE: "activa", APPROVAL_PENDING: "pendiente", APPROVED: "pendiente", SUSPENDED: "suspendida", CANCELLED: "cancelada", EXPIRED: "expirada" };

export async function suscribir(u, usr, base) {
  if (!activo()) throw err("Los pagos no están activados.", 503, "pagos_off");
  if (C.suscripcionActiva(usr) && usr.sub?.estado === "activa") throw err("Ya tienes una suscripción Pro activa.", 409);
  const s = await pp("/v1/billing/subscriptions", {
    plan_id: env("PAYPAL_PLAN_ID"), custom_id: u, subscriber: { email_address: usr.email },
    application_context: { brand_name: "MojoBasket", locale: "es-ES", shipping_preference: "NO_SHIPPING", user_action: "SUBSCRIBE_NOW",
      return_url: `${base}/api/cuenta?accion=pago_ok`, cancel_url: `${base}/?cuenta=pago_cancelado` },
  });
  const url = (s.links || []).find((l) => l.rel === "approve")?.href;
  if (!url) throw err("PayPal no devolvió el enlace de pago.", 502);
  return url;
}

/** Guarda en el usuario el estado de una suscripción de PayPal (leída de la API). → uid o null */
export async function aplicaSub(sub) {
  const u = sub?.custom_id;
  if (!u || !SUB_ID.test(sub.id || "")) return null;
  const usr = await C.leeUsuario(u);
  if (!usr) return null;
  const prev = usr.sub || {};
  const estado = ESTADOS[sub.status] || String(sub.status || "").toLowerCase();
  // una suscripción antigua cancelada no pisa a otra activa
  if (prev.id && prev.id !== sub.id && prev.estado === "activa" && estado !== "activa") return u;
  const bi = sub.billing_info || {};
  usr.sub = {
    proveedor: "paypal", id: sub.id, estado, plan: sub.plan_id || null,
    hasta: bi.next_billing_time || (prev.id === sub.id ? prev.hasta : null) || null,
    impago: (bi.failed_payments_count || 0) > 0, pagador: sub.subscriber?.email_address || null,
    ultimo_pago: bi.last_payment?.time || prev.ultimo_pago || null, actualizado: new Date().toISOString(),
  };
  await C.guardaUsuario(u, usr);
  return u;
}

export async function confirma(subId) {
  if (!activo() || !SUB_ID.test(String(subId || ""))) return null;
  const sub = await pp(`/v1/billing/subscriptions/${subId}`);
  const u = await aplicaSub(sub);
  return u ? { u, estado: ESTADOS[sub.status] } : null;
}

/** Webhook: solo se usa el id de la suscripción; su estado se vuelve a pedir a PayPal con nuestras credenciales. */
export async function webhook(body) {
  if (!activo()) return { ok: false, ignorado: "pagos_off" };
  let b = body;
  if (Buffer.isBuffer?.(b)) b = b.toString("utf8");
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = null; } }
  const tipo = String(b?.event_type || ""), r = b?.resource || {};
  const id = tipo.startsWith("BILLING.SUBSCRIPTION.") ? r.id : tipo.startsWith("PAYMENT.SALE.") ? r.billing_agreement_id : null;
  if (!SUB_ID.test(String(id || ""))) return { ok: true, tipo, ignorado: true };
  const u = await aplicaSub(await pp(`/v1/billing/subscriptions/${id}`));
  return { ok: true, tipo, aplicado: !!u };
}

export async function cancelar(usr) {
  if (!activo()) throw err("Los pagos no están activados.", 503, "pagos_off");
  if (!usr.sub?.id || usr.sub.estado !== "activa") throw err("No tienes ninguna suscripción activa.", 404);
  await pp(`/v1/billing/subscriptions/${usr.sub.id}/cancel`, { reason: "Cancelada por el usuario desde MojoBasket" });
  await aplicaSub(await pp(`/v1/billing/subscriptions/${usr.sub.id}`));
  return true;
}

/** Crea producto + plan mensual/anual en PayPal. Devuelve el id del plan para PAYPAL_PLAN_ID. */
export async function creaPlan({ precio, moneda = "EUR", intervalo = "MONTH", nombre = "MojoBasket Pro" } = {}) {
  if (!credenciales()) throw err("Faltan PAYPAL_CLIENT_ID y PAYPAL_CLIENT_SECRET.", 503);
  const v = Number(String(precio).replace(",", "."));
  if (!(v >= 0.5 && v <= 999)) throw err("Precio no válido.", 400);
  const iv = intervalo === "YEAR" ? "YEAR" : "MONTH";
  const prod = await pp("/v1/catalogs/products", { name: nombre, description: "Listas ilimitadas e historial ampliado en MojoBasket", type: "SERVICE", category: "SOFTWARE", home_url: "https://mojobasket.es" });
  const plan = await pp("/v1/billing/plans", {
    product_id: prod.id, name: `${nombre} ${iv === "YEAR" ? "anual" : "mensual"}`, status: "ACTIVE",
    billing_cycles: [{ frequency: { interval_unit: iv, interval_count: 1 }, tenure_type: "REGULAR", sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: v.toFixed(2), currency_code: moneda } } }],
    payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 2 },
  });
  return { plan_id: plan.id, producto: prod.id, precio: v.toFixed(2), moneda, intervalo: iv };
}

/** URL de la gestión de pagos automáticos en la cuenta PayPal del usuario. */
export const urlGestion = () => (modo() === "live" ? "https://www.paypal.com/myaccount/autopay/" : "https://www.sandbox.paypal.com/myaccount/autopay/");
