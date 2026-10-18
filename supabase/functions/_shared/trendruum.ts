// =========================================================
// Trendruum (trendruum.com; satıcı paneli seller.trendruum.com) — ortak modül
// Bağlantı: satıcı panelinde "Hesap Bilgilerim > Entegrasyon Bilgileri"nden Client ID + Client Secret -> JWT erişim anahtarı
// (kaynak: entegratör kurulum rehberleri; Trendruum'un API belgesi yalnız satıcı panelinde).
// Webhook yok: siparişler düzenli çekilir (marketplace-orders, 15 dk). Ürünler yalnız EN ALT kategoriye gönderilir,
// marka Trendruum listesinden seçilir, kategori nitelikleri kategoriye göre gelir; aynı ürün tekrar gönderilince yenisi açılmaz.
//
// VARSAYILAN KAPALI: TRENDRUUM_ENABLED=true olmadan Trendruum'a hiçbir istek gitmez (ilanlar yalnız prova, bağlantılar
// "onay bekliyor" kaydedilir). Uç nokta adresleri satıcı hesabındaki belgeyle doğrulanacak; hepsi aşağıdaki PATHS'te
// tek yerde durur ve kod değiştirmeden TRENDRUUM_API_BASE / TRENDRUUM_PATHS (JSON) secret'larıyla düzeltilebilir.
// Ayrıntı: docs/trendruum.md
// =========================================================

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const AI_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-sonnet-4-6"]; // hız için önce Haiku

export const TRENDRUUM_CODE = "trendruum_tr";
export const TRENDRUUM_VAT_RATES = [0, 1, 10, 20];
const MAX_TITLE = 100, MAX_IMAGES = 8;

const DEFAULT_PATHS = {
  token: "/auth/token",                                   // POST { client_id, client_secret, grant_type } -> JWT
  categories: "/categories",                              // GET  kategori ağacı
  categoryAttributes: "/categories/{categoryId}/attributes", // GET  kategori nitelikleri (zorunlu + değerler)
  brands: "/brands",                                      // GET  ?name= marka arama
  products: "/products",                                  // POST { items } ürün oluştur / güncelle (toplu)
  batch: "/products/batch-requests/{batchId}",            // GET  toplu işlem sonucu
  priceStock: "/products/price-and-inventory",            // POST { items: [{ barcode, quantity, salePrice, listPrice }] }
  orders: "/orders",                                      // GET  ?startDate&endDate&page&size
  shipment: "/orders/{packageId}/shipment",               // PUT  { trackingNumber, cargoCompany }
};
export type TrPaths = typeof DEFAULT_PATHS;

export function trendruumEnabled(): boolean {
  return (Deno.env.get("TRENDRUUM_ENABLED") ?? "").trim().toLowerCase() === "true";
}
function baseUrl(env: "live" | "sandbox") {
  const live = (Deno.env.get("TRENDRUUM_API_BASE") ?? "https://api.trendruum.com").replace(/\/+$/, "");
  return env === "sandbox" ? (Deno.env.get("TRENDRUUM_SANDBOX_BASE") ?? live).replace(/\/+$/, "") : live;
}
export function trendruumPaths(): TrPaths {
  try { return { ...DEFAULT_PATHS, ...JSON.parse(Deno.env.get("TRENDRUUM_PATHS") || "{}") }; } catch { return DEFAULT_PATHS; }
}
const fill = (p: string, v: Record<string, string | number>) => p.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String(v[k] ?? "")));

export type TrCreds = { clientId: string; clientSecret: string; sellerId?: string | null };
export type TrCtx = { creds: TrCreds; env?: "live" | "sandbox"; fetch?: typeof fetch };
export type Issue = { code: string; field?: string; msg: string; params?: Record<string, unknown> };

export class TrendruumError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, msg: string, body?: unknown) { super(msg); this.status = status; this.body = body; }
}

// store_connections kasasındaki biçim (store-connect: { sellerId, apiKey, apiSecret }) -> Trendruum alanları
export function credsFromVault(c: any): TrCreds {
  return { clientId: String(c?.clientId || c?.apiKey || ""), clientSecret: String(c?.clientSecret || c?.apiSecret || ""), sellerId: c?.sellerId || null };
}

