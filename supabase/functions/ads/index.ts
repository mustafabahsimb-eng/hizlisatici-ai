// =========================================================
// Seltigo Ads — reklam otomasyonu (A1 Meta katalog reklamı, A2 kural motoru)
// Satıcı (userAccessToken):
//   { action: "status" }                         -> hesap, kurallar, kampanyalar (7 gün), hazırlık (Meta / katalog / sayfa / piksel / canlı mı)
//   { action: "accounts" }                       -> Meta reklam hesapları
//   { action: "connect", externalId, pixelId? }  -> reklam hesabını bağla (sayfa / Instagram / katalog otomatik)
//   { action: "plan", dailyBudget? }             -> hangi ürünlere, ne bütçeyle (kâr kontrolü + üst sınırlar)
//   { action: "launch", productIds?, dailyBudget? } -> kampanya aç (onay modunda DURAKLATILMIŞ bekler)
//   { action: "approve" | "pause" | "resume" | "stop", campaignId }   { action: "budget", campaignId, amount }
// Sistem (CRON_SECRET): { action: "run" } (saatlik: ölçüm, harcama defteri, sınırlar, günlük optimizasyon, otomatik açma)
//   ve yukarıdaki satıcı işlemleri { userId, ... } (asistan)
// Güvenlik: ADS_LIVE secret yoksa yalnız sandbox reklam hesabı (para harcanmaz). Bütçe sınırları aşılmaz. Zarar kontrolü kapatılamaz.
// Paket anahtarı: ads_auto
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { featureEnabled, FEATURE_OFF_MSG } from "../_shared/features.ts";
import { adAccounts, capiPurchase, createProductSet, graph, insights, launchCatalogCampaign, MetaAdsError, pixels, setDailyBudget, setStatus, updateProductSet } from "../_shared/meta-ads.ts";
import { allowedDailyBudget, type AdProduct, monthInfo, optimize, pickProducts, purchasesOf, rulesOf } from "../_shared/ads-engine.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const ADS_LIVE = (Deno.env.get("ADS_LIVE") ?? "").toLowerCase() === "true";
// Meta sandbox (test) reklam hesapları: adında "sandbox" geçen ya da bu listede olan (secret ADS_SANDBOX_ACCOUNTS, virgülle; ör. act_1138060605425004)
const SANDBOX_IDS = new Set((Deno.env.get("ADS_SANDBOX_ACCOUNTS") ?? "").split(",").map((x) => x.trim()).filter(Boolean));
const isSandbox = (a: { id: string; sandbox?: boolean }) => !!a.sandbox || SANDBOX_IDS.has(a.id);
const SITE = "https://mustafabahsimb-eng.github.io/hizlisatici-ai";
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const short = (v: unknown, n = 300) => String(v ?? "").slice(0, n);
const nowIso = () => new Date().toISOString();

