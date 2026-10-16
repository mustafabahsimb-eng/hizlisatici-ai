// =========================================================
// Etsy ilanları — bir ilanı Etsy'ye gönderir (büyük dosyalar yüzünden ilan başına ayrı çağrı)
// Sistem (CRON_SECRET):
//   { action: "push", listingId }        -> taslak / güncelle + görseller + dosyalar (+ istenirse yayınla); sonuç ilana yazılır
//   { action: "deactivate", listingId }  -> Etsy'de satıştan kaldır (state=inactive)
//   { action: "ping" }                   -> anahtar teşhisi (değer döndürmez)
//   { action: "selftest", userId?, keep? } -> gerçek mağazada test taslağı (görsel + PDF) aç, geri oku, sil (yayınlamaz)
//   { action: "connect_status", userId } -> son Etsy bağlanma denemesinin sonucu
//   { action: "stock_photos", query, perPage?, page?, orientation? } -> Pexels arama (ilan kapağı sahnesi için)
//   { action: "shop_listings", userId }  -> mağazadaki Etsy ilanları (devralma için)
//   { action: "listing_info", userId, etsyListingId } -> Etsy'deki ilanı oku (doğrulama)
//   { action: "signed_upload", bucket, path | paths[] } -> depoya imzalı yükleme adresi (sistem toplu yüklemesi)
//   { action: "organize", userId, sections?: [{ title, listingIds[] }], featured?: [etsyListingId…] }
//        -> mağaza bölümlerini oluştur (yoksa; verilen sırayla), ilanları bölümlere yerleştir, öne çıkan ilanları sırala (featured_rank)
//   { action: "listing_personalization", userId, etsyListingId, instructions, charMax?, required? } -> Etsy kişiselleştirme kutusunu aç
//   { action: "shipping_profile_fx", userId, profileId, rate } -> Printify kargo profilini mağaza para birimine çevir
//   { action: "listing_shipping", userId, etsyListingId } -> ilanın kargo profili
//   { action: "set_images", userId, etsyListingId, urls[] } -> ilan görsellerini bu sırayla değiştir (önce yükle, sonra eskileri sil)
//   { action: "us_shipping_profile", userId, title, listingIds[], sourceProfileId?, primary?, … } -> yalnız ABD kargo profili + ilanlara ata
//   { action: "return_policy", userId, listingIds[] } -> iade / değişim yok politikası + ilanlara ata
//   { action: "shop_texts", userId, saleMessage?, policyAdditional? } -> satış sonrası mesaj, ek politika metni
//   { action: "market_prices", queries[] } -> rakip fiyat ortancası (USD; resmi arama)
//   { action: "holiday_notice", userId, etsyListingIds[], line | null, announcement? } -> açıklama + mağaza duyurusunda Noel teslim satırı
//   { action: "listing_price", userId, etsyListingId, price } -> tek fiyatlı ilanın (dijital vb.) fiyatı, mağaza para biriminde (ilan numarası değişmez)
//   { action: "listing_state", userId, etsyListingIds[], state: "active" | "inactive" }
//        -> ilanları yayına al / pasife al (SİLMEZ; yorum ve satış geçmişi ilanda kalır)
// Satıcı (userAccessToken): { action: "push", listingId } -> elle tekrar dene
// Yayınlama tercihi: listings.attributes.etsy_publish = true ("Gönder ve yayınla"); yoksa TASLAK ("Taslak olarak gönder", varsayılan)
// sync-worker Etsy ilanlarını buraya devreder (beklemeden, arka planda).
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { ETSY_CLIENT_ID, convertPrice, etsy, etsyApiKey, etsyShopCurrency, etsyToken } from "../_shared/etsy.ts";
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

async function userShop(userId: string) {
  const { data: conn } = await db.from("store_connections").select("id, external_seller_id").eq("marketplace_code", "etsy").eq("status", "connected").eq("user_id", userId).is("deleted_at", null).limit(1).maybeSingle();
  if (!conn) throw new Error("Bağlı Etsy mağazası yok");
  const { token, cred } = await etsyToken(db, conn.id);
  return { ctx: { token }, shopId: String(cred.shop_id || conn.external_seller_id) };
}