// ---------- Erişim anahtarı (JWT; süresine göre önbellek) ----------
const tokenCache = new Map<string, { t: string; exp: number }>();
function jwtExp(t: string): number | null {
  try { const p = JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); return p.exp ? p.exp * 1000 : null; } catch { return null; }
}
export async function trendruumToken(ctx: TrCtx, force = false): Promise<string> {
  const { clientId, clientSecret } = ctx.creds;
  if (!clientId || !clientSecret) throw new TrendruumError(400, "Client ID ve Client Secret gerekli");
  const key = `${ctx.env || "live"}:${clientId}`;
  const c = tokenCache.get(key);
  if (!force && c && c.exp > Date.now() + 60_000) return c.t;
  const f = ctx.fetch || fetch;
  const r = await f(baseUrl(ctx.env || "live") + trendruumPaths().token, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let d: any = {};
  try { d = text ? JSON.parse(text) : {}; } catch { /* düz metin */ }
  if (!r.ok) throw new TrendruumError(r.status, `trendruum token ${r.status}: ${text.slice(0, 200)}`, d);
  const t = d.access_token || d.accessToken || d.token || d?.data?.access_token || d?.data?.accessToken || d?.data?.token;
  if (!t) throw new TrendruumError(502, "Trendruum erişim anahtarı vermedi", d);
  const ttl = Number(d.expires_in || d.expiresIn || d?.data?.expires_in) || 0;
  const exp = jwtExp(t) || (ttl ? Date.now() + ttl * 1000 : Date.now() + 50 * 60_000);
  tokenCache.set(key, { t, exp });
  return t;
}

// ---------- İstek: anahtar ekler, 401'de bir kez yeniler, 429 / 5xx'te bekleyip tekrar dener ----------
export async function trApi(ctx: TrCtx, method: string, path: string, opts: { query?: Record<string, unknown>; body?: unknown } = {}): Promise<any> {
  const f = ctx.fetch || fetch;
  const q = opts.query ? "?" + new URLSearchParams(Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, String(v)])).toString() : "";
  const url = baseUrl(ctx.env || "live") + path + q;
  let refreshed = false;
  for (let i = 0; ; i++) {
    const tok = await trendruumToken(ctx, refreshed && i === 1);
    const r = await f(url, {
      method, headers: { Authorization: `Bearer ${tok}`, Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Seltigo" },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    let d: any = text;
    try { d = text ? JSON.parse(text) : {}; } catch { /* düz metin */ }
    if (r.ok) return d;
    if (r.status === 401 && !refreshed) { refreshed = true; continue; }
    if ((r.status === 429 || r.status >= 500) && i < 3) { await new Promise((res) => setTimeout(res, 800 * 2 ** i)); continue; }
    throw new TrendruumError(r.status, `trendruum ${method} ${path} ${r.status}: ${String(typeof d === "string" ? d : JSON.stringify(d)).slice(0, 240)}`, d);
  }
}
const list = (d: any): any[] => (Array.isArray(d) ? d : d?.data?.items || d?.data?.content || d?.items || d?.content || d?.data || d?.categories || d?.brands || d?.orders || []);

// ---------- Bağlantı doğrulama (anahtar alınabiliyor mu) ----------
export async function verifyTrendruum(ctx: TrCtx): Promise<{ connected: boolean; error?: string; pending?: boolean }> {
  if (!trendruumEnabled()) {
    return { connected: false, pending: true, error: "Trendruum entegrasyonu henüz açılmadı; bilgilerin şifreli kasada saklanır, açılınca otomatik doğrulanır." };
  }
  try {
    await trendruumToken(ctx, true);
    return { connected: true };
  } catch (e) {
    const s = (e as TrendruumError).status;
    if (s === 400 || s === 401 || s === 403) {
      return { connected: false, error: "Client ID veya Client Secret hatalı. Trendruum satıcı panelinde (Hesap Bilgilerim > Entegrasyon Bilgileri) kontrol et; yeniden ürettiysen yenisini gir." };
    }
    return { connected: false, error: `Trendruum'dan beklenmeyen yanıt: ${String((e as Error).message).slice(0, 200)}` };
  }
}

// ---------- Kategori (en alt), marka, nitelikler ----------
type Cat = { id: number | string; name: string; path: string };
const catCache = new Map<string, { at: number; leaves: Cat[] }>();
export async function trendruumLeafCategories(ctx: TrCtx): Promise<Cat[]> {
  const key = ctx.env || "live";
  const c = catCache.get(key);
  if (c && Date.now() - c.at < 6 * 3600_000) return c.leaves;
  const d = await trApi(ctx, "GET", trendruumPaths().categories);
  const leaves: Cat[] = [];
  const walk = (nodes: any[], trail: string[]) => {
    for (const n of nodes || []) {
      const name = String(n.name ?? n.title ?? "");
      const kids = n.subCategories || n.children || n.subcategories || [];
      const leaf = n.leaf === true || n.isLeaf === true || !kids.length;
      if (leaf) leaves.push({ id: n.id, name, path: [...trail, name].join(" > ") });
      else walk(kids, [...trail, name]);
    }
  };
  walk(list(d), []);
  catCache.set(key, { at: Date.now(), leaves });
  return leaves;
}

const words = (s: unknown) => String(s ?? "").toLocaleLowerCase("tr").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);

async function aiJson(system: string, user: string, maxTokens = 1500): Promise<any> {
  if (!ANTHROPIC_API_KEY) return null;
  for (const model of AI_MODELS) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }), signal: AbortSignal.timeout(45000),
      });
      if (!r.ok) continue;
      const d = await r.json();
      const text = (d?.content || []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("");
      const m = text.match(/[\[{][\s\S]*[\]}]/);
      if (m) return JSON.parse(m[0]);
    } catch (_) { /* sonraki model */ }
  }
  return null;
}

