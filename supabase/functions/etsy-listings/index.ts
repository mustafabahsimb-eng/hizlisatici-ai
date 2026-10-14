// =========================================================
// Etsy ilanları — bir ilanı Etsy'ye gönderir (büyük dosyalar yüzünden ilan başına ayrı çağrı)
// Sistem (CRON_SECRET):
//   { action: "push", listingId }        -> taslak / güncelle + görseller + dosyalar (+ istenirse yayınla); sonuç ilana yazılır
//   { action: "deactivate", listingId }  -> Etsy'de satıştan kaldır (state=inactive)
//   { action: "ping" }                   -> anahtar teşhisi (değer döndürmez)
//   { action: "selftest", userId?, keep? } -> gerçek mağazada test taslağı (görsel + PDF) aç, geri oku, sil (yayınlamaz)
//   { action: "connect_status", userId } -> son Etsy bağlanma denemesinin sonucu
// Satıcı (userAccessToken): { action: "push", listingId } -> elle tekrar dene
// Yayınlama tercihi: listings.attributes.etsy_publish = true ("Gönder ve yayınla"); yoksa TASLAK ("Taslak olarak gönder", varsayılan)
// sync-worker Etsy ilanlarını buraya devreder (beklemeden, arka planda).
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { ETSY_CLIENT_ID, convertPrice, etsy, etsyShopCurrency, etsyToken } from "../_shared/etsy.ts";
import { submitEtsyListing } from "../_shared/etsy-listing.ts";
import { featureEnabled, FEATURE_OFF_MSG } from "../_shared/features.ts";

const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const short = (v: unknown, n = 300) => String(v ?? "").slice(0, n);

async function connFor(listing: any) {
  let q = db.from("store_connections").select("id, user_id, status, external_seller_id").eq("marketplace_code", "etsy").is("deleted_at", null);
  q = listing.connection_id ? q.eq("id", listing.connection_id) : q.eq("user_id", listing.user_id).eq("status", "connected");
  const { data } = await q.limit(1).maybeSingle();
  return data;
}

