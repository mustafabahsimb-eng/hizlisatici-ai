// =========================================================
// Baskılı ürün sorun bildirimi -> Printify yeniden gönderim talebi (tam otomatik)
// İade politikası (Mustafa, 16 Ekim 2026): siparişe özel basım; fikir değiştirme iadesi yok. Hatalı baskı, hasar ya da yanlış ürün
// fotoğrafla bildirilirse ücretsiz yeniden gönderim (Printify reprint talebi). İsimli ürün iade edilmez (kusurluysa yine yeniden basılır).
// Giriş: alıcı, Etsy'nin satış sonrası mesajındaki bağlantıdan order-help.html sayfasına gelir (Etsy API alıcı mesajlarını vermez).
// Herkese açık: { action: "report", shop, receipt, contact (e-posta ya da posta kodu), reason, description, photos: [{ name, type, data(base64) }] }
//   1) Etsy siparişi resmi API ile doğrulanır (mağaza, sipariş no, alıcı e-postası ya da posta kodu)  2) siparişte Seltigo'nun baskılı ürünü olmalı
//   3) fotoğraflar depoya  4) Printify'da siparişin bulunması (isimli siparişte yeni sipariş)  5) reprint talebi  6) satıcıya Telegram bildirimi
// Sipariş başına bir talep (pod_reprints); Printify talebi açılamazsa 30 dakikada bir yeniden denenir (cron, en fazla 6). Paket anahtarı: pod_reprint
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { etsy, etsyToken } from "../_shared/etsy.ts";
import { featureEnabled } from "../_shared/features.ts";

const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const short = (v: unknown, n = 300) => String(v ?? "").slice(0, n);
const REASONS = ["image_quality", "incorrect_item", "shipping_issues", "stained_or_damaged_item", "wrong_color_or_size", "wrong_design"];
const MAX_DAYS = 60;   // sipariş tarihinden itibaren

async function pf(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch("https://api.printify.com/v1" + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "Seltigo" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const t = await r.text(); let d: any = t; try { d = t ? JSON.parse(t) : {}; } catch { /* düz */ }
  if (!r.ok) throw new Error(`Printify ${r.status}: ${short(typeof d === "string" ? d : JSON.stringify(d), 250)}`);
  return d;
}
const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, "");

async function findPrintifyOrder(token: string, shopId: string, receipt: string) {
  const { data: po } = await db.from("pod_personal_orders").select("new_order_id").eq("etsy_receipt_id", receipt).not("new_order_id", "is", null).maybeSingle();
  if (po?.new_order_id) return await pf(token, "GET", `/shops/${shopId}/orders/${po.new_order_id}.json`);
  for (let page = 1; page <= 6; page++) {
    const d = await pf(token, "GET", `/shops/${shopId}/orders.json?limit=50&page=${page}`);
    const o = (d.data || []).find((x: any) => String(x.metadata?.shop_order_id || "") === receipt && x.status !== "canceled");
    if (o) return o;
    if (page >= (d.last_page || 1)) break;
  }
  return null;
}

// Printify yeniden gönderim talebi (ilk bildirimde ve başarısız olanlar için 30 dakikada bir, en fazla 6 deneme)
async function requestReprint(receipt: string) {
  const { data: r0 } = await db.from("pod_reprints").select("*").eq("etsy_receipt_id", receipt).maybeSingle();
  if (!r0 || r0.status === "requested") return;
  const { data: pods } = await db.from("pod_products").select("provider_shop_id, provider_product_id").eq("user_id", r0.user_id);
  const pshop = String(pods?.[0]?.provider_shop_id || "");
  const token = (Deno.env.get(`PRINTIFY_TOKEN_${pshop}`) ?? "").trim() || String((await db.from("printify_connections").select("api_token").eq("user_id", r0.user_id).maybeSingle()).data?.api_token || "").trim();
  let status = "error", err: string | null = null, requestId: string | null = null, orderId: string | null = r0.printify_order_id;
  try {
    if (!token || !pshop) throw new Error("Printify token yok");
    const o = await findPrintifyOrder(token, pshop, receipt);
    if (!o) throw new Error("Printify siparişi bulunamadı");
    orderId = String(o.id);
    const ours = new Set((pods || []).map((p: any) => String(p.provider_product_id)));
    const lines = (o.line_items || []).filter((l: any) => ours.has(String(l.product_id))).map((l: any) => ({ line_item_id: String(l.id ?? l.product_id), quantity: Number(l.quantity) || 1 }));
    const r = await pf(token, "POST", `/shops/${pshop}/orders/${o.id}/support-requests/reprint`, { reason: r0.reason, description: `${r0.description} (Etsy order ${receipt})`.slice(0, 400), image_urls: r0.photo_urls, line_items: lines });
    status = "requested"; requestId = String(r?.id ?? r?.support_request_id ?? "");
  } catch (e) { err = short((e as Error).message); }
  const attempts = (r0.attempts || 0) + 1;
  await db.from("pod_reprints").update({ status, error: err, attempts, printify_order_id: orderId, printify_request_id: requestId, updated_at: new Date().toISOString() }).eq("id", r0.id);
  if (status === "requested") await db.rpc("assistant_enqueue", { p_user: r0.user_id, p_kind: "notice", p_payload: { text: `🔁 Etsy ${receipt}: alıcı sorun bildirdi (${r0.reason}); Printify'a ücretsiz yeniden gönderim talebi açıldı.` }, p_dedupe: `reprint:${receipt}:ok` });
  else if (attempts === 1 || attempts >= 6) await db.rpc("assistant_enqueue", { p_user: r0.user_id, p_kind: "notice", p_payload: { text: `⚠️ Etsy ${receipt}: alıcı sorun bildirdi (${r0.reason}); Printify talebi açılamadı (${err}). ${attempts >= 6 ? "6 deneme bitti." : "30 dakikada bir yeniden denenecek."}` }, p_dedupe: `reprint:${receipt}:err:${attempts >= 6 ? "son" : "ilk"}` });
}