export type Facts = { title: string; description: string; brand?: string | null; specs?: unknown; categoryHint?: string | null; variants?: unknown[] };

// Satıcının daha önce aynı kategori anahtarıyla gönderdiği ilan -> aynı Trendruum kategorisi (öğrenen sistem); yoksa
// başlıktaki kelimelerle aday listesi daraltılır, en alt kategoriyi yapay zekâ seçer.
export async function pickCategory(ctx: TrCtx, facts: Facts, learned?: string | number | null): Promise<Cat | null> {
  const leaves = await trendruumLeafCategories(ctx);
  if (learned != null) { const l = leaves.find((x) => String(x.id) === String(learned)); if (l) return l; }
  if (!leaves.length) return null;
  const w = new Set([...words(facts.title), ...words(facts.categoryHint)]);
  const scored = leaves.map((c) => ({ c, s: words(c.path).reduce((a, x) => a + (w.has(x) ? (words(c.name).includes(x) ? 3 : 1) : 0), 0) }))
    .sort((a, b) => b.s - a.s);
  const cands = (scored[0]?.s ? scored.filter((x) => x.s > 0) : scored).slice(0, 150).map((x) => x.c);
  if (cands.length === 1) return cands[0];
  const ans = await aiJson(
    "Bir Türk pazaryeri (Trendruum) için ürünün EN UYGUN EN ALT kategorisini seç. Yalnız JSON döndür: {\"id\": <adaylardan biri>}.",
    `Ürün: ${JSON.stringify({ title: facts.title, description: facts.description.slice(0, 800), hint: facts.categoryHint })}\n\nAday kategoriler:\n${cands.map((c) => `${c.id}\t${c.path}`).join("\n")}`,
    200,
  );
  return cands.find((c) => String(c.id) === String(ans?.id)) || (scored[0]?.s ? cands[0] : null);
}