async function push(listingId: string, userId?: string) {
  let lq = db.from("listings").select("*").eq("id", listingId).eq("marketplace_code", "etsy");
  if (userId) lq = lq.eq("user_id", userId);
  const { data: listing } = await lq.maybeSingle();
  if (!listing) return { ok: false, error: "Etsy ilanı bulunamadı" };
  const now = new Date().toISOString();
  const fail = async (msg: string, extra: Record<string, unknown> = {}) => {
    await db.from("listings").update({ last_sync_error: short(msg, 300), validated_at: now, validation: { ...(listing.validation || {}), ok: false, errors: [msg], checked_at: now, ...extra } }).eq("id", listing.id);
    return { ok: false, error: msg };
  };
  if (!(await featureEnabled(listing.user_id, "etsy"))) return await fail(FEATURE_OFF_MSG);
  const conn = await connFor(listing);
  if (!conn || conn.status !== "connected") return await fail("Etsy mağazası bağlı değil (Hesaplarım > Etsy)");
  let token: string, cred: any;
  try { ({ token, cred } = await etsyToken(db, conn.id)); } catch (e) { return await fail(friendly(e)); }
  const shopId = String(cred.shop_id || conn.external_seller_id || "");
  if (!shopId) return await fail("Etsy mağaza numarası yok; Etsy'yi yeniden bağla");
  const { data: product } = await db.from("products").select("*").eq("id", listing.product_id).maybeSingle();
  if (!product) return await fail("Ürün bulunamadı");
  const { data: imgs } = await db.from("product_images").select("url, position").eq("product_id", product.id).is("deleted_at", null).order("position");
  const images = (imgs || []).filter((i: any) => /^https?:\/\//.test(i.url)).map((i: any) => ({ url: i.url }));
  if (!images.length && product.image_url) images.push({ url: product.image_url });
  const { data: files } = await db.from("product_files").select("id, path, name, rank").eq("product_id", product.id).order("rank");
  try {
    // Fiyat mağazanın para biriminde gider. Klasörden yüklemede fiyat zaten mağaza para birimindedir (attributes.etsy_shop_currency_price).
    const shopCur = await etsyShopCurrency({ token }, shopId, cred);
    let price = Number(listing.price) || 0;
    if (listing.attributes?.etsy_shop_currency_price !== true && listing.currency && listing.currency.toUpperCase() !== shopCur) {
      const conv = await convertPrice(db, price, listing.currency, shopCur);
      if (conv == null) return await fail(`Kur bulunamadı (${listing.currency} → ${shopCur}); fiyat çevrilemedi`);
      price = conv;
    }
    const r = await submitEtsyListing({
      db, ctx: { token }, shopId, listing: { ...listing, price }, product, images, files: files || [],
      publish: listing.attributes?.etsy_publish === true,
      download: async (path) => { const { data, error } = await db.storage.from("product-files").download(path); if (error || !data) throw new Error("depodan okunamadı"); return data; },
    });
    await db.from("listings").update({
      external_listing_id: r.listingId, external_url: r.url, validated_at: now,
      ...(listing.attributes?.etsy_shop_currency_price === true && listing.currency !== shopCur ? { currency: shopCur } : {}),
      last_sync_error: r.ok ? (r.state === "active" ? null : "etsy_draft") : short(r.errors.join(" · "), 300),
      validation: { ok: r.ok, dry_run: false, errors: r.errors.map((m) => ({ code: "etsy", msg: m })), warnings: r.warnings.map((m) => ({ code: "etsy", msg: m })), etsy: r.etsy, checked_at: now },
      ...(r.state === "active" && !listing.published_at ? { published_at: now } : {}),
    }).eq("id", listing.id);
    return { ok: r.ok, listingId: r.listingId, state: r.state, url: r.url, errors: r.errors, warnings: r.warnings };
  } catch (e) {
    return await fail(friendly(e));
  }
}

// Etsy hatalarını satıcının anlayacağı Türkçeye çevir
function friendly(e: unknown): string {
  const msg = (e as Error).message || String(e);
  if (/API key not found|not active|shared secret/i.test(msg)) return "Etsy uygulama anahtarı etkin değil ya da gizli anahtar yanlış (Etsy > Your Apps sayfası kontrol edilmeli)";
  const low = /price_too_low[\s\S]*?min price ([\d.,]+ ?[A-Z]{0,3})/.exec(msg);
  if (low) return `Etsy'de fiyat çok düşük: mağazan için en düşük fiyat ${low[1].trim()}. Fiyatı yükselt.`;
  if (/Etsy 401|invalid_token|expired/i.test(msg)) return "Etsy oturumu geçersiz; Hesaplarım'dan Etsy'yi yeniden bağla";
  if (/Etsy 403/i.test(msg)) return "Etsy bu işlem için izin vermedi (mağaza izinleri): Etsy'yi yeniden bağla";
  return msg.startsWith("Etsy") ? msg : "Etsy: " + msg;
}

async function deactivate(listingId: string) {
  const { data: listing } = await db.from("listings").select("*").eq("id", listingId).eq("marketplace_code", "etsy").maybeSingle();
  const eid = listing?.validation?.etsy?.listing_id || listing?.external_listing_id;
  if (!listing || !eid) return { ok: true, skipped: "Etsy'de ilan yok" };
  const conn = await connFor(listing);
  if (!conn) return { ok: false, error: "Etsy bağlı değil" };
  const { token, cred } = await etsyToken(db, conn.id);
  const shopId = String(cred.shop_id || conn.external_seller_id);
  const state = listing.validation?.etsy?.state;
  if (state === "active") await etsy({ token }, "PATCH", `/shops/${shopId}/listings/${eid}`, { form: { state: "inactive" } });
  await db.from("listings").update({ validation: { ...(listing.validation || {}), etsy: { ...(listing.validation?.etsy || {}), state: state === "active" ? "inactive" : state } } }).eq("id", listing.id);
  return { ok: true };
}

// Gerçek mağazada uçtan uca deneme (Seltigo'da ürün oluşturmaz): test taslağı aç -> görsel + PDF yükle -> Etsy'den geri oku -> sil
// Yayınlamaz (ücret yok). keep=true verilirse taslak silinmez.
async function selftest(userId: string | null, keep: boolean) {
  let q = db.from("store_connections").select("id, user_id, label, external_seller_id").eq("marketplace_code", "etsy").eq("status", "connected").is("deleted_at", null).order("updated_at", { ascending: false });
  if (userId) q = q.eq("user_id", userId);
  const { data: conn } = await q.limit(1).maybeSingle();
  if (!conn) return { ok: false, error: "Bağlı Etsy mağazası yok" };
  const steps: Record<string, unknown> = { shop: conn.label };
  const { token, cred } = await etsyToken(db, conn.id);
  const shopId = String(cred.shop_id || conn.external_seller_id);
  const shopCur = await etsyShopCurrency({ token }, shopId, cred);
  const testPrice = (await convertPrice(db, 5, "USD", shopCur)) ?? 500;
  steps.currency = shopCur; steps.price = testPrice;
  const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");
  let r: Awaited<ReturnType<typeof submitEtsyListing>>;
  try { r = await submitEtsyListing({
    db, ctx: { token }, shopId, publish: false,
    listing: { id: "selftest", title: "Seltigo Test Draft - Please Ignore", description: "Automated connection test by Seltigo. This draft is deleted right away.", price: testPrice, keywords: ["seltigo test"], validation: null },
    product: { id: 0, product_type: "digital", name: "Seltigo Test" },
    images: [{ url: "https://mustafabahsimb-eng.github.io/hizlisatici-ai/chrome-extension/icons/icon128.png" }],
    files: [{ id: "t1", path: "-", name: "seltigo-test.pdf", rank: 1 }],
    download: async () => new Blob([pdf], { type: "application/pdf" }),
  }); } catch (e) { return { ok: false, steps, error: friendly(e) }; }
  steps.created = { ok: r.ok, listingId: r.listingId, state: r.state, errors: r.errors, warnings: r.warnings, images: r.etsy.images?.length || 0, files: r.etsy.files?.length || 0 };
  if (r.listingId) {
    try {
      const got = await etsy({ token }, "GET", `/listings/${r.listingId}`, { query: { includes: "Images" } });
      steps.readBack = { state: got.state, title: got.title, type: got.listing_type, who_made: got.who_made, when_made: got.when_made, is_supply: got.is_supply, taxonomy_id: got.taxonomy_id, images: (got.images || []).length };
    } catch (e) { steps.readBack = { error: (e as Error).message }; }
    try {
      const fl = await etsy({ token }, "GET", `/shops/${shopId}/listings/${r.listingId}/files`);
      steps.filesBack = (fl.results || []).map((f: any) => ({ name: f.filename, size: f.filesize }));
    } catch (e) { steps.filesBack = { error: (e as Error).message }; }
    if (!keep) {
      try { await etsy({ token }, "DELETE", `/listings/${r.listingId}`); steps.deleted = true; } catch (e) { steps.deleted = { error: (e as Error).message }; }
    }
  }
  return { ok: r.ok && !!r.listingId, steps };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const b = await req.json().catch(() => ({}));
  try {
    if (CRON_SECRET && String(b?.cronSecret || "").trim() === CRON_SECRET.trim()) {
      if (b.action === "push" && b.listingId) return json(await push(String(b.listingId)));
      if (b.action === "deactivate" && b.listingId) return json(await deactivate(String(b.listingId)));
      if (b.action === "selftest") return json(await selftest(b.userId ? String(b.userId) : null, b.keep === true));
      if (b.action === "connect_status" && b.userId) {
        const { data } = await db.from("app_cache").select("value").eq("key", "etsy_connect:" + String(b.userId)).maybeSingle();
        return json({ ok: true, last: data?.value || null });
      }
      if (b.action === "ping") {
        const raw = Deno.env.get("ETSY_SHARED_SECRET") ?? "";
        const out: Record<string, unknown> = { secretLength: raw.length, keystringLength: ETSY_CLIENT_ID.length };
        for (const [k, v] of Object.entries({ keystring: ETSY_CLIENT_ID, "keystring:secret": `${ETSY_CLIENT_ID}:${raw.trim()}` })) {
          const r = await fetch("https://api.etsy.com/v3/application/openapi-ping", { headers: { "x-api-key": v } });
          out[k] = { status: r.status, body: (await r.text()).slice(0, 160) };
        }
        return json(out);
      }
      return json({ error: "Geçersiz işlem" }, 400);
    }
    const token = String(b?.userAccessToken || "").trim();
    const { data } = token ? await db.auth.getUser(token) : { data: { user: null } };
    const userId = data?.user?.id;
    if (!userId) return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);
    if (b.action === "push" && b.listingId) return json(await push(String(b.listingId), userId));
    return json({ error: "Geçersiz işlem" }, 400);
  } catch (e) {
    return json({ ok: false, error: short((e as Error).message) }, 500);
  }
});