async function report(b: any) {
  const shop = String(b.shop || "").replace(/\D/g, ""), receipt = String(b.receipt || "").replace(/\D/g, "");
  const contact = norm(b.contact), reason = REASONS.includes(b.reason) ? b.reason : "stained_or_damaged_item";
  const description = short(String(b.description || "").trim(), 400);
  const photos = Array.isArray(b.photos) ? b.photos.slice(0, 5) : [];
  if (!shop || !receipt || !contact) return { ok: false, error: "Please enter your Etsy order number and the email or ZIP code used for the order." };
  if (!photos.length) return { ok: false, error: "Please add at least one photo of the problem." };
  if (description.length < 5) return { ok: false, error: "Please describe the problem in a few words." };
  const { data: conn } = await db.from("store_connections").select("id, user_id").eq("marketplace_code", "etsy").eq("external_seller_id", shop).is("deleted_at", null).limit(1).maybeSingle();
  if (!conn) return { ok: false, error: "Shop not found." };
  if (!(await featureEnabled(conn.user_id, "pod_reprint"))) return { ok: false, error: "Please message the shop on Etsy about this order." };
  const { data: prev } = await db.from("pod_reprints").select("status").eq("etsy_receipt_id", receipt).maybeSingle();
  if (prev) return { ok: true, already: true, message: "We already received a report for this order. A replacement is on its way or under review." };
  // 1) Etsy siparişi
  const { token: et, cred } = await etsyToken(db, conn.id);
  const ctx = { token: et }; const shopId = String(cred.shop_id || shop);
  let rc: any;
  try { rc = await etsy(ctx, "GET", `/shops/${shopId}/receipts/${receipt}`); } catch { return { ok: false, error: "We couldn't find this order. Please check the order number." }; }
  const zip = norm(rc.zip), email = norm(rc.buyer_email);
  if (!(contact && (contact === email || (zip && contact === zip)))) return { ok: false, error: "The email or ZIP code doesn't match this order." };
  if (Date.now() - Number(rc.create_timestamp || 0) * 1000 > MAX_DAYS * 86400_000) return { ok: false, error: "This order is too old for an automatic replacement. Please message the shop on Etsy." };
  const listingIds = (rc.transactions || []).map((t: any) => String(t.listing_id));
  const { data: pods } = await db.from("pod_products").select("provider_shop_id, provider_product_id, external_listing_id, personalized").eq("user_id", conn.user_id).in("external_listing_id", listingIds.length ? listingIds : ["-"]);
  if (!pods?.length) return { ok: false, error: "This order has no printed items covered by this form. Please message the shop on Etsy." };
  // 2) fotoğraflar
  const urls: string[] = []; const folder = `pod/reprint/${receipt}-${crypto.randomUUID().slice(0, 8)}`;
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i]; const type = /^image\/(jpeg|png|webp|heic)$/.test(String(p.type)) ? String(p.type) : "image/jpeg";
    const bytes = Uint8Array.from(atob(String(p.data || "").replace(/^data:[^,]+,/, "")), (c) => c.charCodeAt(0));
    if (bytes.length > 8_000_000) return { ok: false, error: "Each photo must be smaller than 8 MB." };
    const path = `${folder}/${i + 1}.${type.split("/")[1]}`;
    const { error } = await db.storage.from("product-images").upload(path, new Blob([bytes], { type }), { contentType: type, upsert: true });
    if (error) return { ok: false, error: "Photo upload failed. Please try again." };
    urls.push(db.storage.from("product-images").getPublicUrl(path).data.publicUrl);
  }
  const rec = { user_id: conn.user_id, etsy_shop_id: shop, etsy_receipt_id: receipt, reason, description, photo_urls: urls, personalized: pods.some((p: any) => p.personalized) };
  await db.from("pod_reprints").insert({ ...rec, status: "received" });
  await requestReprint(receipt);
  return { ok: true, message: "Thank you! We received your report and photos. A free replacement is being arranged; you'll get the new tracking number on Etsy." };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json().catch(() => ({}));
    if (b.action === "report") return json(await report(b));
    const CRON = Deno.env.get("CRON_SECRET") ?? "";
    if (CRON && String(b.cronSecret || "").trim() === CRON.trim()) {   // zamanlanmış: başarısız talepleri yeniden dene
      const { data } = await db.from("pod_reprints").select("etsy_receipt_id").eq("status", "error").lt("attempts", 6).limit(20);
      for (const r of data || []) await requestReprint(r.etsy_receipt_id);
      return json({ ok: true, retried: (data || []).length });
    }
    return json({ ok: false, error: "Geçersiz işlem" }, 400);
  } catch (e) {
    return json({ ok: false, error: "Something went wrong. Please try again or message the shop on Etsy." }, 500);
  }
});