export async function findBrand(ctx: TrCtx, brand: string | null | undefined): Promise<{ id: number | string; name: string } | null> {
  const name = String(brand || "").trim();
  if (!name) return null;
  const d = await trApi(ctx, "GET", trendruumPaths().brands, { query: { name } });
  const norm = (s: unknown) => String(s ?? "").toLocaleLowerCase("tr").replace(/\s+/g, " ").trim();
  const hit = list(d).find((b: any) => norm(b.name) === norm(name));
  return hit ? { id: hit.id, name: hit.name } : null;
}

type Attr = { id: number | string; name: string; required: boolean; allowCustom: boolean; values: { id: number | string; name: string }[]; varianter: boolean };
export async function categoryAttributes(ctx: TrCtx, categoryId: number | string): Promise<Attr[]> {
  const d = await trApi(ctx, "GET", fill(trendruumPaths().categoryAttributes, { categoryId }));
  const raw = list(d?.categoryAttributes ? d.categoryAttributes : d);
  return raw.map((a: any) => {
    const at = a.attribute || a;
    return {
      id: at.id ?? a.attributeId, name: String(at.name ?? a.name ?? ""), required: !!(a.required ?? a.isRequired ?? a.mandatory),
      allowCustom: !!(a.allowCustom ?? a.allowCustomValue ?? a.customValue), varianter: !!(a.varianter ?? a.isVariant ?? a.slicer),
      values: (a.attributeValues || a.values || []).map((v: any) => ({ id: v.id, name: String(v.name ?? v.value ?? "") })),
    };
  });
}

// Zorunlu nitelikleri tek seferde doldur: önce üründeki bilgi (renk / beden vb.) değer listesiyle birebir eşleşirse o, kalanları yapay zekâ
export async function fillAttributes(attrs: Attr[], facts: Facts, variantAttrs: Record<string, unknown> = {}): Promise<{ list: { attributeId: any; attributeValueId?: any; customAttributeValue?: string }[]; missing: string[] }> {
  const norm = (s: unknown) => String(s ?? "").toLocaleLowerCase("tr").trim();
  const known: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...(facts.specs && typeof facts.specs === "object" ? facts.specs as object : {}), ...variantAttrs })) if (v != null && v !== "") known[norm(k)] = String(v);
  const out: { attributeId: any; attributeValueId?: any; customAttributeValue?: string }[] = [];
  const todo: Attr[] = [];
  for (const a of attrs) {
    const v = known[norm(a.name)] ?? (/(renk|color)/i.test(a.name) ? known["renk"] ?? known["color"] : /(beden|size)/i.test(a.name) ? known["beden"] ?? known["size"] : undefined);
    const hit = v != null ? a.values.find((x) => norm(x.name) === norm(v)) : null;
    if (hit) out.push({ attributeId: a.id, attributeValueId: hit.id });
    else if (v != null && a.allowCustom) out.push({ attributeId: a.id, customAttributeValue: String(v).slice(0, 100) });
    else if (a.required) todo.push(a);
  }
  if (todo.length) {
    const ans = await aiJson(
      "Türk pazaryeri ürün nitelikleri dolduruyorsun. Yalnız JSON döndür: {\"<nitelik id>\": {\"valueId\": <listedeki id>} ya da {\"text\": \"...\"}}. Değer listesi varsa yalnız listeden seç; liste boşsa kısa Türkçe metin yaz. Bilinmeyen sayısal bilgide gerçekçi ve temkinli değer seç.",
      `Ürün: ${JSON.stringify({ title: facts.title, description: facts.description.slice(0, 1500), brand: facts.brand, specs: facts.specs, variant: variantAttrs })}\n\nNitelikler:\n${JSON.stringify(todo.map((a) => ({ id: a.id, name: a.name, values: a.values.slice(0, 120), custom: a.allowCustom })))}`,
      2500,
    ) || {};
    for (const a of todo) {
      const v = ans[String(a.id)];
      if (v?.valueId != null && a.values.some((x) => String(x.id) === String(v.valueId))) out.push({ attributeId: a.id, attributeValueId: v.valueId });
      else if (v?.text && (a.allowCustom || !a.values.length)) out.push({ attributeId: a.id, customAttributeValue: String(v.text).slice(0, 100) });
    }
  }
  const have = new Set(out.map((x) => String(x.attributeId)));
  return { list: out, missing: attrs.filter((a) => a.required && !have.has(String(a.id))).map((a) => a.name) };
}