// Mağaza düzeni: bölümler (Etsy en fazla 20 bölüm, ad en fazla 24 karakter) + öne çıkan ilanlar (featured_rank 1..n)
async function organize(userId: string, sections: { title: string; listingIds: string[] }[], featured: string[]) {
  const { ctx, shopId } = await userShop(userId);
  const have = (await etsy(ctx, "GET", `/shops/${shopId}/sections`)).results || [];
  const report: Record<string, unknown>[] = [];
  for (const s of sections) {
    const title = String(s.title || "").trim().slice(0, 24);
    if (!title) continue;
    let sec = have.find((x: any) => String(x.title).toLowerCase() === title.toLowerCase());
    if (!sec) { sec = await etsy(ctx, "POST", `/shops/${shopId}/sections`, { form: { title } }); have.push(sec); }
    const placed: string[] = [], failed: string[] = [];
    for (const id of s.listingIds || []) {
      try { await etsy(ctx, "PATCH", `/shops/${shopId}/listings/${id}`, { form: { shop_section_id: sec.shop_section_id } }); placed.push(String(id)); }
      catch (e) { failed.push(`${id}: ${(e as Error).message}`); }
    }
    report.push({ section: title, shop_section_id: sec.shop_section_id, placed: placed.length, failed });
  }
  const feat: Record<string, unknown>[] = [];
  for (let i = 0; i < featured.length; i++) {
    try { await etsy(ctx, "PATCH", `/shops/${shopId}/listings/${featured[i]}`, { form: { featured_rank: i + 1 } }); feat.push({ id: featured[i], rank: i + 1, ok: true }); }
    catch (e) { feat.push({ id: featured[i], rank: i + 1, ok: false, error: (e as Error).message }); }
  }
  return { ok: report.every((r: any) => !r.failed.length) && feat.every((f) => f.ok), sections: report, featured: feat };
}

// Noel teslim satırı: ilan açıklamasının en üstüne ve mağaza duyurusuna tek satır (line=null -> satırı kaldır).
// Önceki satır bu kalıpla tanınıp değiştirilir; açıklamanın geri kalanına dokunulmaz.
export const HOLIDAY_RE = /^((🎄 )?Order by .+ for (Christmas delivery|delivery before Christmas)|⚠️ Orders placed now may arrive after Christmas)/;
export function withHolidayLine(text: string, line: string | null): string {
  const rest = String(text || "").split("\n").filter((l) => !HOLIDAY_RE.test(l.trim())).join("\n").replace(/^\s*\n/, "");
  return line ? `${line}\n\n${rest}`.trim() : rest.trim();
}
async function holidayNotice(userId: string, ids: string[], line: string | null, announcement: boolean) {
  const { ctx, shopId } = await userShop(userId);
  const out: Record<string, unknown>[] = [];
  for (const id of ids) {
    try {
      const l = await etsy(ctx, "GET", `/listings/${id}`);
      const next = withHolidayLine(l.description, line);
      if (next !== String(l.description || "").trim()) await etsy(ctx, "PATCH", `/shops/${shopId}/listings/${id}`, { form: { description: next } });
      out.push({ id, ok: true });
    } catch (e) { out.push({ id, ok: false, error: friendly(e) }); }
  }
  let shop: Record<string, unknown> | null = null;
  if (announcement) {
    try {
      const s = await etsy(ctx, "GET", `/shops/${shopId}`);
      const next = withHolidayLine(s.announcement || "", line);
      if (next !== String(s.announcement || "").trim()) await etsy(ctx, "PUT", `/shops/${shopId}`, { form: { announcement: next } });
      shop = { ok: true };
    } catch (e) { shop = { ok: false, error: friendly(e) }; }
  }
  return { ok: out.every((x) => x.ok) && (!shop || shop.ok === true), listings: out, announcement: shop };
}

