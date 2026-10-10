// =========================================================
// HızlıSatıcı AI - create-store-order (mağaza vitrininden sipariş)
// Yeni yapı: sipariş "🏪 Kendi Mağazam" (own_store) ilanına göre doğrulanır,
// fiyat ilandan alınır. Dışarıya sipariş no, durum ve müşterinin takip anahtarı döner.
// POST { store_slug, product_id, listing_id, customer_name, customer_phone,
//        customer_address, customer_city, customer_district, customer_zip,
//        quantity, language }
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const db = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } },
);

function clean(v, max) {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST gerekli" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const en = String(body.language || "").toLowerCase().startsWith("en");
    const msg = (tr, eng) => (en ? eng : tr);

    const storeSlug = clean(body.store_slug, 100);
    const productId = body.product_id;
    const listingId = body.listing_id || null;
    const name = clean(body.customer_name, 120);
    const phone = clean(body.customer_phone, 30);
    const address = clean(body.customer_address, 500);
    const city = clean(body.customer_city, 60);
    const district = clean(body.customer_district, 60);
    const zip = clean(body.customer_zip, 12);
    let qty = parseInt(body.quantity, 10);
    if (!Number.isFinite(qty) || qty < 1) qty = 1;
    if (qty > 99) qty = 99;

    if (!storeSlug || !productId || !name || !phone || !address || !city || !district) {
      return json({ error: msg("Eksik bilgi: ad, telefon, adres, il ve ilçe zorunlu", "Missing info: name, phone, address, province and district are required") }, 400);
    }
    if (phone.replace(/\D/g, "").length < 7) {
      return json({ error: msg("Telefon numarası geçersiz", "Invalid phone number") }, 400);
    }

    // 1) Mağaza
    const { data: store, error: sErr } = await db
      .from("store_settings")
      .select("user_id, store_slug")
      .eq("store_slug", storeSlug)
      .maybeSingle();
    if (sErr) throw sErr;
    if (!store) return json({ error: msg("Mağaza bulunamadı", "Store not found") }, 404);

    // 2) İlan: bu mağazanın yayındaki Kendi Mağazam ilanı olmalı
    let q = db
      .from("listings")
      .select("id, product_id, price, currency")
      .eq("user_id", store.user_id)
      .eq("marketplace_code", "own_store")
      .eq("status", "published")
      .is("deleted_at", null)
      .eq("product_id", productId);
    if (listingId) q = q.eq("id", listingId);
    const { data: listing, error: lErr } = await q.limit(1).maybeSingle();
    if (lErr) throw lErr;
    if (!listing) return json({ error: msg("Ürün bulunamadı veya satışta değil", "Product not found or not for sale") }, 404);

    // 3) Ürün: silinmemiş, birleştirilmemiş, tükenmemiş
    const { data: product, error: pErr } = await db
      .from("products")
      .select("id, stock_status, deleted_at, merged_into")
      .eq("id", listing.product_id)
      .eq("user_id", store.user_id)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!product || product.deleted_at || product.merged_into) {
      return json({ error: msg("Ürün bulunamadı", "Product not found") }, 404);
    }
    if (product.stock_status === "tukendi") {
      return json({ error: msg("Bu ürün tükendi", "This product is sold out") }, 409);
    }

    // 4) Adet, fiyat (her zaman sunucudan, ilandaki fiyat) ve adres ayrı alanlarda
    const price = Number(listing.price);
    const cur = listing.currency || "TRY";

    const { data: order, error: iErr } = await db
      .from("store_orders")
      .insert({
        user_id: store.user_id,
        product_id: listing.product_id,
        listing_id: listing.id,
        customer_name: name,
        customer_phone: phone,
        customer_address: address,
        customer_city: city || null,
        customer_district: district || null,
        customer_zip: zip || null,
        customer_country: "TR",
        quantity: qty,
        unit_price: Number.isFinite(price) && price > 0 ? price : null,
        currency: cur,
        status: "pending",
      })
      .select("id, status, tracking_token")
      .single();
    if (iErr) throw iErr;

    return json({ success: true, order: { id: order.id, status: order.status, tracking_token: order.tracking_token } });
  } catch (err) {
    console.error(err);
    return json({ error: "Sunucu hatası" }, 500);
  }
});