// ---------- İlan kalemleri (her seçenek ayrı barkod; aynı ana kodla gruplanır) ----------
export type BuildArgs = { listing: any; product: any; variants: any[]; images: string[] };
export function barcodeFor(listing: any, product: any, v: any | null): { code: string; generated: boolean } {
  const real = (v && (v.gtin || v.sku)) || (!v || v.is_default ? (product?.gtin || null) : null);
  if (real) return { code: String(real), generated: false };
  const base = "SLT" + String(product?.id ?? listing.product_id ?? listing.id).replace(/[^0-9A-Za-z]/g, "");
  return { code: v && !v.is_default ? `${base}-${String(v.id).replace(/[^0-9A-Za-z]/g, "").slice(0, 8)}` : base, generated: true };
}
export function localChecks(a: BuildArgs): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [], warnings: Issue[] = [];
  const add = (l: Issue[], code: string, field: string, msg: string, params?: Record<string, unknown>) => l.push({ code, field, msg, ...(params ? { params } : {}) });
  const title = String(a.listing.title || "").trim();
  if (!title) add(errors, "title_missing", "title", "Başlık boş.");
  else if (title.length > MAX_TITLE) add(warnings, "title_trimmed", "title", `Başlık ${MAX_TITLE} karakterde kesilecek (şu an ${title.length}).`, { len: title.length, max: MAX_TITLE });
  if (!String(a.listing.description || "").trim()) add(errors, "description_missing", "description", "Açıklama boş.");
  const price = Number(a.listing.price) || 0;
  if (price <= 0) add(errors, "price_missing", "price", "Satış fiyatı yok.");
  if (Number(a.listing.compare_at_price) && Number(a.listing.compare_at_price) < price) add(errors, "list_price_low", "price", "Liste fiyatı satış fiyatından düşük olamaz.");
  if ((a.listing.currency || "TRY") !== "TRY") add(errors, "currency_not_try", "price", "Trendruum'da fiyat TL olmalı.", { currency: a.listing.currency });
  const vat = a.listing.vat_rate_pct;
  if (vat == null) add(warnings, "vat_default", "vat", "KDV oranı girilmemiş, %20 varsayıldı.");
  else if (!TRENDRUUM_VAT_RATES.includes(Number(vat))) add(errors, "vat_invalid", "vat", "KDV oranı 0, 1, 10 ya da 20 olmalı.", { vat });
  const https = a.images.filter((u) => /^https:\/\//i.test(u));
  if (!https.length) add(errors, "images_missing", "images", "En az 1 görsel (https adresli) gerekli.");
  if (https.length > MAX_IMAGES) add(warnings, "images_too_many", "images", `Trendruum'a ilk ${MAX_IMAGES} görsel gönderilecek.`, { max: MAX_IMAGES });
  if (!a.product?.brand) add(warnings, "brand_missing", "brand", "Üründe marka yok; Trendruum marka listesinden seçilmesi gerekir.");
  if (a.product?.stock_qty == null) add(warnings, "stock_unknown", "stock", "Stok bilgisi yok, 0 gönderilecek.");
  for (const v of a.variants.length ? a.variants : [null]) {
    if (barcodeFor(a.listing, a.product, v).generated) { add(warnings, "barcode_generated", "barcode", "Barkod yok, Seltigo barkodu kullanılacak."); break; }
  }
  return { errors, warnings };
}

