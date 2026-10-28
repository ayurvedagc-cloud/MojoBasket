// Alertas por email a los SuperAdmin (o ALERTAS_EMAIL). Se ejecuta a diario desde el cron (/api/cron?tarea=alertas, 08:30 UTC,
// tras los disparos del recolector) y bajo demanda desde el panel. Solo envía si hay avisos; los lunes envía además el resumen semanal.
// Comprobaciones: recolector al día y sin caídas bruscas de productos, uso y coste de Claude de ayer, errores de pagos
// e impagos, y configuración peligrosa en producción.
import * as C from "./cuenta.js";
import { CADENAS, CP_DEFECTO } from "./api.js";
import { lee, ruta, rutaHist, guarda, hayBlob } from "./store.js";
import { dia, usoDia } from "./metricas.js";
import { usuarios, coste } from "./admin.js";

const diaMenos = (n, d = new Date()) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() - n); return dia(x); };
const esc = (x) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const NOM = { mercadona: "Mercadona", spar_gc: "SPAR Gran Canaria", hiperdino: "HiperDino" };

export const destinatarios = () => {
  const extra = String(process.env.ALERTAS_EMAIL || "").split(/[,;\s]+/).map(C.normEmail).filter(Boolean);
  return extra.length ? extra : C.adminEmails();
};

