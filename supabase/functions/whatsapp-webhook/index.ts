// Supabase Edge Function: whatsapp-webhook
// Meta WhatsApp'tan gelen bildirimleri alır. Müşteri WhatsApp'ta sepetini gönderdiğinde
// siparişi otomatik olarak satıcının Seltigo "Siparişler" ekranına kaydeder ve müşteriye
// "siparişin alındı" mesajı gönderir.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_SECRET = Deno.env.get("FACEBOOK_CLIENT_SECRET") || "";
const VERIFY_TOKEN = Deno.env.get("WHATSAPP_VERIFY_TOKEN") || "";
const GRAPH = "https://graph.facebook.com/v21.0";

const db = createClient(SUPABASE_URL, SERVICE_KEY);

async function validSignature(raw: string, header: string | null) {
  if (!APP_SECRET) return true;
  if (!header || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === header.slice(7);
}

function money(n: number, cur: string) {
  return `${n.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;
}

async function sendText(phoneNumberId: string, token: string, to: string, text: string) {
  try {
    await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
    });
  } catch { /* yanıt gönderilemezse sipariş yine kayıtlı */ }
}

async function handleOrder(phoneNumberId: string, msg: any, contacts: any[]) {
  // Bu WhatsApp numarası hangi satıcının?
  const { data: chans } = await db.from("social_channels").select("user_id, access_token, account_name")
    .eq("platform", "whatsapp").eq("account_id", phoneNumberId).eq("active", true)
    .order("updated_at", { ascending: false }).limit(1);
  const ch = chans?.[0];
  if (!ch) return;
  const userId = ch.user_id;

  // Aynı sipariş iki kez gelirse tekrar kaydetme
  const { data: dup } = await db.from("orders").select("id").eq("user_id", userId)
    .eq("platform", "whatsapp").like("marketplace_order_no", `${msg.id}%`).limit(1);
  if (dup && dup.length) return;

  const from = String(msg.from || "");
  const contact = (contacts || []).find((c: any) => c.wa_id === from) || contacts?.[0];
  const customerName = contact?.profile?.name || ("+" + from);
  const order = msg.order || {};
  const items: any[] = order.product_items || [];
  const customerNote = String(order.text || "").trim();
  if (!items.length) return;

  // Ürünleri bul (katalogdaki kimlik: seltigo_<ürün id>)
  const ids = items.map((i) => String(i.product_retailer_id || "").replace(/^seltigo_/, "")).filter(Boolean);
  const { data: prods } = await db.from("products").select("id, name, generated_title, supplier, platform")
    .eq("user_id", userId).in("id", ids);
  const byId: Record<string, any> = {};
  (prods || []).forEach((p: any) => { byId[String(p.id)] = p; });

  let total = 0;
  let cur = "TRY";
  const lines: string[] = [];
  const rows: any[] = [];
  items.forEach((it, idx) => {
    const pid = String(it.product_retailer_id || "").replace(/^seltigo_/, "");
    const p = byId[pid];
    const qty = Number(it.quantity) || 1;
    const price = Number(it.item_price) || 0;
    cur = it.currency || cur;
    total += price * qty;
    const name = p ? (p.generated_title || p.name) : it.product_retailer_id;
    lines.push(`${qty} × ${name} — ${money(price * qty, cur)}`);
    rows.push({
      user_id: userId,
      product_id: p ? p.id : null,
      platform: "whatsapp",
      marketplace_order_no: items.length > 1 ? `${msg.id}#${idx + 1}` : String(msg.id),
      customer_name: customerName,
      customer_phone: "+" + from,
      quantity: qty,
      total_price: price * qty,
      supplier: p ? p.supplier : null,
      status: "beklemede",
      note: [
        "WhatsApp siparişi",
        `Birim fiyat: ${money(price, cur)}`,
        items.length > 1 ? `Sepette ${items.length} kalem` : "",
        customerNote ? `Müşteri notu: ${customerNote}` : "",
      ].filter(Boolean).join(" · "),
    });
  });

  let { error } = await db.from("orders").insert(rows);
  if (error && /total_price/i.test(error.message)) {
    // total_price sütunu yoksa onsuz kaydet
    ({ error } = await db.from("orders").insert(rows.map(({ total_price, ...r }) => r)));
  }
  if (error) { console.error("order insert", error.message); return; }

  // Müşteriye otomatik onay mesajı
  const reply = [
    `✅ Siparişin alındı, teşekkürler ${contact?.profile?.name ? contact.profile.name.split(" ")[0] : ""}!`.replace(" !", "!"),
    "",
    ...lines,
    "",
    `Toplam: ${money(total, cur)}`,
    "",
    "Adres ve ödeme bilgileri için kısa süre içinde sana buradan yazacağız.",
  ].join("\n");
  if (ch.access_token) await sendText(phoneNumberId, ch.access_token, from, reply);
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // Meta'nın ilk doğrulaması
  if (req.method === "GET") {
    if (VERIFY_TOKEN && url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === VERIFY_TOKEN) {
      return new Response(url.searchParams.get("hub.challenge") || "", { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  if (req.method !== "POST") return new Response("OK");

  const raw = await req.text();
  if (!(await validSignature(raw, req.headers.get("x-hub-signature-256")))) {
    return new Response("Bad signature", { status: 401 });
  }

  try {
    const body = JSON.parse(raw || "{}");
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const v = change.value || {};
        const phoneNumberId = String(v.metadata?.phone_number_id || "");
        for (const msg of v.messages || []) {
          if (msg.type === "order") await handleOrder(phoneNumberId, msg, v.contacts || []);
        }
      }
    }
  } catch (e) {
    console.error("webhook", String((e as Error)?.message || e));
  }
  // Meta'ya her zaman 200 dön (yoksa tekrar tekrar gönderir)
  return new Response("OK", { status: 200 });
});