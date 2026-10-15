// =========================================================
// Meta Marketing API (Facebook + Instagram reklamları) — Advantage+ katalog reklamı
//  Kampanya (OUTCOME_SALES, katalog) -> ürün seti (seltigo_<id>) -> reklam seti (günlük bütçe, ülke, piksel PURCHASE) -> dinamik reklam metni -> reklam
//  Yeni her şey DURAKLATILMIŞ (PAUSED) açılır; yayına alma ayrı adım (satıcı onayı / doğrudan mod).
//  Sandbox reklam hesabında reklam yayınlanmaz, para harcanmaz (Meta).
// Kaynak: developers.facebook.com/docs/marketing-api (campaign, adset, adcreative template_data, product_set, insights)
// =========================================================
export const ADS_GRAPH = "https://graph.facebook.com/v24.0";
export type Fetch = typeof fetch;
export class MetaAdsError extends Error { constructor(msg: string, public code?: number, public sub?: number) { super(msg); } }

export async function graph(token: string, method: "GET" | "POST" | "DELETE", path: string, params: Record<string, unknown> = {}, f: Fetch = fetch): Promise<any> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  body.set("access_token", token);
  for (let attempt = 0; attempt < 3; attempt++) {
    const url = ADS_GRAPH + path + (method === "GET" ? "?" + body.toString() : "");
    const r = await f(url, method === "GET" ? { signal: AbortSignal.timeout(30000) } : { method, body, signal: AbortSignal.timeout(30000) });
    const d = await r.json().catch(() => ({}));
    if (!d?.error) return d;
    const e = d.error;
    // Hız sınırı (17, 80004, 613): bekle, tekrar dene
    if ([17, 80004, 613, 4].includes(Number(e.code)) && attempt < 2) { await new Promise((x) => setTimeout(x, 1500 * (attempt + 1))); continue; }
    throw new MetaAdsError(e.error_user_msg || e.message || "Meta hatası", Number(e.code), Number(e.error_subcode));
  }
}

export async function adAccounts(token: string, f?: Fetch) {
  const d = await graph(token, "GET", "/me/adaccounts", { fields: "id,name,currency,timezone_name,account_status", limit: 50 }, f);
  return (d.data || []).map((a: any) => ({ id: String(a.id), name: a.name, currency: a.currency, timezone: a.timezone_name, active: Number(a.account_status) === 1,
    sandbox: /sandbox/i.test(String(a.name || "")) }));
}
export async function pixels(token: string, account: string, f?: Fetch) {
  const d = await graph(token, "GET", `/${account}/adspixels`, { fields: "id,name", limit: 25 }, f);
  return (d.data || []).map((p: any) => ({ id: String(p.id), name: p.name }));
}

export const retailerId = (productId: number) => `seltigo_${productId}`;

export async function createProductSet(token: string, catalogId: string, name: string, productIds: number[], f?: Fetch) {
  const d = await graph(token, "POST", `/${catalogId}/product_sets`, { name, filter: { retailer_id: { is_any: productIds.map(retailerId) } } }, f);
  return String(d.id);
}
export async function updateProductSet(token: string, setId: string, productIds: number[], f?: Fetch) {
  await graph(token, "POST", `/${setId}`, { filter: { retailer_id: { is_any: productIds.map(retailerId) } } }, f);
}

// Para birimi alt birimi (Meta bütçeleri en küçük birimle: TRY kuruş, USD cent; JPY / KRW gibi ondalıksız)
const ZERO_DEC = ["JPY", "KRW", "CLP", "VND", "ISK", "HUF", "TWD"];
export const minor = (amount: number, currency: string) => Math.round(amount * (ZERO_DEC.includes(String(currency).toUpperCase()) ? 1 : 100));