export type Item = Record<string, unknown> & { barcode: string; quantity: number; salePrice: number; listPrice: number };
export function buildItems(a: BuildArgs, m: { categoryId: any; brandId: any; attributes: any[]; perVariant?: Record<string, any[]> }): Item[] {
  const { listing, product } = a;
  const salePrice = Number(listing.price) || 0;
  const listPrice = Math.max(salePrice, Number(listing.compare_at_price) || salePrice);
  const vatRate = listing.vat_rate_pct != null ? Number(listing.vat_rate_pct) : 20;
  const images = a.images.filter((u) => /^https:\/\//i.test(u)).slice(0, MAX_IMAGES);
  const weight = Number(product?.weight_kg) || 0;
  const vs = a.variants.filter((v) => v && v.is_active !== false && !v.deleted_at);
  const rows = vs.length > 1 ? vs.filter((v) => !v.is_default) : [vs[0] || null];
  return rows.map((v) => {
    const bc = barcodeFor(listing, product, v).code;
    const qty = Math.max(0, Math.floor(Number(v?.stock_qty ?? product?.stock_qty ?? 0) || 0));
    return {
      barcode: bc, stockCode: bc, productMainId: "SLT-" + String(product?.id ?? listing.product_id ?? listing.id),
      title: String(listing.title || "").trim().slice(0, MAX_TITLE), description: String(listing.description || "").trim(),
      categoryId: m.categoryId, brandId: m.brandId, quantity: qty, salePrice, listPrice, vatRate, currencyType: "TRY",
      dimensionalWeight: weight > 0 ? Math.max(1, Math.ceil(weight)) : 1,
      images: (v?.image_url && /^https:\/\//i.test(v.image_url) ? [v.image_url, ...images.filter((u) => u !== v.image_url)] : images).slice(0, MAX_IMAGES).map((url) => ({ url })),
      attributes: [...m.attributes, ...((v && m.perVariant?.[String(v.id)]) || [])],
    };
  });
}

// ---------- Gönderim ----------
export async function submitProducts(ctx: TrCtx, items: Item[]): Promise<{ batchId: string | null; results: { barcode: string; status: string; reason?: string }[] }> {
  const d = await trApi(ctx, "POST", trendruumPaths().products, { body: { items } });
  const batchId = String(d?.batchRequestId ?? d?.batchId ?? d?.data?.batchRequestId ?? d?.data?.batchId ?? "") || null;
  let results = items.map((i) => ({ barcode: i.barcode, status: "pending" as string, reason: undefined as string | undefined }));
  // Toplu işlemin sonucu (kısa bekleme; HIZ KURALI: ilan beklemeden açılır, kalan durum saatlik yenilenir)
  for (let i = 0; batchId && i < 5; i++) {
    await new Promise((res) => setTimeout(res, i ? 1500 : 600));
    const b = await trApi(ctx, "GET", fill(trendruumPaths().batch, { batchId })).catch(() => null);
    const rows = list(b?.items ? b.items : b);
    if (!rows.length) continue;
    results = rows.map((r: any) => ({
      barcode: String(r.barcode ?? r.requestItem?.barcode ?? r.item?.barcode ?? ""),
      status: String(r.status ?? r.state ?? "pending").toLowerCase(),
      reason: (r.failureReasons || r.errors || []).map((x: any) => (typeof x === "string" ? x : x.message || x.reason || JSON.stringify(x))).join("; ") || undefined,
    }));
    if (results.every((r) => r.status !== "pending" && r.status !== "in_progress")) break;
  }
  return { batchId, results };
}

export async function updatePriceStock(ctx: TrCtx, items: { barcode: string; quantity: number; salePrice: number; listPrice: number }[]): Promise<string | null> {
  if (!items.length) return null;
  const d = await trApi(ctx, "POST", trendruumPaths().priceStock, { body: { items: items.map(({ barcode, quantity, salePrice, listPrice }) => ({ barcode, quantity, salePrice, listPrice })) } });
  return String(d?.batchRequestId ?? d?.batchId ?? "") || null;
}

// ---------- Siparişler (marketplace-orders biçimine çevrilir) ----------
export async function fetchTrendruumOrders(ctx: TrCtx, since: Date, until: Date): Promise<any[]> {
  const pick = (o: any, ...keys: string[]) => { for (const k of keys) { const v = k.split(".").reduce((x: any, p) => (x == null ? x : x[p]), o); if (v !== undefined && v !== null && v !== "") return v; } return null; };
  const iso = (v: unknown) => { const n = Number(v); const dt = Number.isFinite(n) && n > 1e9 ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(v ?? "")); return isNaN(dt.getTime()) ? new Date().toISOString() : dt.toISOString(); };
  const out: any[] = [];
  // 14 günlük pencereler, sayfa sayfa
  for (let a = since.getTime(); a < until.getTime(); a += 14 * 86400_000) {
    const b = Math.min(until.getTime(), a + 14 * 86400_000);
    for (let page = 0; page < 50; page++) {
      const d = await trApi(ctx, "GET", trendruumPaths().orders, { query: { startDate: new Date(a).toISOString(), endDate: new Date(b).toISOString(), page, size: 100 } });
      const orders = list(d);
      for (const o of orders) {
        const ad = pick(o, "shipmentAddress", "shippingAddress", "deliveryAddress") || {};
        const pkg = String(pick(o, "packageId", "shipmentPackageId", "id", "orderNumber"));
        const orderNo = String(pick(o, "orderNumber", "orderNo", "id"));
        const cargo = pick(o, "cargoProviderName", "cargo.companyName", "cargoCompany");
        const tracking = pick(o, "cargoTrackingNumber", "cargo.trackingNumber", "trackingNumber");
        // Trendruum Kargo ile anlaşmalı gönderide takip numarası siparişle gelir (etiket Trendruum'dan); gelmiyorsa satıcı kendi kargosuyla gönderir
        const marketplaceShips = !!(tracking || pick(o, "cargoBarcode", "cargo.barcode") || /trendruum/i.test(String(cargo || "")));
        for (const l of pick(o, "lines", "items", "orderItems") || []) {
          const lineId = String(pick(l, "lineId", "id", "orderItemId") ?? "1");
          const qty = Number(pick(l, "quantity")) || 1;
          out.push({
            externalId: `${pkg}/${lineId}`, orderNo: pkg, lineRef: lineId, orderedAt: iso(pick(o, "orderDate", "createdDate", "createdAt")),
            status: String(pick(l, "status", "orderLineStatus") || pick(o, "status", "orderStatus") || "new"),
            currency: String(pick(l, "currencyCode") || pick(o, "currencyCode") || "TRY"),
            unitPrice: pick(l, "unitPrice", "price", "salePrice") != null ? Number(pick(l, "unitPrice", "price", "salePrice")) : (pick(l, "amount", "totalPrice") != null ? Number(pick(l, "amount", "totalPrice")) / qty : null),
            quantity: qty, sku: pick(l, "stockCode", "merchantSku", "sku"), barcode: pick(l, "barcode"), productName: pick(l, "productName", "name"),
            buyerName: pick(ad, "fullName", "nameSurname", "name") || [pick(o, "customerFirstName"), pick(o, "customerLastName")].filter(Boolean).join(" ") || null,
            phone: pick(ad, "phone", "phoneNumber", "gsm"), email: pick(o, "customerEmail", "email"),
            address: { line1: String(pick(ad, "fullAddress", "address1", "address", "addressDetail") ?? ""), line2: String(pick(ad, "address2") ?? ""), city: pick(ad, "city", "cityName"), district: pick(ad, "district", "districtName", "town"), zip: pick(ad, "postalCode", "zipCode"), country: pick(ad, "countryCode") || "TR" },
            tracking: tracking != null ? String(tracking) : null, carrier: cargo, marketplaceShips,
            raw: { orderNumber: orderNo, packageId: pkg, lineId },
          });
        }
      }
      const pages = Number(pick(d, "totalPages", "data.totalPages", "page.totalPages") ?? 1);
      if (!orders.length || page + 1 >= pages) break;
    }
  }
  return out;
}

// Satıcı kendi kargosuyla gönderince takip numarası Trendruum'a yazılır (müşteri Trendruum'dan izler)
export async function pushTrendruumTracking(ctx: TrCtx, packageId: string, tracking: string, carrier: string | null): Promise<void> {
  await trApi(ctx, "PUT", fill(trendruumPaths().shipment, { packageId }), { body: { trackingNumber: tracking, cargoCompany: carrier || "Diğer", status: "Shipped" } });
}