/** Ejecuta las comprobaciones. enviar: manda el email si procede; forzar: lo manda aunque no haya avisos. */
export async function ejecutaAlertas({ enviar = true, forzar = false, base = "https://mojobasket.es", ahora = new Date() } = {}) {
  const hoy = dia(ahora), ayer = diaMenos(1, ahora), cp = CP_DEFECTO;
  const avisos = [], info = [];
  const av = (nivel, texto) => avisos.push({ nivel, texto });

  // 1. Recolector
  if (hayBlob()) {
    for (const c of CADENAS) {
      const prog = await lee(ruta(c, cp, "progreso"), 0).catch(() => null);
      if (!prog || prog.dia !== hoy) av("alto", `${NOM[c]}: el recolector no ha corrido hoy (última vez ${prog?.dia || "nunca"}).`);
      else if (!prog.completo) av("alto", `${NOM[c]}: recolección incompleta (${prog.paso}/${prog.de} tramos).`);
      else {
        const h = await lee(rutaHist(c, cp, ayer), 0).catch(() => null);
        if (h?.n && prog.n != null && prog.n < h.n * 0.75) av("medio", `${NOM[c]}: hoy ${prog.n} productos frente a ${h.n} ayer (−${Math.round((1 - prog.n / h.n) * 100)} %). Revisa la fuente.`);
        else info.push(`${NOM[c]}: ${prog.n ?? "?"} productos`);
      }
    }
  } else av("alto", "Falta BLOB_READ_WRITE_TOKEN: sin catálogos, cuentas ni métricas.");

  // 2. Claude (ayer)
  const tope = +process.env.CLAUDE_TOPE_DIA || 600, umbral = +process.env.ALERTA_COSTE_DIA || 10;
  const u = await usoDia(ayer, { fresco: true }).catch(() => null);
  if (u) {
    const usd = coste(u.modelos);
    if (u.llamadas >= tope) av("alto", `Claude llegó al tope diario ayer (${u.llamadas}/${tope}): hubo usuarios sin servicio. Sube CLAUDE_TOPE_DIA si el coste lo permite.`);
    else if (u.llamadas >= tope * 0.8) av("medio", `Claude ayer: ${u.llamadas} llamadas, ${Math.round((u.llamadas / tope) * 100)} % del tope diario.`);
    if (usd > umbral) av("medio", `Coste estimado de Claude ayer: $${usd.toFixed(2)} (umbral ALERTA_COSTE_DIA $${umbral}).`);
    info.push(`Claude ayer: ${u.llamadas} llamadas · $${usd.toFixed(2)} estimado`);
  }

  // 3. Pagos
  const ep = await C.leeJ("pagos/error.json", false).catch(() => null);
  if (ep?.t && ahora - new Date(ep.t) < 26 * 3600_000) av("alto", `Error procesando un webhook de Stripe (${ep.t.slice(0, 16).replace("T", " ")} UTC): ${ep.error}`);
  let us = null;
  try { us = await usuarios({ fresco: true }); } catch (e) { av("medio", "No se pudo leer la lista de usuarios: " + String(e?.message || e).slice(0, 120)); }
  if (us) {
    const impago = us.filter((x) => x.stripe?.estado === "past_due");
    if (impago.length) av("medio", `${impago.length} suscripción(es) Pro con pago fallido: ${impago.slice(0, 5).map((x) => x.email).join(", ")}${impago.length > 5 ? "…" : ""}`);
    const caducan = us.filter((x) => x.pro_hasta && !x.admin && Date.parse(x.pro_hasta) > +ahora && Date.parse(x.pro_hasta) - ahora < 3 * 864e5);
    if (caducan.length) info.push(`${caducan.length} Pro temporal(es) caducan en 3 días`);
  }

  // 4. Configuración
  if (process.env.CUENTAS_DEV === "1" && process.env.VERCEL_ENV === "production") av("alto", "CUENTAS_DEV=1 en producción: cualquiera puede entrar sin email. Quita la variable.");
  if (!process.env.RESEND_API_KEY && !process.env.RESEND_APIKEY) av("alto", "Sin RESEND_API_KEY: nadie puede recibir el enlace de acceso.");

  // Resumen semanal (lunes)
  let semanal = null;
  if (ahora.getUTCDay() === 1 || forzar) {
    const h7 = new Date(+ahora - 7 * 864e5).toISOString();
    let llamadas = 0, usd = 0;
    for (let i = 1; i <= 7; i++) { const x = await usoDia(diaMenos(i, ahora), { fresco: true }).catch(() => null); if (x) { llamadas += x.llamadas; usd += coste(x.modelos); } }
    semanal = us && { usuarios: us.length, nuevos: us.filter((x) => (x.creado || "") >= h7).length, activos: us.filter((x) => (x.ultimo || "") >= h7).length, pro: us.filter((x) => x.plan === "pro").length, llamadas, usd: Math.round(usd * 100) / 100 };
  }

  const r = { t: ahora.toISOString(), avisos, info, semanal, destinatarios: destinatarios(), enviado: false };
  if (enviar && (avisos.length || forzar || semanal) && r.destinatarios.length && C.emailListo() && process.env.CUENTAS_DEV !== "1") {
    const asunto = avisos.length ? `⚠️ MojoBasket: ${avisos.length} ${avisos.length === 1 ? "aviso" : "avisos"}` : semanal ? "MojoBasket: resumen semanal" : "MojoBasket: todo en orden";
    const col = { alto: "#a9442a", medio: "#7a5a00" };
    const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;padding:20px;color:#1f1d1b">
<h2 style="font-family:Georgia,serif;margin:0 0 12px">${esc(asunto)}</h2>
${avisos.length ? `<ul style="padding-left:18px">${avisos.map((a) => `<li style="margin:0 0 8px;color:${col[a.nivel]}"><b>${esc(a.texto)}</b></li>`).join("")}</ul>` : `<p>Sin avisos. Todo funciona con normalidad.</p>`}
${semanal ? `<h3 style="margin:18px 0 6px">Últimos 7 días</h3><p style="margin:0">${semanal.usuarios} usuarios (${semanal.nuevos} nuevos, ${semanal.activos} activos) · ${semanal.pro} Pro<br>Claude: ${semanal.llamadas} llamadas · $${semanal.usd.toFixed(2)} estimado</p>` : ""}
${info.length ? `<p style="color:#5e5547;font-size:13px;margin-top:16px">${info.map(esc).join("<br>")}</p>` : ""}
<p style="margin-top:20px"><a href="${esc(base)}/admin" style="background:#ffc72c;color:#1f1d1b;padding:10px 16px;border-radius:12px;font-weight:700;text-decoration:none">Abrir el panel</a></p></div>`;
    const text = `${asunto}\n\n${avisos.map((a) => "- " + a.texto).join("\n") || "Sin avisos."}\n\n${base}/admin`;
    for (const to of r.destinatarios) { try { await C.enviaEmail(to, asunto, html, text); r.enviado = true; } catch (e) { console.error("alertas email", to, e?.message || e); r.error = String(e?.message || e); } }
  }
  if (hayBlob()) await guarda("admin/alertas/ultimo.json", { t: r.t, avisos, info, enviado: r.enviado }).catch(() => {});
  return r;
}