// Sezon modülü: ilanı yayına al / pasife al. Pasif ilan Etsy'de silinmez; yeniden açılınca yorum ve satış geçmişi geri gelir.
// (Etsy pasif ilanı yeniden yayına alırken ilan ücreti alır.)
async function listingState(userId: string, ids: string[], state: "active" | "inactive") {
  const { ctx, shopId } = await userShop(userId);
  const out: Record<string, unknown>[] = [];
  for (const id of ids) {
    try { const d = await etsy(ctx, "PATCH", `/shops/${shopId}/listings/${id}`, { form: { state } }); out.push({ id, ok: true, state: d.state }); }
    catch (e) { out.push({ id, ok: false, error: friendly(e) }); }
  }
  return { ok: out.every((x) => x.ok), results: out };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const b = await req.json().catch(() => ({}));
  try {
    if (CRON_SECRET && String(b?.cronSecret || "").trim() === CRON_SECRET.trim()) {
      if (b.action === "push" && b.listingId) return json(await push(String(b.listingId)));
      if (b.action === "deactivate" && b.listingId) return json(await deactivate(String(b.listingId)));
      if (b.action === "selftest") return json(await selftest(b.userId ? String(b.userId) : null, b.keep === true));
      if (b.action === "organize" && b.userId) return json(await organize(String(b.userId), Array.isArray(b.sections) ? b.sections : [], Array.isArray(b.featured) ? b.featured.map(String) : []));
      // Kişiselleştirme kutusu (Printify'ın yayınladığı ilanda da): alıcının yazdığı metin pod-personalize ile baskıya girer
      if (b.action === "listing_personalization" && b.userId && b.etsyListingId) {
        const { ctx, shopId } = await userShop(String(b.userId));
        // Etsy'nin yeni kişiselleştirme uç noktası (updateListingPersonalization; eski is_personalizable alanları artık işlemiyor).
        // Soru başlığı "Personalization" içerir: siparişte variations.formatted_name olarak gelir, pod-personalize bununla bulur.
        const d = await etsy(ctx, "POST", `/shops/${shopId}/listings/${String(b.etsyListingId)}/personalization`, { json: { personalization_questions: [{
          question_text: String(b.question || "Personalization").slice(0, 45), question_type: "text_input", required: b.required !== false,
          instructions: String(b.instructions || "").slice(0, 1024) || null, max_allowed_characters: Math.min(1024, Number(b.charMax) || 120) }] } });
        const back = await etsy(ctx, "GET", `/listings/${String(b.etsyListingId)}/personalization`).catch(() => d);
        return json({ ok: true, personalization: back });
      }
      // İlanın kargo profili (alıcıdan alınan kargo ücreti): Printify'ın Etsy'de kurduğu profil dahil
      if (b.action === "listing_shipping" && b.userId && b.etsyListingId) {
        const { ctx, shopId } = await userShop(String(b.userId));
        const l = await etsy(ctx, "GET", `/listings/${String(b.etsyListingId)}`);
        const sp = l.shipping_profile_id ? await etsy(ctx, "GET", `/shops/${shopId}/shipping-profiles/${l.shipping_profile_id}`) : null;
        return json({ ok: true, price: l.price, shipping_profile_id: l.shipping_profile_id, title: sp?.title, processing: [sp?.min_processing_days, sp?.max_processing_days],
          destinations: (sp?.shipping_profile_destinations || []).map((d: any) => ({ to: d.destination_country_iso || d.destination_region, first: d.primary_cost, additional: d.secondary_cost, days: [d.min_delivery_days, d.max_delivery_days] })) });
      }
      // Printify, kargo profilini mağaza para birimine ÇEVİRMEDEN yazar (TRY mağazada 8,79 $ -> 8,79 TL). Çevrilmemiş tutarları kurla düzelt.
      // Koruma: yalnız maxUnconverted (varsayılan 100) altındaki tutarlar çevrilir; iki kez çalışsa da tutarlar ikinci kez çarpılmaz.
      if (b.action === "shipping_profile_fx" && b.userId && b.profileId && Number(b.rate) > 1) {
        const { ctx, shopId } = await userShop(String(b.userId));
        const base = `/shops/${shopId}/shipping-profiles/${String(b.profileId)}`;
        const sp = await etsy(ctx, "GET", base); const lim = Number(b.maxUnconverted) || 100; const out: any[] = [];
        const amt = (m: any) => (m ? Number(m.amount) / (Number(m.divisor) || 100) : 0);
        for (const d of sp.shipping_profile_destinations || []) {
          const p = amt(d.primary_cost), s = amt(d.secondary_cost);
          if (p >= lim) { out.push({ id: d.shipping_profile_destination_id, skipped: "zaten çevrilmiş", primary: p }); continue; }
          const np = Math.round(p * Number(b.rate) * 100) / 100, ns = Math.round(s * Number(b.rate) * 100) / 100;
          try {
            await etsy(ctx, "PUT", `${base}/destinations/${d.shipping_profile_destination_id}`, { form: { primary_cost: np.toFixed(2), secondary_cost: ns.toFixed(2) } });
            out.push({ to: d.destination_country_iso || d.destination_region, from: p, primary: np, secondary: ns });
          } catch (e) { out.push({ id: d.shipping_profile_destination_id, error: friendly(e) }); }
        }
        return json({ ok: out.every((x) => !x.error), title: sp.title, destinations: out });
      }
      // İlanın görsellerini verilen sırayla değiştir (giyim görsel düzeni: kapak, düz ürün, renkler, beden tablosu).
      // Önce yeniler yüklenir (sıra 1..n), sonra eskiler silinir: yayındaki ilan hiçbir an görselsiz kalmaz. Etsy sınırı 20 görsel.
      if (b.action === "set_images" && b.userId && b.etsyListingId && Array.isArray(b.urls) && b.urls.length) {
        const { ctx, shopId } = await userShop(String(b.userId)); const id = String(b.etsyListingId);
        const base = `/shops/${shopId}/listings/${id}/images`;
        const old = ((await etsy(ctx, "GET", `/listings/${id}/images`)).results || []).map((x: any) => x.listing_image_id);
        const urls = b.urls.slice(0, 10).map(String);
        // yer aç: toplam 20'yi aşacaksa fazlası önceden silinir (en az bir eski görsel kalır)
        let extra = old.length + urls.length - 20; const removed: number[] = [];
        while (extra-- > 0 && old.length - removed.length > 1) { const x = old[old.length - 1 - removed.length]; await etsy(ctx, "DELETE", `${base}/${x}`).catch(() => {}); removed.push(x); }
        const added: number[] = [];
        for (let i = 0; i < urls.length; i++) {
          const r = await fetch(urls[i], { signal: AbortSignal.timeout(60000) });
          if (!r.ok) return json({ ok: false, error: `görsel indirilemedi (${i + 1})`, added });
          const fd = new FormData(); fd.append("image", await r.blob(), `image-${i + 1}.jpg`); fd.append("rank", String(i + 1));
          const d = await etsy(ctx, "POST", base, { multipart: fd }); added.push(d.listing_image_id);
        }
        for (const x of old.filter((x: number) => !removed.includes(x))) await etsy(ctx, "DELETE", `${base}/${x}`).catch(() => {});
        const now = ((await etsy(ctx, "GET", `/listings/${id}/images`)).results || []).sort((a: any, z: any) => a.rank - z.rank);
        return json({ ok: now.length === urls.length && now.every((x: any, i: number) => x.listing_image_id === added[i]), count: now.length, images: now.map((x: any) => ({ rank: x.rank, url: x.url_570xN })) });
      }
      // Yalnız ABD'ye kargo profili (yoksa oluşturulur; başlıkla bulunur) + ilanlara atanır. Gönderim yeri kaynak profilden (Printify'ın) alınır.
      if (b.action === "us_shipping_profile" && b.userId && b.title && Array.isArray(b.listingIds)) {
        const { ctx, shopId } = await userShop(String(b.userId));
        const list = (await etsy(ctx, "GET", `/shops/${shopId}/shipping-profiles`)).results || [];
        let sp = list.find((p: any) => p.title === String(b.title));
        if (!sp) {
          const src = b.sourceProfileId ? await etsy(ctx, "GET", `/shops/${shopId}/shipping-profiles/${String(b.sourceProfileId)}`) : null;
          sp = await etsy(ctx, "POST", `/shops/${shopId}/shipping-profiles`, { form: {
            title: String(b.title).slice(0, 100), origin_country_iso: src?.origin_country_iso || "US", origin_postal_code: src?.origin_postal_code || b.originPostal || undefined,
            destination_country_iso: "US", primary_cost: Number(b.primary || 0).toFixed(2), secondary_cost: Number(b.secondary || 0).toFixed(2),
            min_processing_time: Number(b.minProcessing) || 2, max_processing_time: Number(b.maxProcessing) || 5, processing_time_unit: "business_days",
            min_delivery_days: Number(b.minDelivery) || 2, max_delivery_days: Number(b.maxDelivery) || 5 } });
        }
        const assigned: any[] = [];
        for (const id of b.listingIds.map(String)) {
          try { await etsy(ctx, "PATCH", `/shops/${shopId}/listings/${id}`, { form: { shipping_profile_id: sp.shipping_profile_id } }); assigned.push({ id, ok: true }); }
          catch (e) { assigned.push({ id, ok: false, error: friendly(e) }); }
        }
        const full = await etsy(ctx, "GET", `/shops/${shopId}/shipping-profiles/${sp.shipping_profile_id}`);
        return json({ ok: assigned.every((x) => x.ok), profileId: sp.shipping_profile_id, destinations: (full.shipping_profile_destinations || []).map((d: any) => ({ to: d.destination_country_iso || d.destination_region, first: d.primary_cost })), assigned });
      }
      // İade politikası (Etsy return policy): iade / değişim yok (siparişe özel basım) — kusurlu ürüne ücretsiz yeniden gönderim açıklamada ve mağaza politikasında
      if (b.action === "return_policy" && b.userId && Array.isArray(b.listingIds)) {
        const { ctx, shopId } = await userShop(String(b.userId));
        const pols = (await etsy(ctx, "GET", `/shops/${shopId}/policies/return`)).results || [];
        let pol = pols.find((p: any) => p.accepts_returns === false && p.accepts_exchanges === false);
        if (!pol) pol = await etsy(ctx, "POST", `/shops/${shopId}/policies/return`, { form: { accepts_returns: false, accepts_exchanges: false } });
        const assigned: any[] = [];
        for (const id of b.listingIds.map(String)) {
          try { await etsy(ctx, "PATCH", `/shops/${shopId}/listings/${id}`, { form: { return_policy_id: pol.return_policy_id } }); assigned.push({ id, ok: true }); }
          catch (e) { assigned.push({ id, ok: false, error: friendly(e) }); }
        }
        return json({ ok: assigned.every((x) => x.ok), returnPolicyId: pol.return_policy_id, assigned });
      }
      // Mağaza metinleri: satış sonrası mesaj (her alıcıya Etsy gönderir) ve ek politika metni
      if (b.action === "shop_texts" && b.userId) {
        const { ctx, shopId } = await userShop(String(b.userId));
        const form: Record<string, unknown> = {};
        if (typeof b.saleMessage === "string") form.sale_message = b.saleMessage.slice(0, 2000);
        if (typeof b.policyAdditional === "string") form.policy_additional = b.policyAdditional.slice(0, 5000);
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(form)) {   // alan alan: biri reddedilirse diğeri yine yazılır
          try { await etsy(ctx, "PUT", `/shops/${shopId}`, { form: { [k]: v } }); out[k] = "ok"; } catch (e) { out[k] = friendly(e); }
        }
        return json({ ok: Object.values(out).every((x) => x === "ok"), fields: out });
      }
      // Rakip fiyatları (resmi findAllListingsActive): arama başına ilk 100 ilanın USD fiyatı ve ortancası
      if (b.action === "market_prices" && Array.isArray(b.queries)) {
        const out: Record<string, unknown> = {};
        for (const kw of b.queries.slice(0, 20).map(String)) {
          const q = new URLSearchParams({ keywords: kw, limit: "100", sort_on: "score" });
          const r = await fetch("https://api.etsy.com/v3/application/listings/active?" + q, { headers: { "x-api-key": etsyApiKey() } });
          if (!r.ok) { out[kw] = { error: r.status }; continue; }
          const d = await r.json(); const usd: number[] = [];
          for (const l of d.results || []) {
            const amt = Number(l.price?.amount) / (Number(l.price?.divisor) || 100); const cur = String(l.price?.currency_code || "USD");
            const v = cur === "USD" ? amt : await convertPrice(db, amt, cur, "USD");
            if (v && v > 0) usd.push(v);
          }
          usd.sort((a, z) => a - z);
          const med = usd.length ? (usd.length % 2 ? usd[(usd.length - 1) / 2] : (usd[usd.length / 2 - 1] + usd[usd.length / 2]) / 2) : null;
          out[kw] = { count: d.count, sample: usd.length, median_usd: med && Math.round(med * 100) / 100, p25: usd[Math.floor(usd.length * 0.25)] ?? null, p75: usd[Math.floor(usd.length * 0.75)] ?? null };
        }
        return json({ ok: true, prices: out });
      }
      if (b.action === "holiday_notice" && b.userId && Array.isArray(b.etsyListingIds)) {
        return json(await holidayNotice(String(b.userId), b.etsyListingIds.map(String), b.line ? String(b.line).slice(0, 200) : null, b.announcement !== false));
      }
      if (b.action === "listing_price" && b.userId && b.etsyListingId && Number(b.price) > 0) {
        const { ctx } = await userShop(String(b.userId)); const id = String(b.etsyListingId); const price = Math.round(Number(b.price) * 100) / 100;
        const inv = await etsy(ctx, "GET", `/listings/${id}/inventory`);
        if ((inv.price_on_property || []).length) return json({ ok: false, error: "Bu ilanda fiyat seçeneğe göre değişiyor; tek fiyat yazılamaz" });
        const products = (inv.products || []).map((pr: any) => ({ sku: pr.sku || "", property_values: pr.property_values || [],
          offerings: (pr.offerings || []).map((o: any) => ({ price, quantity: o.quantity, is_enabled: o.is_enabled !== false })) }));
        await etsy(ctx, "PUT", `/listings/${id}/inventory`, { json: { products, price_on_property: [], quantity_on_property: inv.quantity_on_property || [], sku_on_property: inv.sku_on_property || [] } });
        const back = await etsy(ctx, "GET", `/listings/${id}`);
        return json({ ok: true, listing_id: back.listing_id, price: back.price });
      }
      if (b.action === "listing_state" && b.userId && Array.isArray(b.etsyListingIds) && ["active", "inactive"].includes(b.state)) {
        return json(await listingState(String(b.userId), b.etsyListingIds.map(String), b.state));
      }
      if (b.action === "connect_status" && b.userId) {
        const { data } = await db.from("app_cache").select("value").eq("key", "etsy_connect:" + String(b.userId)).maybeSingle();
        return json({ ok: true, last: data?.value || null });
      }
      // Mağazadaki ilanlar (Seltigo dışında açılmış ilanları devralmak için)
      if (b.action === "shop_listings" && b.userId) {
        const { data: conn } = await db.from("store_connections").select("id, external_seller_id").eq("marketplace_code", "etsy").eq("status", "connected").eq("user_id", String(b.userId)).is("deleted_at", null).limit(1).maybeSingle();
        if (!conn) return json({ ok: false, error: "Bağlı Etsy mağazası yok" });
        const { token, cred } = await etsyToken(db, conn.id);
        const shopId = String(cred.shop_id || conn.external_seller_id);
        const out: any[] = [];
        for (const st of ["active", "draft", "inactive"]) {
          const d = await etsy({ token }, "GET", `/shops/${shopId}/listings`, { query: { state: st, limit: "100" } });
          for (const l of d.results || []) out.push({ id: l.listing_id, state: l.state, title: l.title, url: l.url, auto_renew: l.should_auto_renew, price: l.price });
        }
        return json({ ok: true, shopId, listings: out });
      }
      // Etsy'deki ilanı oku (doğrulama): durum, otomatik yenileme, görseller, dosyalar
      if (b.action === "listing_info" && b.userId && b.etsyListingId) {
        const { data: conn } = await db.from("store_connections").select("id, external_seller_id").eq("marketplace_code", "etsy").eq("status", "connected").eq("user_id", String(b.userId)).is("deleted_at", null).limit(1).maybeSingle();
        if (!conn) return json({ ok: false, error: "Bağlı Etsy mağazası yok" });
        const { token, cred } = await etsyToken(db, conn.id);
        const shopId = String(cred.shop_id || conn.external_seller_id); const id = String(b.etsyListingId);
        const l = await etsy({ token }, "GET", `/listings/${id}`, { query: { includes: "Images" } });
        const fl = l.listing_type === "download" ? await etsy({ token }, "GET", `/shops/${shopId}/listings/${id}/files`) : { results: [] };
        // Seçenekler (renk / beden): envanterdeki özellik değerleri
        const inv = l.listing_type === "download" ? null : await etsy({ token }, "GET", `/listings/${id}/inventory`).catch(() => null);
        const opts: Record<string, string[]> = {};
        for (const p of inv?.products || []) for (const v of p.property_values || []) { const k = String(v.property_name); opts[k] = [...new Set([...(opts[k] || []), ...(v.values || [])])]; }
        return json({ ok: true, state: l.state, title: l.title, auto_renew: l.should_auto_renew, price: l.price, tags: l.tags, taxonomy_id: l.taxonomy_id, type: l.listing_type,
          description_end: String(l.description || "").slice(-160), options: opts,
          images: (l.images || []).sort((a: any, z: any) => a.rank - z.rank).map((x: any) => ({ rank: x.rank, w: x.full_width, h: x.full_height, url: x.url_570xN })), files: (fl.results || []).map((f: any) => ({ name: f.filename, size: f.filesize, rank: f.rank })) });
      }
      // Dosyayı depoya yüklemek için tek kullanımlık imzalı adres (product-images / product-files)
      if (b.action === "signed_upload" && b.bucket && (b.path || Array.isArray(b.paths))) {
        if (!["product-images", "product-files"].includes(String(b.bucket))) return json({ ok: false, error: "depo" }, 400);
        const urls: Record<string, string> = {};
        for (const pth of (b.paths || [b.path]).slice(0, 200).map(String)) {
          const { data, error } = await db.storage.from(String(b.bucket)).createSignedUploadUrl(pth, { upsert: true });
          if (error) return json({ ok: false, error: error.message, path: pth });
          urls[pth] = data.signedUrl;
        }
        return json({ ok: true, url: b.path ? urls[String(b.path)] : undefined, urls });
      }
      // Ticari kullanıma serbest stok fotoğraf (Pexels lisansı) — ilan kapağı (mockup) sahnesi aramak için
      if (b.action === "stock_photos" && b.query) {
        const key = Deno.env.get("PEXELS_API_KEY") ?? "";
        if (!key) return json({ ok: false, error: "PEXELS_API_KEY yok" });
        const q = new URLSearchParams({ query: String(b.query), per_page: String(Math.min(80, Number(b.perPage) || 40)), page: String(Number(b.page) || 1) });
        if (b.orientation) q.set("orientation", String(b.orientation));
        const r = await fetch("https://api.pexels.com/v1/search?" + q, { headers: { Authorization: key } });
        if (!r.ok) return json({ ok: false, status: r.status });
        const d = await r.json();
        return json({ ok: true, query: b.query, photos: (d.photos || []).map((x: any) => ({ id: x.id, w: x.width, h: x.height, alt: x.alt, by: x.photographer, page: x.url, src: x.src?.original, med: x.src?.medium })) });
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