export type LaunchIn = {
  token: string; account: string; currency: string; catalogId: string; productSetId: string; name: string; dailyBudget: number; countries: string[];
  pixelId?: string | null; pageId: string; instagramId?: string | null; link: string; message: string; headline?: string | null;
};
export async function launchCatalogCampaign(x: LaunchIn, f?: Fetch) {
  const ids: Record<string, string> = {};
  const c = await graph(x.token, "POST", `/${x.account}/campaigns`, {
    name: x.name, objective: "OUTCOME_SALES", status: "PAUSED", special_ad_categories: [], buying_type: "AUCTION",
    promoted_object: { product_catalog_id: x.catalogId },
  }, f);
  ids.campaign = String(c.id);
  const optimization = x.pixelId ? { optimization_goal: "OFFSITE_CONVERSIONS", promoted_object: { product_set_id: x.productSetId, pixel_id: x.pixelId, custom_event_type: "PURCHASE" } }
    : { optimization_goal: "LINK_CLICKS", promoted_object: { product_set_id: x.productSetId } };
  const s = await graph(x.token, "POST", `/${x.account}/adsets`, {
    name: x.name + " · ürünler", campaign_id: ids.campaign, daily_budget: minor(x.dailyBudget, x.currency), billing_event: "IMPRESSIONS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP", targeting: { geo_locations: { countries: x.countries }, age_min: 18 }, status: "PAUSED", ...optimization,
  }, f);
  ids.adset = String(s.id);
  const cr = await graph(x.token, "POST", `/${x.account}/adcreatives`, {
    name: x.name + " · dinamik", product_set_id: x.productSetId,
    object_story_spec: { page_id: x.pageId, ...(x.instagramId ? { instagram_user_id: x.instagramId } : {}),
      template_data: { message: x.message, link: x.link, name: x.headline || "{{product.name}}", description: "{{product.price}}", call_to_action: { type: "SHOP_NOW" } } },
  }, f);
  ids.creative = String(cr.id);
  const ad = await graph(x.token, "POST", `/${x.account}/ads`, { name: x.name, adset_id: ids.adset, creative: { creative_id: ids.creative }, status: "PAUSED" }, f);
  ids.ad = String(ad.id);
  return ids;
}

// Yayına al / durdur: kampanya + reklam seti + reklam birlikte
export async function setStatus(token: string, ids: { campaign?: string | null; adset?: string | null; ad?: string | null }, status: "ACTIVE" | "PAUSED", f?: Fetch) {
  for (const id of [ids.ad, ids.adset, ids.campaign].filter(Boolean) as string[]) await graph(token, "POST", `/${id}`, { status }, f);
}
export async function setDailyBudget(token: string, adsetId: string, amount: number, currency: string, f?: Fetch) {
  await graph(token, "POST", `/${adsetId}`, { daily_budget: minor(amount, currency) }, f);
}

// Günlük ölçüm: reklam seti düzeyi + ürün kırılımı
export async function insights(token: string, account: string, since: string, until: string, f?: Fetch) {
  const fields = "adset_id,spend,impressions,clicks,actions,action_values,date_start";
  const base = { level: "adset", fields, time_increment: 1, time_range: { since, until }, limit: 500 };
  const rows: any[] = [], byProduct: any[] = [];
  let d = await graph(token, "GET", `/${account}/insights`, base, f);
  rows.push(...(d.data || []));
  try {
    d = await graph(token, "GET", `/${account}/insights`, { ...base, breakdowns: "product_id" }, f);
    byProduct.push(...(d.data || []));
  } catch (_) { /* ürün kırılımı her hesapta yok */ }
  return { rows, byProduct };
}

// Dönüşüm API (sunucudan satın alma olayı; tarayıcı pikseliyle event_id üzerinden tekilleşir)
export async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s.trim().toLowerCase()));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
export async function capiPurchase(token: string, pixelId: string, e: { eventId: string; value: number; currency: string; productId: number; quantity: number; phone?: string | null;
  city?: string | null; country?: string | null; url: string; fbc?: string | null; fbp?: string | null; ip?: string | null; ua?: string | null; testCode?: string | null }, f?: Fetch) {
  const ud: Record<string, unknown> = {};
  const ph = String(e.phone || "").replace(/\D/g, "").replace(/^0/, "90");
  if (ph) ud.ph = [await sha256(ph)];
  if (e.city) ud.ct = [await sha256(e.city.replace(/\s+/g, ""))];
  if (e.country) ud.country = [await sha256(e.country)];
  if (e.fbc) ud.fbc = e.fbc;
  if (e.fbp) ud.fbp = e.fbp;
  if (e.ip) ud.client_ip_address = e.ip;
  if (e.ua) ud.client_user_agent = e.ua;
  return await graph(token, "POST", `/${pixelId}/events`, {
    data: [{ event_name: "Purchase", event_time: Math.floor(Date.now() / 1000), event_id: e.eventId, action_source: "website", event_source_url: e.url, user_data: ud,
      custom_data: { currency: e.currency, value: e.value, content_ids: [retailerId(e.productId)], content_type: "product", num_items: e.quantity } }],
    ...(e.testCode ? { test_event_code: e.testCode } : {}),
  }, f);
}