function friendly(e: unknown) {
  const m = (e as Error).message || String(e);
  if (/ads_management|permission|not authorized|\(#200\)|\(#10\)/i.test(m)) return "Meta reklam izni yok: Sosyal medya sayfasından Facebook'u yeniden bağla (reklam yönetimi izni).";
  if (/expired|session has been invalidated|validating access token/i.test(m)) return "Facebook bağlantısının süresi dolmuş; yeniden bağla.";
  if (/development mode|1885183/i.test(m)) return "Meta uygulaması geliştirme modunda; reklam metni için uygulamanın yayında (Live) olması gerekiyor.";
  if (/payment|funding|billing/i.test(m)) return "Reklam hesabında ödeme yöntemi yok (Meta Reklam Yöneticisi > Faturalama).";
  return "Meta: " + short(m, 250);
}

async function metaToken(userId: string) {
  const { data } = await db.from("meta_catalogs").select("user_token, catalog_id").eq("user_id", userId).maybeSingle();
  return { token: data?.user_token as string | undefined, catalogId: data?.catalog_id as string | undefined };
}
async function account(userId: string) {
  const { data } = await db.from("ad_accounts").select("*").eq("user_id", userId).eq("platform", "meta").eq("is_default", true).neq("status", "disabled").maybeSingle();
  return data;
}
async function rulesFor(userId: string) {
  const { data } = await db.from("ad_rules").select("*").eq("user_id", userId).maybeSingle();
  return rulesOf(data);
}
const ev = (c: any, status: string, note?: string) => [...(c.events || []), { at: nowIso(), status, ...(note ? { note } : {}) }].slice(-50);
async function alert(userId: string, payload: Record<string, unknown>, dedupe: string) {
  await db.rpc("assistant_enqueue", { p_user: userId, p_kind: "ads", p_payload: payload, p_dedupe: dedupe });
}

// ---------- Kâr: ürünler (maliyet ana para birimine çevrilir; kur tablosu USD bazlı) ----------
const fxCache = new Map<string, number | null>();
async function usdRate(cur: string) {
  const c = (cur || "USD").toUpperCase();
  if (c === "USD") return 1;
  if (fxCache.has(c)) return fxCache.get(c)!;
  const { data } = await db.from("exchange_rates").select("rate").eq("base_currency", "USD").eq("quote_currency", c).order("rate_date", { ascending: false }).limit(1).maybeSingle();
  const r = data?.rate ? Number(data.rate) : null;
  fxCache.set(c, r);
  return r;
}
async function convert(amount: number, from: string, to: string) {
  if ((from || to).toUpperCase() === to.toUpperCase()) return amount;
  const a = await usdRate(from), b = await usdRate(to);
  return a && b ? (amount / a) * b : null;
}
async function adProducts(userId: string, ids?: number[]): Promise<AdProduct[]> {
  const { data: prof } = await db.from("user_profiles").select("home_currency").eq("user_id", userId).maybeSingle();
  const home = prof?.home_currency || "TRY";
  let q = db.from("products").select("id, name, generated_title, sale_price, supplier_price, supplier_cost, cost_currency, commission_rate, stock_qty, stock_status, image_url, store_visible, product_type")
    .eq("user_id", userId).is("deleted_at", null).limit(1000);
  if (ids?.length) q = q.in("id", ids);
  const { data } = await q;
  const out: AdProduct[] = [];
  for (const p of data || []) {
    const rawCost = p.supplier_cost ?? p.supplier_price;
    // Maliyet 0 / boş = bilinmiyor (kâr hesaplanamaz; reklam açılmaz)
    const cost = rawCost != null && Number(rawCost) > 0 ? await convert(Number(rawCost), p.cost_currency || home, home) : null;
    out.push({ id: p.id, name: p.generated_title || p.name, price: Number(p.sale_price) || 0, cost, commissionPct: Number(p.commission_rate) || 0,
      inStock: p.product_type === "digital" || p.stock_qty == null || Number(p.stock_qty) > 0 && p.stock_status !== "tukendi", hasImage: !!p.image_url, visible: !!p.store_visible });
  }
  return out;
}

async function spendNumbers(userId: string, exceptCampaign?: string) {
  const m = monthInfo();
  const { data: led } = await db.from("ad_spend_ledger").select("amount").eq("user_id", userId).gte("day", m.start);
  const spent = (led || []).reduce((a: number, x: any) => a + Number(x.amount || 0), 0);
  let q = db.from("ad_campaigns").select("id, daily_budget").eq("user_id", userId).in("status", ["active", "pending_approval"]);
  if (exceptCampaign) q = q.neq("id", exceptCampaign);
  const { data: act } = await q;
  const other = (act || []).reduce((a: number, x: any) => a + Number(x.daily_budget || 0), 0);
  return { spentThisMonth: spent, otherActiveDaily: other, daysLeftInMonth: m.daysLeft, today: m.today };
}

// ---------- Satıcı işlemleri ----------
async function status(userId: string) {
  const [{ token, catalogId }, acc, rules] = await Promise.all([metaToken(userId), account(userId), rulesFor(userId)]);
  const { data: ch } = await db.from("social_channels").select("platform, account_id, account_name").eq("user_id", userId).eq("active", true).in("platform", ["facebook", "instagram"]);
  const { data: camps } = await db.from("ad_campaigns").select("*").eq("user_id", userId).neq("status", "stopped").order("created_at", { ascending: false }).limit(50);
  const s = await spendNumbers(userId);
  return { ok: true, live: ADS_LIVE, account: acc, rules, campaigns: camps || [], spentThisMonth: s.spentThisMonth,
    ready: { meta: !!token, catalog: !!catalogId, page: !!(ch || []).find((x: any) => x.platform === "facebook"), pixel: !!acc?.pixel_id, account: !!acc } };
}

async function listAccounts(userId: string) {
  const { token } = await metaToken(userId);
  if (!token) return { ok: false, error: "Önce Sosyal medya sayfasından Facebook'u bağla" };
  try {
    const list = (await adAccounts(token)).map((a: any) => ({ ...a, sandbox: isSandbox(a) }));
    const withPixels = [];
    for (const a of list) { let px: any[] = []; try { px = await pixels(token, a.id); } catch (_) { /* izin yoksa boş */ } withPixels.push({ ...a, pixels: px }); }
    return { ok: true, accounts: withPixels, live: ADS_LIVE };
  } catch (e) { return { ok: false, error: friendly(e) }; }
}

async function connect(userId: string, b: any) {
  const { token, catalogId } = await metaToken(userId);
  if (!token) return { ok: false, error: "Önce Sosyal medya sayfasından Facebook'u bağla" };
  const list = await adAccounts(token).catch((e) => { throw new Error(friendly(e)); });
  const a = list.find((x: any) => x.id === String(b.externalId));
  if (!a) return { ok: false, error: "Reklam hesabı bulunamadı" };
  const { data: ch } = await db.from("social_channels").select("platform, account_id").eq("user_id", userId).eq("active", true).in("platform", ["facebook", "instagram"]);
  let page = (ch || []).find((x: any) => x.platform === "facebook")?.account_id || null;
  // Sosyal medyada sayfa yoksa: kullanıcının yönettiği ilk Facebook Sayfası (API)
  if (!page) { try { page = String(((await graph(token, "GET", "/me/accounts", { fields: "id,name", limit: 5 })).data || [])[0]?.id || "") || null; } catch (_) { /* sayfa izni yok */ } }
  const ig = (ch || []).find((x: any) => x.platform === "instagram")?.account_id || null;
  await db.from("ad_accounts").update({ is_default: false }).eq("user_id", userId).eq("platform", "meta");
  const row = { user_id: userId, platform: "meta", external_id: a.id, name: a.name, currency: a.currency, timezone: a.timezone, sandbox: isSandbox(a),
    page_id: page, instagram_id: ig, pixel_id: b.pixelId ? String(b.pixelId) : null, catalog_id: catalogId || null, status: "connected", last_error: null, is_default: true, updated_at: nowIso() };
  const { data, error } = await db.from("ad_accounts").upsert(row, { onConflict: "user_id,platform,external_id" }).select("*").single();
  if (error) throw error;
  return { ok: true, account: data };
}

async function plan(userId: string, b: any) {
  const rules = await rulesFor(userId);
  const prods = await adProducts(userId, Array.isArray(b.productIds) ? b.productIds.map(Number) : undefined);
  const { picked, skipped } = pickProducts(prods, rules);
  const s = await spendNumbers(userId);
  const budget = allowedDailyBudget(rules, { ...s, requested: b.dailyBudget != null ? Number(b.dailyBudget) : null });
  const be = picked.length ? picked.reduce((a, p) => a + p.breakevenRoas, 0) / picked.length : null;
  return { ok: true, picked, skipped: skipped.slice(0, 100), budget: budget.budget, budgetReason: budget.reason, breakevenRoas: be, rules, spentThisMonth: s.spentThisMonth };
}

// Reklam metni: 3 değişken (AI; yoksa sabit). Katalog reklamında başlık / fiyat ürün kataloğundan gelir ({{product.name}})
async function writeCopy(storeName: string, names: string[]) {
  const fallback = [`${storeName} — seçili ürünlerde hızlı kargo. Hemen incele!`, `Beğeneceğin ürünler ${storeName}'da. Stoklar sınırlı.`, `${storeName}: kaliteli ürün, uygun fiyat. Şimdi sipariş ver.`];
  if (!ANTHROPIC_API_KEY) return fallback;
  for (const model of ["claude-haiku-5-5", "claude-sonnet-5-5"]) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 500, messages: [{ role: "user", content: `Mağaza: ${storeName}\nÜrünler: ${names.slice(0, 15).join(", ")}\n\nFacebook / Instagram katalog reklamı için 3 farklı kısa Türkçe ana metin yaz (her biri en fazla 125 karakter, abartısız, yanıltıcı vaat yok, fiyat yazma). Yalnız JSON dizi döndür: ["...","...","..."]` }] }),
        signal: AbortSignal.timeout(30000) });
      const d = await r.json();
      const m = (d?.content || []).map((c: any) => c.text || "").join("").match(/\[[\s\S]*\]/);
      const arr = m ? JSON.parse(m[0]).map((x: unknown) => short(x, 200)).filter(Boolean) : [];
      if (arr.length >= 1) return arr.slice(0, 3);
    } catch (_) { /* sonraki model */ }
  }
  return fallback;
}

