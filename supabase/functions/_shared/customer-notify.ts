// =========================================================
// Müşteriye kargo bildirimi (WhatsApp, satıcının onaylı "seltigo_kargo_takip_v1" şablonuyla)
// Kullananlar: cj-tracking-sync (CJ / AliExpress siparişleri), shipping-hub (satıcının kendi gönderdiği siparişler)
// Şartlar: Ayarlar'da açık (wa_tracking_notify), paket anahtarı (wa_customer_notify), satıcının WhatsApp'ı bağlı ve şablon onaylı.
// =========================================================
import { featureEnabled } from "./features.ts";

const GRAPH = "https://graph.facebook.com/v21.0";
const WA_TEMPLATE_NAME = "seltigo_kargo_takip_v1"; // wa-template-worker ile aynı şablon
const WA_TEMPLATE_LANG = "tr";

export function waPhone(raw: string | null, country: string | null): string | null {
  let d = String(raw || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("00")) d = d.slice(2);
  if ((country || "TR").toUpperCase() === "TR") {
    if (d.length === 11 && d.startsWith("0")) d = "90" + d.slice(1);
    else if (d.length === 10 && d.startsWith("5")) d = "90" + d;
  }
  return d.length >= 10 && d.length <= 15 ? d : null;
}

// true: gönderildi, null: gönderilmesi gerekmiyor/şartlar yok, string: hata
export async function notifyWhatsApp(db: any, userId: string, so: any, trackNumber: string): Promise<true | null | string> {
  const { data: prof } = await db.from("user_profiles").select("wa_tracking_notify").eq("user_id", userId).maybeSingle();
  if (prof && prof.wa_tracking_notify === false) return null;
  if (!(await featureEnabled(userId, "wa_customer_notify"))) return null;

  const { data: tpl } = await db
    .from("whatsapp_templates")
    .select("channel_id, status")
    .eq("user_id", userId)
    .eq("name", WA_TEMPLATE_NAME)
    .eq("language", WA_TEMPLATE_LANG)
    .eq("status", "APPROVED")
    .limit(1)
    .maybeSingle();
  if (!tpl) return null; // şablon henüz onaylı değil: sadece takip sayfası

  const { data: ch } = await db
    .from("social_channels")
    .select("account_id, access_token, active")
    .eq("id", tpl.channel_id)
    .maybeSingle();
  if (!ch?.active || !ch.access_token) return null;

  const to = waPhone(so.customer_phone, so.customer_country);
  if (!to) return "müşteri telefonu geçersiz";

  const { data: store } = await db.from("store_settings").select("store_name, business_name").eq("user_id", userId).maybeSingle();
  const storeName = String(store?.store_name || store?.business_name || "Mağaza").slice(0, 60);
  const firstName = String(so.customer_name || "").trim().split(/\s+/)[0] || "Merhaba";

  const r = await fetch(`${GRAPH}/${ch.account_id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ch.access_token}` },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: WA_TEMPLATE_NAME,
        language: { code: WA_TEMPLATE_LANG },
        components: [
          { type: "body", parameters: [
            { type: "text", text: firstName.slice(0, 40) },
            { type: "text", text: storeName },
            { type: "text", text: String(trackNumber).slice(0, 60) },
          ] },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: so.tracking_token }] },
        ],
      },
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d?.error) return String(d?.error?.message || `HTTP ${r.status}`).slice(0, 160);

  await db.from("store_orders").update({ whatsapp_notified_at: new Date().toISOString() }).eq("id", so.id);
  return true;
}
