// Suscripción Pro con Stripe (sin SDK: API REST con fetch). Se activa solo si hay STRIPE_SECRET_KEY y STRIPE_PRICE_PRO.
//   checkout(u, usr, base)  → URL de Stripe Checkout (modo suscripción, metadata.uid)
//   confirma(sessionId)      → al volver de Checkout: lee la sesión en Stripe y aplica la suscripción
//   webhook(body)            → no se fía del cuerpo: vuelve a pedir el evento a Stripe por su id (verificación por API,
//                              no necesita el cuerpo en bruto ni STRIPE_WEBHOOK_SECRET) y aplica el estado
//   portal(usr, base)        → URL del portal de cliente (cambiar tarjeta, cancelar, facturas)
// Estado guardado en el usuario: usr.stripe = {customer, subscription, estado, hasta, cancela, actualizado}
import * as C from "./cuenta.js";

const API = "https://api.stripe.com/v1";
export const activo = () => !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_PRO);
export const precioTexto = () => process.env.STRIPE_PRECIO_TEXTO || null;

/** Codifica objetos anidados al formato de formulario de Stripe: a[b][0][c]=v */
export function form(obj, pre = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = pre ? `${pre}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === "object" ? form(x, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(x))));
    else if (typeof v === "object") form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}
let fetchImpl = (...a) => fetch(...a);
export const usaFetch = (f) => { fetchImpl = f; };
async function stripe(path, params, method = params ? "POST" : "GET") {
  const r = await fetchImpl(API + path, {
    method, headers: { authorization: "Bearer " + process.env.STRIPE_SECRET_KEY, ...(params ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: params ? form(params).toString() : undefined, signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j?.error?.message || `Stripe HTTP ${r.status}`), { status: 502, detalle: JSON.stringify(j?.error || {}).slice(0, 300) });
  return j;
}

export async function checkout(u, usr, base) {
  if (!activo()) throw Object.assign(new Error("Los pagos no están activados."), { status: 503, code: "pagos_off" });
  if (C.stripeActivo(usr)) throw Object.assign(new Error("Ya tienes una suscripción Pro activa."), { status: 409 });
  const s = await stripe("/checkout/sessions", {
    mode: "subscription", line_items: [{ price: process.env.STRIPE_PRICE_PRO, quantity: 1 }],
    ...(usr.stripe?.customer ? { customer: usr.stripe.customer } : { customer_email: usr.email }),
    client_reference_id: u, metadata: { uid: u }, subscription_data: { metadata: { uid: u } },
    allow_promotion_codes: "true", locale: "es",
    success_url: `${base}/api/cuenta?accion=pago_ok&s={CHECKOUT_SESSION_ID}`, cancel_url: `${base}/?cuenta=pago_cancelado`,
  });
  return s.url;
}

const finPeriodo = (sub) => sub.current_period_end || sub.items?.data?.[0]?.current_period_end || null;
/** Guarda en el usuario el estado de una suscripción de Stripe. → uid o null */
export async function aplicaSub(sub, uidPista = null) {
  const u = sub?.metadata?.uid || uidPista;
  if (!u) return null;
  const usr = await C.leeUsuario(u);
  if (!usr) return null;
  const prev = usr.stripe || {};
  if (prev.subscription && prev.subscription !== sub.id && C.stripeActivo(usr) && !["active", "trialing", "past_due"].includes(sub.status)) return u; // una vieja cancelada no pisa a la activa
  const fin = finPeriodo(sub);
  usr.stripe = { customer: typeof sub.customer === "string" ? sub.customer : sub.customer?.id, subscription: sub.id, estado: sub.status,
    hasta: fin ? new Date(fin * 1000).toISOString() : null, cancela: !!sub.cancel_at_period_end, actualizado: new Date().toISOString() };
  await C.guardaUsuario(u, usr);
  return u;
}

export async function confirma(sessionId) {
  if (!activo() || !/^cs_[A-Za-z0-9_]+$/.test(String(sessionId || ""))) return null;
  const s = await stripe(`/checkout/sessions/${sessionId}?expand[]=subscription`);
  if (s.status !== "complete" || !s.subscription) return null;
  const sub = typeof s.subscription === "string" ? await stripe(`/subscriptions/${s.subscription}`) : s.subscription;
  return aplicaSub(sub, s.client_reference_id || s.metadata?.uid);
}

/** Webhook: solo se usa el id del evento; el contenido se vuelve a leer de Stripe con la clave secreta. */
export async function webhook(body) {
  if (!activo()) return { ok: false, ignorado: "pagos_off" };
  let b = body;
  if (Buffer.isBuffer?.(b)) b = b.toString("utf8");
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = null; } }
  const id = b?.id;
  if (!/^evt_[A-Za-z0-9_]+$/.test(String(id || ""))) return { ok: false, error: "evento no válido" };
  const ev = await stripe(`/events/${id}`);
  const o = ev.data?.object || {};
  let u = null;
  if (ev.type === "checkout.session.completed" && o.mode === "subscription" && o.subscription) {
    u = await aplicaSub(await stripe(`/subscriptions/${o.subscription}`), o.client_reference_id || o.metadata?.uid);
  } else if (/^customer\.subscription\.(created|updated|deleted|paused|resumed)$/.test(ev.type)) {
    u = await aplicaSub(o);
  } else if (ev.type === "invoice.payment_failed" || ev.type === "invoice.paid") {
    const sid = o.subscription || o.parent?.subscription_details?.subscription;
    if (sid) u = await aplicaSub(await stripe(`/subscriptions/${sid}`));
  }
  return { ok: true, tipo: ev.type, aplicado: !!u };
}

export async function portal(usr, base) {
  if (!activo()) throw Object.assign(new Error("Los pagos no están activados."), { status: 503, code: "pagos_off" });
  if (!usr.stripe?.customer) throw Object.assign(new Error("No tienes ninguna suscripción."), { status: 404 });
  const s = await stripe("/billing_portal/sessions", { customer: usr.stripe.customer, return_url: `${base}/?cuenta=portal` });
  return s.url;
}