async function launch(userId: string, b: any, by: "seller" | "auto" | "assistant") {
  if (!(await featureEnabled(userId, "ads_auto"))) return { ok: false, error: FEATURE_OFF_MSG };
  const acc = await account(userId);
  if (!acc) return { ok: false, error: "Reklam hesabı bağlı değil" };
  if (!ADS_LIVE && !acc.sandbox) return { ok: false, error: "Canlı reklam henüz kapalı; şimdilik yalnız Meta sandbox (test) reklam hesabı kullanılabilir" };
  if (!acc.page_id) return { ok: false, error: "Reklam için Facebook Sayfası bağlı değil (Sosyal medya)" };
  const { token, catalogId } = await metaToken(userId);
  if (!token) return { ok: false, error: "Facebook bağlantısı yok" };
  if (!catalogId) return { ok: false, error: "Meta ürün kataloğu yok (Sosyal medya > Katalog)" };
  const p = await plan(userId, b);
  if (!p.picked.length) return { ok: false, error: "Reklama uygun kârlı ürün yok", skipped: p.skipped.slice(0, 10) };
  if (!(p.budget > 0)) return { ok: false, error: p.budgetReason || "Bütçe yok" };
  const rules = p.rules;
  const ids = p.picked.map((x) => x.id);
  // Katalog güncel olsun (seçilen ürünler Meta kataloğunda)
  await fetch(`${SUPABASE_URL}/functions/v1/social-catalog`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON}`, apikey: ANON },
    body: JSON.stringify({ action: "sync", userId, cronSecret: CRON_SECRET }), signal: AbortSignal.timeout(120000) }).catch(() => null);
  const { data: ss } = await db.from("store_settings").select("store_slug, store_name").eq("user_id", userId).maybeSingle();
  const storeName = ss?.store_name || "Mağazam";
  const copy = await writeCopy(storeName, p.picked.map((x) => x.name));
  const name = `Seltigo · ${storeName} · ${new Date().toISOString().slice(0, 10)}`;
  const { data: camp, error } = await db.from("ad_campaigns").insert({ user_id: userId, account_id: acc.id, name, product_ids: ids, status: "draft", daily_budget: p.budget, currency: acc.currency,
    created_by: by, breakeven_roas: p.breakevenRoas, events: [{ at: nowIso(), status: "draft", note: `${ids.length} ürün, günlük ${p.budget} ${acc.currency}` }] }).select("*").single();
  if (error) throw error;
  await db.from("ad_creatives").insert(copy.map((t, i) => ({ user_id: userId, campaign_id: camp.id, variant: i + 1, primary_text: t, headline: "{{product.name}}" })));
  try {
    const setId = await createProductSet(token, catalogId, name, ids);
    const out = await launchCatalogCampaign({ token, account: acc.external_id, currency: acc.currency, catalogId, productSetId: setId, name, dailyBudget: p.budget,
      countries: rules.countries?.length ? rules.countries : ["TR"], pixelId: acc.pixel_id, pageId: acc.page_id, instagramId: acc.instagram_id,
      link: ss?.store_slug ? `${SITE}/magaza.html?slug=${encodeURIComponent(ss.store_slug)}&utm_source=meta&utm_medium=paid&utm_campaign=${camp.id}` : SITE, message: copy[0] });
    const direct = rules.approval_mode === "direct";
    if (direct) await setStatus(token, { campaign: out.campaign, adset: out.adset, ad: out.ad }, "ACTIVE");
    const st = direct ? "active" : "pending_approval";
    await db.from("ad_campaigns").update({ status: st, external_campaign_id: out.campaign, external_adset_id: out.adset, external_ad_id: out.ad, external_creative_id: out.creative,
      external_product_set_id: setId, events: ev(camp, st, direct ? "Yayında" : "Onay bekliyor (Meta'da duraklatılmış)"), updated_at: nowIso() }).eq("id", camp.id);
    await alert(userId, { campaign_id: camp.id, event: st, budget: p.budget, currency: acc.currency, products: ids.length }, `ads:${camp.id}:${st}`);
    return { ok: true, campaignId: camp.id, status: st, products: ids.length, budget: p.budget, sandbox: acc.sandbox };
  } catch (e) {
    const msg = e instanceof MetaAdsError ? friendly(e) : short((e as Error).message);
    await db.from("ad_campaigns").update({ status: "error", last_error: msg, events: ev(camp, "error", msg) }).eq("id", camp.id);
    return { ok: false, error: msg, campaignId: camp.id };
  }
}

async function campaignAction(userId: string, b: any) {
  const { data: c } = await db.from("ad_campaigns").select("*").eq("id", String(b.campaignId || "")).eq("user_id", userId).maybeSingle();
  if (!c) return { ok: false, error: "Kampanya bulunamadı" };
  // Bütçe sınırı her şeyden önce (Meta'ya gitmeden)
  if (["approve", "resume", "budget"].includes(b.action)) {
    const pre = allowedDailyBudget(await rulesFor(userId), { ...(await spendNumbers(userId, c.id)), requested: b.action === "budget" ? Number(b.amount) : Number(c.daily_budget) });
    if (!(pre.budget > 0)) return { ok: false, error: pre.reason };
  }
  const { token } = await metaToken(userId);
  if (!token) return { ok: false, error: "Facebook bağlantısı yok" };
  const ids = { campaign: c.external_campaign_id, adset: c.external_adset_id, ad: c.external_ad_id };
  try {
    if (b.action === "approve" || b.action === "resume") {
      if (!["pending_approval", "paused"].includes(c.status)) return { ok: false, error: "Kampanya bu durumda yayına alınamaz" };
      const rules = await rulesFor(userId);
      const s = await spendNumbers(userId, c.id);
      const allowed = allowedDailyBudget(rules, { ...s, requested: Number(c.daily_budget) });
      if (!(allowed.budget > 0)) return { ok: false, error: allowed.reason };
      if (allowed.budget < Number(c.daily_budget)) await setDailyBudget(token, c.external_adset_id, allowed.budget, c.currency);
      await setStatus(token, ids, "ACTIVE");
      await db.from("ad_campaigns").update({ status: "active", daily_budget: allowed.budget, paused_reason: null, below_target_since: null, events: ev(c, "active", b.action === "approve" ? "Satıcı onayladı" : "Yeniden başlatıldı"), updated_at: nowIso() }).eq("id", c.id);
      return { ok: true, status: "active", budget: allowed.budget };
    }
    if (b.action === "pause" || b.action === "stop") {
      await setStatus(token, ids, "PAUSED");
      const st = b.action === "stop" ? "stopped" : "paused";
      await db.from("ad_campaigns").update({ status: st, paused_reason: short(b.reason || "Satıcı durdurdu", 200), events: ev(c, st, b.reason || "Satıcı"), updated_at: nowIso() }).eq("id", c.id);
      return { ok: true, status: st };
    }
    if (b.action === "budget") {
      const rules = await rulesFor(userId);
      const s = await spendNumbers(userId, c.id);
      const allowed = allowedDailyBudget(rules, { ...s, requested: Number(b.amount) });
      if (!(allowed.budget > 0)) return { ok: false, error: allowed.reason };
      await setDailyBudget(token, c.external_adset_id, allowed.budget, c.currency);
      await db.from("ad_campaigns").update({ daily_budget: allowed.budget, events: ev(c, c.status, `Günlük bütçe ${allowed.budget}`), updated_at: nowIso() }).eq("id", c.id);
      return { ok: true, budget: allowed.budget, capped: allowed.budget < Number(b.amount) };
    }
    if (b.action === "products") {
      // Ürün seti güncelle (kârlı olmayan çıkar)
      await updateProductSet(token, c.external_product_set_id, (b.productIds || []).map(Number));
      await db.from("ad_campaigns").update({ product_ids: (b.productIds || []).map(Number), updated_at: nowIso() }).eq("id", c.id);
      return { ok: true };
    }
  } catch (e) { return { ok: false, error: e instanceof MetaAdsError ? friendly(e) : short((e as Error).message) }; }
  return { ok: false, error: "Geçersiz işlem" };
}

// ---------- Saatlik iş ----------
async function syncUser(userId: string, deadline: number) {
  const acc = await account(userId);
  const { token } = await metaToken(userId);
  if (!acc || !token) return { userId, skipped: "hesap / anahtar yok" };
  const { data: camps } = await db.from("ad_campaigns").select("*").eq("user_id", userId).in("status", ["active", "paused", "pending_approval"]).not("external_adset_id", "is", null);
  if (!camps?.length) return { userId, campaigns: 0 };
  const m = monthInfo();
  const since = new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10);
  let res;
  try { res = await insights(token, acc.external_id, since, m.today); }
  catch (e) { await db.from("ad_accounts").update({ last_error: friendly(e), updated_at: nowIso() }).eq("id", acc.id); return { userId, error: friendly(e) }; }
  const byAdset = new Map(camps.map((c: any) => [String(c.external_adset_id), c]));
  for (const r of res.rows) {
    const c: any = byAdset.get(String(r.adset_id)); if (!c) continue;
    const { purchases, revenue } = purchasesOf(r);
    const day = String(r.date_start);
    await db.from("ad_metrics_daily").upsert({ campaign_id: c.id, product_id: 0, day, user_id: userId, spend: Number(r.spend) || 0, impressions: Number(r.impressions) || 0, clicks: Number(r.clicks) || 0,
      purchases, revenue, currency: acc.currency, updated_at: nowIso() }, { onConflict: "campaign_id,product_id,day" });
    await db.from("ad_spend_ledger").upsert({ campaign_id: c.id, day, user_id: userId, amount: Number(r.spend) || 0, currency: acc.currency }, { onConflict: "campaign_id,day" });
  }
  // Ürün kırılımı (Meta ürün no -> retailer_id seltigo_<id>)
  const retailerCache = new Map<string, number | null>();
  for (const r of res.byProduct) {
    if (Date.now() > deadline) break;
    const c: any = byAdset.get(String(r.adset_id)); if (!c || !r.product_id) continue;
    let pid = retailerCache.get(String(r.product_id));
    if (pid === undefined) {
      try { const p = await graph(token, "GET", `/${String(r.product_id).split(",")[0]}`, { fields: "retailer_id" }); pid = /^seltigo_(\d+)$/.exec(String(p.retailer_id || ""))?.[1] ? Number(/^seltigo_(\d+)$/.exec(String(p.retailer_id))![1]) : null; }
      catch (_) { pid = null; }
      retailerCache.set(String(r.product_id), pid);
    }
    if (!pid) continue;
    const { purchases, revenue } = purchasesOf(r);
    await db.from("ad_metrics_daily").upsert({ campaign_id: c.id, product_id: pid, day: String(r.date_start), user_id: userId, spend: Number(r.spend) || 0, impressions: Number(r.impressions) || 0,
      clicks: Number(r.clicks) || 0, purchases, revenue, currency: acc.currency, updated_at: nowIso() }, { onConflict: "campaign_id,product_id,day" });
  }
  // 7 günlük özet + aylık sınır + günlük optimizasyon
  const rules = await rulesFor(userId);
  const out: any[] = [];
  for (const c of camps) {
    const { data: mets } = await db.from("ad_metrics_daily").select("day, spend, revenue, purchases").eq("campaign_id", c.id).eq("product_id", 0).gte("day", since).order("day");
    const metrics = (mets || []).map((x: any) => ({ day: x.day, spend: Number(x.spend), revenue: Number(x.revenue), purchases: Number(x.purchases) }));
    const sp = metrics.slice(-7).reduce((a, x) => a + x.spend, 0), rv = metrics.slice(-7).reduce((a, x) => a + x.revenue, 0);
    await db.from("ad_campaigns").update({ spend_7d: sp, revenue_7d: rv, roas_7d: sp > 0 ? Math.round((rv / sp) * 100) / 100 : null }).eq("id", c.id);
    if (c.status !== "active") continue;
    const s = await spendNumbers(userId, c.id);
    const daily = c.optimized_on !== m.today;
    const capHit = rules.monthly_cap > 0 && s.spentThisMonth >= rules.monthly_cap;
    if (!daily && !capHit) continue;
    const d = optimize(rules, { dailyBudget: Number(c.daily_budget), breakevenRoas: Number(c.breakeven_roas) || 1, belowSince: c.below_target_since, today: m.today, metrics,
      spentThisMonth: s.spentThisMonth, otherActiveDaily: s.otherActiveDaily, daysLeftInMonth: s.daysLeftInMonth });
    try {
      if (d.action === "pause" || d.action === "pause_cap") {
        await setStatus(token, { campaign: c.external_campaign_id, adset: c.external_adset_id, ad: c.external_ad_id }, "PAUSED");
        await db.from("ad_campaigns").update({ status: "paused", paused_reason: d.reason, optimized_on: m.today, events: ev(c, "paused", d.reason), updated_at: nowIso() }).eq("id", c.id);
        await alert(userId, { campaign_id: c.id, event: d.action === "pause_cap" ? "cap" : "paused", reason: d.reason }, `ads:${c.id}:paused:${m.today}`);
      } else if (d.action === "scale" && d.newBudget) {
        await setDailyBudget(token, c.external_adset_id, d.newBudget, c.currency);
        await db.from("ad_campaigns").update({ daily_budget: d.newBudget, below_target_since: null, optimized_on: m.today, events: ev(c, "active", d.reason), updated_at: nowIso() }).eq("id", c.id);
        await alert(userId, { campaign_id: c.id, event: "scaled", reason: d.reason, budget: d.newBudget, currency: c.currency }, `ads:${c.id}:scaled:${m.today}`);
      } else {
        await db.from("ad_campaigns").update({ below_target_since: d.belowSince ?? null, optimized_on: m.today }).eq("id", c.id);
      }
      out.push({ id: c.id, ...d });
    } catch (e) { out.push({ id: c.id, error: friendly(e) }); }
  }
  return { userId, campaigns: camps.length, decisions: out };
}

async function run() {
  const deadline = Date.now() + 110_000;
  const { data: users } = await db.from("ad_campaigns").select("user_id").in("status", ["active", "paused", "pending_approval"]);
  const ids = [...new Set((users || []).map((x: any) => x.user_id))];
  const out: unknown[] = [];
  for (const u of ids) { if (Date.now() > deadline) break; if (await featureEnabled(u, "ads_auto")) out.push(await syncUser(u, deadline)); }
  // Otomatik açma: kuralı açık, bütçesi girilmiş, hesabı bağlı ve açık kampanyası olmayan satıcılar
  const { data: autos } = await db.from("ad_rules").select("user_id").eq("auto_launch", true).gt("daily_cap", 0).gt("monthly_cap", 0);
  for (const a of autos || []) {
    if (Date.now() > deadline) break;
    const { count } = await db.from("ad_campaigns").select("id", { count: "exact", head: true }).eq("user_id", a.user_id).in("status", ["active", "pending_approval", "draft"]);
    if (count) continue;
    if (!(await featureEnabled(a.user_id, "ads_auto")) || !(await account(a.user_id))) continue;
    out.push({ userId: a.user_id, autoLaunch: await launch(a.user_id, {}, "auto") });
  }
  return out;
}

// Mağaza siparişi -> Meta Dönüşüm API (create-store-order çağırır; piksel bağlıysa)
async function conversion(b: any) {
  const { data: so } = await db.from("store_orders").select("*").eq("id", String(b.orderId || "")).maybeSingle();
  if (!so) return { ok: false, error: "Sipariş yok" };
  const acc = await account(so.user_id);
  const { token } = await metaToken(so.user_id);
  if (!acc?.pixel_id || !token) return { ok: true, skipped: "piksel yok" };
  try {
    await capiPurchase(token, acc.pixel_id, { eventId: so.id, value: Number(so.unit_price || 0) * (so.quantity || 1), currency: so.currency || "TRY", productId: so.product_id, quantity: so.quantity || 1,
      phone: so.customer_phone, city: so.customer_city, country: so.customer_country || "TR", url: String(b.url || SITE), fbc: so.ad_source?.fbc || null, fbp: so.ad_source?.fbp || null,
      ip: b.ip || null, ua: b.ua || null });
    return { ok: true };
  } catch (e) { return { ok: false, error: friendly(e) }; }
}

async function sellerAction(userId: string, b: any, by: "seller" | "assistant") {
  if (b.action === "status") return await status(userId);
  if (b.action === "accounts") return await listAccounts(userId);
  if (b.action === "connect") return await connect(userId, b);
  if (b.action === "plan") return await plan(userId, b);
  if (b.action === "launch") return await launch(userId, b, by);
  if (["approve", "pause", "resume", "stop", "budget", "products"].includes(b.action)) return await campaignAction(userId, b);
  return { ok: false, error: "Geçersiz işlem" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const b = await req.json().catch(() => ({}));
  try {
    if (CRON_SECRET && String(b?.cronSecret || "").trim() === CRON_SECRET.trim()) {
      if (b.action === "run") return json({ ok: true, results: await run() });
      if (b.action === "conversion") return json(await conversion(b));
      // Meta'daki nesnelerin gerçek durumu (test doğrulaması) ve test temizliği (yalnız sandbox hesaplarında)
      if (b.action === "inspect" && b.userId && b.campaignId) {
        const { token } = await metaToken(String(b.userId));
        const { data: c } = await db.from("ad_campaigns").select("*").eq("id", String(b.campaignId)).eq("user_id", String(b.userId)).maybeSingle();
        if (!token || !c) return json({ ok: false, error: "yok" });
        const f = "id,name,status,effective_status";
        const out: Record<string, unknown> = {};
        try { out.campaign = await graph(token, "GET", `/${c.external_campaign_id}`, { fields: f + ",objective,promoted_object" }); } catch (e) { out.campaign = String((e as Error).message); }
        try { out.adset = await graph(token, "GET", `/${c.external_adset_id}`, { fields: f + ",daily_budget,optimization_goal,targeting,promoted_object" }); } catch (e) { out.adset = String((e as Error).message); }
        try { out.ad = await graph(token, "GET", `/${c.external_ad_id}`, { fields: f }); } catch (e) { out.ad = String((e as Error).message); }
        try { out.productSet = await graph(token, "GET", `/${c.external_product_set_id}`, { fields: "id,name,product_count,filter" }); } catch (e) { out.productSet = String((e as Error).message); }
        return json({ ok: true, ...out });
      }
      if (b.action === "cleanup_test" && b.userId) {
        const acc = await account(String(b.userId));
        if (!acc?.sandbox) return json({ ok: false, error: "Yalnız sandbox hesabında" });
        const { token } = await metaToken(String(b.userId));
        const { data: cs } = await db.from("ad_campaigns").select("*").eq("user_id", String(b.userId)).eq("account_id", acc.id);
        const out: unknown[] = [];
        for (const c of cs || []) {
          for (const id of [c.external_campaign_id, c.external_product_set_id].filter(Boolean)) { try { await graph(token!, "DELETE", `/${id}`); out.push({ id, deleted: true }); } catch (e) { out.push({ id, error: String((e as Error).message) }); } }
          await db.from("ad_campaigns").delete().eq("id", c.id);
        }
        return json({ ok: true, out });
      }
      // Teşhis: Meta izinleri, reklam hesapları, sayfalar (anahtar değeri döndürmez)
      if (b.action === "diag" && b.userId) {
        const { token, catalogId } = await metaToken(String(b.userId));
        if (!token) return json({ ok: false, error: "meta_catalogs anahtarı yok" });
        const out: Record<string, unknown> = { catalogId };
        try { out.permissions = ((await graph(token, "GET", "/me/permissions")).data || []).filter((x: any) => x.status === "granted").map((x: any) => x.permission); } catch (e) { out.permissions = String((e as Error).message); }
        try { out.accounts = await adAccounts(token); } catch (e) { out.accounts = String((e as Error).message); }
        try { out.pages = ((await graph(token, "GET", "/me/accounts", { fields: "id,name", limit: 25 })).data || []).map((x: any) => ({ id: x.id, name: x.name })); } catch (e) { out.pages = String((e as Error).message); }
        if (b.account) { try { out.account = await graph(token, "GET", `/${b.account}`, { fields: "id,name,currency,account_status,timezone_name,business" }); } catch (e) { out.account = String((e as Error).message); } }
        return json({ ok: true, ...out });
      }
      if (b.userId) return json(await sellerAction(String(b.userId), b, "assistant"));
      return json({ error: "Geçersiz işlem" }, 400);
    }
    const token = String(b?.userAccessToken || "").trim();
    const { data } = token ? await db.auth.getUser(token) : { data: { user: null } };
    const userId = data?.user?.id;
    if (!userId) return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);
    return json(await sellerAction(userId, b, "seller"));
  } catch (e) {
    return json({ ok: false, error: e instanceof MetaAdsError ? friendly(e) : short((e as Error).message) }, 500);
  }
});
