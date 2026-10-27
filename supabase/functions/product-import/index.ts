import { featureEnabled, FEATURE_OFF_MSG, userIdFromToken } from "../_shared/features.ts";
// =========================================================
// HızlıSatıcı AI - product-import (Toplu Ürün Yükleme)
// Bir linki okur ve ürün bilgilerini çıkarır:
//   - XML beslemesi (bayi XML'i, Google Shopping vb.)  -> { kind: "feed", items: [...] }
//   - Kategori / liste sayfası                          -> { kind: "category", links: [...], next_page }
//   - Tek ürün sayfası                                  -> { kind: "product", item: {...} }
// Platforma özel okuma (satıcı farkı görmez; API varsa API, yoksa sayfa):
//   AliExpress (DS API, aliexpress-search "detail"), Shopify (/products/x.json, /products.json),
//   WooCommerce (Store API), Trendyol (sayfa içi ürün verisi), JSON-LD varyantları,
//   site ana sayfası -> site haritası (sitemap) ile tüm ürün linkleri.
// Ürünlerde: variants [{ supplier_variant_id, sku, attributes, price, stock, image }],
//   source_platform, source_item_id. Mağaza bazlı listeler { kind: "feed", items, next_page }.
// Site otomatik okumayı engelliyorsa ve okuma servisi açıksa (SCRAPER_ENABLED=true +
//   SCRAPER_URL_TEMPLATE secret, "{url}" yer tutuculu; ücretli, varsayılan KAPALI) onunla tekrar dener.
// Sadece giriş yapmış kullanıcılar kullanabilir.
// POST { url, language }
// =========================================================
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MAX_HTML = 3_000_000;   // 3 MB
const MAX_XML = 40_000_000;   // 40 MB
const MAX_FEED_ITEMS = 5000;
const SCRAPER_ENABLED = (Deno.env.get("SCRAPER_ENABLED") ?? "") === "true";
const SCRAPER_URL_TEMPLATE = Deno.env.get("SCRAPER_URL_TEMPLATE") ?? ""; // ör. https://servis/api?key=...&url={url}
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function hsIsLoggedIn(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token || token.split(".").length !== 3) return false;
  try {
    const r = await fetch((Deno.env.get("SUPABASE_URL") ?? "") + "/auth/v1/user", {
      headers: { Authorization: "Bearer " + token, apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" },
    });
    if (!r.ok) return false;
    const u = await r.json();
    return !!(u && u.id);
  } catch (_e) {
    return false;
  }
}

// ---------------- Güvenlik: sadece herkese açık web adresleri ----------------
function isSafeUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (u.port && !["80", "443", "8080"].includes(u.port)) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const p = h.split(".").map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) ||
        (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) ||
        (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224) return null;
  }
  if (h.startsWith("[") || h.includes(":")) return null; // IPv6 adresleri kapalı
  if (h.endsWith("supabase.co") || h.endsWith("supabase.in")) return null;
  return u;
}

// ---------------- Metin yardımcıları ----------------
function decodeEntities(s: string): string {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}
function stripTags(s: string): string {
  return decodeEntities(String(s || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}
function clean(s: unknown, max = 500): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}
// "1.234,56 TL" / "1,234.56" / "1234.5" -> 1234.56
function parsePrice(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
  let s = String(v).replace(/[^\d.,]/g, "");
  if (!s) return null;
  const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (lastComma > -1) {
    const dec = s.length - lastComma - 1;
    s = dec === 3 && s.split(",").length > 1 && !/,\d{1,2}$/.test(s) ? s.replace(/,/g, "") : s.replace(/,/g, ".");
  } else if (lastDot > -1) {
    const parts = s.split(".");
    if (parts.length > 2 || (parts[parts.length - 1].length === 3 && parts.length === 2 && parts[0].length <= 3)) s = s.replace(/\./g, "");
  }
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}
function guessCurrency(v: unknown): string | null {
  const s = String(v || "").toUpperCase();
  if (/TRY|TL|₺/.test(s)) return "TRY";
  if (/USD|\$/.test(s)) return "USD";
  if (/EUR|€/.test(s)) return "EUR";
  if (/GBP|£/.test(s)) return "GBP";
  return null;
}
function absUrl(href: string, base: URL): string | null {
  try {
    const u = new URL(decodeEntities(href.trim()), base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch { return null; }
}
function uniq<T>(arr: T[]): T[] { return Array.from(new Set(arr)); }

// ---------------- Sayfayı indir ----------------
function looksBlocked(status: number, text: string): boolean {
  if ([401, 403, 429, 503].includes(status)) return true;
  const head = text.slice(0, 6000);
  return text.length < 20000 && /cf-chl|challenge-platform|Just a moment\.\.\.|captcha-delivery|px-captcha|Attention Required/i.test(head);
}
async function download(u: URL, accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"): Promise<{ text: string; type: string; finalUrl: URL }> {
  try {
    return await downloadOnce(u, accept, false);
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    if (msg.startsWith("blocked") && SCRAPER_ENABLED && SCRAPER_URL_TEMPLATE) return await downloadOnce(u, accept, true);
    throw e;
  }
}
async function downloadOnce(u: URL, accept: string, viaScraper: boolean): Promise<{ text: string; type: string; finalUrl: URL }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), viaScraper ? 60000 : 25000);
  try {
    const target = viaScraper ? SCRAPER_URL_TEMPLATE.replace("{url}", encodeURIComponent(u.toString())) : u.toString();
    const r = await fetch(target, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
        "Accept": accept,
        "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
      },
    });
    const finalUrl = viaScraper ? u : isSafeUrl(r.url || u.toString());
    if (!finalUrl) throw new Error("unsafe_redirect");
    if (!r.ok) {
      if (!viaScraper && looksBlocked(r.status, "")) throw new Error("blocked_" + r.status);
      throw new Error("http_" + r.status);
    }
    const type = (r.headers.get("content-type") || "").toLowerCase();
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length > MAX_XML) throw new Error("too_large");
    let charset = (type.match(/charset=([\w-]+)/) || [])[1] || "utf-8";
    let text: string;
    try { text = new TextDecoder(charset).decode(buf); } catch { text = new TextDecoder("utf-8").decode(buf); }
    const declared = (text.slice(0, 300).match(/encoding=["']([\w-]+)["']/i) || [])[1] ||
      (text.slice(0, 3000).match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
    if (declared && declared.toLowerCase() !== charset.toLowerCase()) {
      try { text = new TextDecoder(declared.toLowerCase()).decode(buf); charset = declared; } catch { /* kalsın */ }
    }
    if (!viaScraper && looksBlocked(200, text)) throw new Error("blocked_page");
    return { text, type, finalUrl };
  } finally {
    clearTimeout(timer);
  }
}
async function getJson(u: URL): Promise<{ data: any; headers: Headers } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(u.toString(), {
      signal: ctrl.signal, redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SeltigoBot/1.0)", "Accept": "application/json" },
    });
    if (!r.ok || !isSafeUrl(r.url || u.toString())) return null;
    const data = await r.json().catch(() => null);
    return data == null ? null : { data, headers: r.headers };
  } catch { return null; } finally { clearTimeout(timer); }
}

// ---------------- XML beslemesi ----------------
const F = {
  name: ["name", "title", "urunadi", "urun_adi", "urunismi", "adi", "baslik", "product_name", "productname", "isim"],
  cost: ["bayifiyati", "bayi_fiyati", "bayifiyat", "bayi_fiyat", "dealer_price", "dealerprice", "alisfiyati", "alis_fiyati", "price", "fiyat", "satisfiyati", "satis_fiyati", "sale_price", "fiyat1", "price1"],
  list: ["psf", "tavsiyefiyat", "tavsiye_fiyat", "tavsiyeedilensatisfiyati", "listefiyati", "liste_fiyati", "list_price", "listprice", "piyasafiyati", "piyasa_fiyati", "msrp"],
  currency: ["currency", "para_birimi", "parabirimi", "doviz", "doviz_tipi", "currencycode", "kur"],
  stock: ["stock", "stok", "quantity", "miktar", "stokadedi", "stok_adedi", "stockquantity", "availability"],
  model: ["model", "modelkodu", "model_kodu", "mpn", "sku", "stokkodu", "stok_kodu", "urunkodu", "urun_kodu", "product_code", "productcode", "code", "kod", "id"],
  barcode: ["barcode", "barkod", "gtin", "ean", "upc"],
  brand: ["brand", "marka", "manufacturer", "uretici"],
  category: ["category", "kategori", "category_path", "kategoriadi", "kategori_adi", "product_type", "google_product_category", "categories"],
  desc: ["description", "aciklama", "detay", "details", "urunaciklama", "urun_aciklama", "uzunaciklama", "content"],
  link: ["link", "url", "product_url", "producturl", "urunlinki", "urun_linki"],
};

function xmlChildren(block: string): { tag: string; attrs: string; inner: string }[] {
  const out: { tag: string; attrs: string; inner: string }[] = [];
  const re = /<([\w:.-]+)(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) out.push({ tag: m[1], attrs: m[2] || "", inner: m[3] || "" });
  return out;
}
function attr(attrs: string, names: string[]): string {
  for (const n of names) {
    const m = attrs.match(new RegExp("\\s" + n + "\\s*=\\s*[\"']([^\"']*)[\"']", "i"));
    if (m) return decodeEntities(m[1]);
  }
  return "";
}
function normTag(t: string) { return t.toLowerCase().replace(/^[\w]+:/, ""); }

function parseFeedItem(block: string, base: URL) {
  const kids = xmlChildren(block);
  const byTag: Record<string, string> = {};
  for (const k of kids) {
    const n = normTag(k.tag);
    if (byTag[n] === undefined && !/<[\w:.-]+[\s>]/.test(k.inner)) byTag[n] = decodeEntities(k.inner).trim();
  }
  const pick = (names: string[]) => { for (const n of names) { if (byTag[n]) return byTag[n]; } return ""; };

  // Görseller
  const images: string[] = [];
  for (const k of kids) {
    const n = normTag(k.tag);
    if (/image|resim|picture|img|gorsel|foto|photo/.test(n)) {
      const val = decodeEntities(k.inner).trim() || attr(k.attrs, ["url", "src", "href", "path"]);
      val.split(/[\s,;|]+/).forEach((x) => { if (/^https?:\/\//i.test(x)) { const a = absUrl(x, base); if (a) images.push(a); } });
    }
  }
  (block.match(/https?:\/\/[^\s"'<>]+\.(?:jpe?g|png|webp)(?:\?[^\s"'<>]*)?/gi) || []).forEach((x) => images.push(x));

  // Teknik özellikler (iç içe etiketlerde de aranır: <Ozellikler><Ozellik .../></Ozellikler>)
  const specs: { k: string; v: string }[] = [];
  const specRe = /<((?:[\w]+:)?(?:ozellik|özellik|attribute|spec|property|feature|teknikozellik|product_detail|param))(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/\1\s*>)/gi;
  let sm: RegExpExecArray | null;
  while ((sm = specRe.exec(block)) && specs.length < 80) {
    const attrs = sm[2] || "", inner = sm[3] || "";
    let key = attr(attrs, ["name", "isim", "ad", "key", "baslik"]);
    let val = attr(attrs, ["value", "deger", "değer", "val"]);
    if (!key) {
      const sub = xmlChildren(inner);
      const sk = sub.find((x) => /^(name|isim|ad|key|attribute_name|baslik)$/.test(normTag(x.tag)));
      const sv = sub.find((x) => /^(value|deger|değer|attribute_value|val)$/.test(normTag(x.tag)));
      if (sk) key = decodeEntities(sk.inner).trim();
      if (sv) val = decodeEntities(sv.inner).trim();
    }
    if (!val && key && !/<[\w:.-]+[\s>]/.test(inner)) val = decodeEntities(inner).trim();
    if (key && val) specs.push({ k: clean(key, 80), v: clean(val, 200) });
  }

  const rawPrice = pick(F.cost);
  const name = clean(pick(F.name), 300);
  const link = pick(F.link);
  return {
    url: link && /^https?:/i.test(link) ? link : "",
    name,
    price: parsePrice(rawPrice),
    list_price: parsePrice(pick(F.list)),
    currency: guessCurrency(pick(F.currency)) || guessCurrency(rawPrice),
    stock: (() => { const s = pick(F.stock); const n = parseInt(s, 10); return Number.isFinite(n) ? n : (/in stock|var|mevcut/i.test(s) ? null : (/out of stock|yok|tükendi/i.test(s) ? 0 : null)); })(),
    model_code: clean(pick(F.model), 80),
    barcode: clean(pick(F.barcode), 40),
    brand: clean(pick(F.brand), 80),
    category: clean(pick(F.category), 200),
    description: clean(stripTags(pick(F.desc)), 5000),
    images: uniq(images).slice(0, 12),
    specs: specs.slice(0, 80),
  };
}

function parseFeed(xml: string, base: URL) {
  const counts: Record<string, number> = {};
  const re = /<([\w:.-]+)[\s>]/g;
  let m: RegExpExecArray | null;
  const sample = xml.length > 2_000_000 ? xml.slice(0, 2_000_000) : xml;
  while ((m = re.exec(sample))) counts[m[1]] = (counts[m[1]] || 0) + 1;
  const prefs = ["product", "urun", "item", "offer", "entry", "urunler_urun", "row", "record", "kayit"];
  let tag = "";
  for (const p of prefs) {
    const found = Object.keys(counts).filter((t) => normTag(t) === p).sort((a, b) => counts[b] - counts[a])[0];
    if (found && counts[found] >= 1) { tag = found; break; }
  }
  if (!tag) return [];
  const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockRe = new RegExp("<" + esc + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + esc + "\\s*>", "g");
  const items = [];
  let b: RegExpExecArray | null;
  while ((b = blockRe.exec(xml)) && items.length < MAX_FEED_ITEMS) {
    const it = parseFeedItem(b[1], base);
    if (it.name) items.push(it);
  }
  return items;
}

// ---------------- HTML ----------------
function jsonLdNodes(html: string): any[] {
  const out: any[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  const walk = (n: any) => {
    if (!n) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n !== "object") return;
    out.push(n);
    if (n["@graph"]) walk(n["@graph"]);
    if (n.mainEntity) walk(n.mainEntity);
    if (n.itemListElement) walk(n.itemListElement);
    if (n.item && typeof n.item === "object") walk(n.item);
  };
  while ((m = re.exec(html))) {
    try { walk(JSON.parse(m[1].trim())); } catch { /* bozuk json */ }
  }
  return out;
}
function isType(n: any, t: string) {
  const ty = n && n["@type"];
  return Array.isArray(ty) ? ty.includes(t) : ty === t;
}
function meta(html: string, prop: string): string {
  const re = new RegExp("<meta[^>]+(?:property|name|itemprop)=[\"']" + prop + "[\"'][^>]*>", "i");
  const tag = (html.match(re) || [])[0];
  if (!tag) return "";
  return decodeEntities((tag.match(/content=["']([^"']*)["']/i) || [])[1] || "");
}
function htmlSpecs(html: string): { k: string; v: string }[] {
  const specs: { k: string; v: string }[] = [];
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (const r of rows) {
    const cells = r.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || [];
    if (cells.length === 2) {
      const k = clean(stripTags(cells[0]), 80), v = clean(stripTags(cells[1]), 200);
      if (k && v && k.length < 80 && !/^\d+([.,]\d+)?$/.test(k)) specs.push({ k, v });
    }
  }
  const dls = html.match(/<dt[^>]*>[\s\S]*?<\/dt>\s*<dd[^>]*>[\s\S]*?<\/dd>/gi) || [];
  for (const d of dls) {
    const k = clean(stripTags((d.match(/<dt[^>]*>([\s\S]*?)<\/dt>/i) || [])[1] || ""), 80);
    const v = clean(stripTags((d.match(/<dd[^>]*>([\s\S]*?)<\/dd>/i) || [])[1] || ""), 200);
    if (k && v) specs.push({ k, v });
  }
  const lis = html.match(/<li[^>]*>[\s\S]{3,200}?<\/li>/gi) || [];
  for (const li of lis) {
    const txt = clean(stripTags(li), 220);
    const mm = txt.match(/^([^:]{2,50}):\s*(.{1,160})$/);
    if (mm) specs.push({ k: mm[1].trim(), v: mm[2].trim() });
  }
  const seen = new Set<string>();
  return specs.filter((s) => { const key = s.k.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 80);
}
function htmlImages(html: string, base: URL): string[] {
  const imgs: string[] = [];
  const re = /<img[^>]+>/gi;
  const tags = html.match(re) || [];
  for (const t of tags) {
    const src = (t.match(/(?:data-zoom-image|data-large|data-original|data-src|src)=["']([^"']+)["']/i) || [])[1];
    if (!src || /^data:/i.test(src)) continue;
    if (/logo|icon|sprite|banner|payment|placeholder|loading|flag|avatar|\.svg|\.gif/i.test(src + t)) continue;
    const a = absUrl(src, base);
    if (a) imgs.push(a);
  }
  return uniq(imgs);
}
function htmlLinks(html: string, base: URL): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];
  const re = /<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 1500) {
    const a = absUrl(m[1], base);
    if (!a) continue;
    try { if (new URL(a).hostname !== base.hostname) continue; } catch { continue; }
    out.push({ href: a, text: clean(stripTags(m[2]), 80) });
  }
  const seen = new Set<string>();
  return out.filter((l) => { if (seen.has(l.href)) return false; seen.add(l.href); return true; });
}
function nextPageLink(html: string, base: URL): string {
  const rel = (html.match(/<link[^>]+rel=["']next["'][^>]*>/i) || [])[0] || (html.match(/<a[^>]+rel=["']next["'][^>]*>/i) || [])[0];
  if (rel) {
    const h = (rel.match(/href=["']([^"']+)["']/i) || [])[1];
    const a = h ? absUrl(h, base) : null;
    if (a) return a;
  }
  return "";
}

function extractJson(text: string): any {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function askAI(system: string, user: string): Promise<any> {
  if (!ANTHROPIC_API_KEY) return null;
  for (const model of ["claude-haiku-4-5", "claude-sonnet-5"]) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 3000, system, messages: [{ role: "user", content: user }] }),
      });
      const d = await r.json();
      if (!r.ok) { console.error(model, d?.error?.message); continue; }
      const text = (d?.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      const parsed = extractJson(text);
      if (parsed) return parsed;
    } catch (e) { console.error(model, e); }
  }
  return null;
}

// Ticimax: ürün sayfasındaki "var productDetailModel = {...}" (fiyat, barkod, stok kodu, beden / renk seçenekleri)
function ticimaxFromHtml(html: string, base: URL): any | null {
  const at = html.indexOf("var productDetailModel");
  if (at < 0) return null;
  const start = html.indexOf("{", at);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < Math.min(html.length, start + 2_000_000); i++) {
    const ch = html[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === "{") depth++; else if (ch === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) return null;
  let d: any;
  try { d = JSON.parse(html.slice(start, end)); } catch { return null; }
  if (!d?.productName) return null;
  const ps: any[] = Array.isArray(d.products) ? d.products : [];
  const main = ps.find((x) => x.anaUrun) || ps[0] || d.product || {};
  const attrsOf = new Map<number, Record<string, string>>();
  for (const v of (Array.isArray(d.productVariantData) ? d.productVariantData : [])) {
    const a = attrsOf.get(v.urunID) || {};
    if (v.ekSecenekTipiTanim && v.tanim) a[clean(v.ekSecenekTipiTanim, 40)] = clean(v.tanim, 60);
    attrsOf.set(v.urunID, a);
  }
  const priceOf = (x: any) => Number(x?.indirimliFiyati) > 0 ? Number(x.indirimliFiyati) : Number(x?.satisFiyati) > 0 ? Number(x.satisFiyati) : null;
  const variants: Variant[] = ps.map((x) => ({
    supplier_variant_id: String(x.id), sku: clean(x.barkod || x.stokKodu, 80), attributes: attrsOf.get(x.id) || {},
    price: priceOf(x), stock: Number.isFinite(Number(x.stokAdedi)) ? Number(x.stokAdedi) : null, image: null,
  })).filter((v) => Object.keys(v.attributes).length > 0);
  const ld = jsonLdNodes(html).find((n) => isType(n, "Product"));
  const imgs = uniq([
    ...(Array.isArray(main.resimler) ? main.resimler.map((r: any) => typeof r === "string" ? r : r?.resimBuyukYolu || r?.resimYolu) : []),
    main.spotResimBuyukYolu, meta(html, "og:image"), ...htmlImages(html, base).filter((u) => /uploads\/urunresimleri/i.test(u)),
  ].filter((u) => typeof u === "string" && u && !/resim-hazirlaniyor/.test(u)).map((u: string) => absUrl(u, base)).filter(Boolean) as string[]).slice(0, 12);
  const price = priceOf(main) ?? parsePrice(d.productPrice);
  return {
    url: base.toString(), name: clean(d.productName, 300), price, list_price: Number(main.satisFiyati) > (price || 0) ? Number(main.satisFiyati) : null,
    currency: guessCurrency(d.productCurrency || main.paraBirimiKodu) || "TRY",
    stock: Number.isFinite(Number(d.totalStockAmount)) ? Number(d.totalStockAmount) : null,
    model_code: clean(d.stockCode || main.stokKodu, 80), barcode: clean(main.barkod, 40), brand: clean(d.brandName, 80), category: "",
    description: clean(stripTags(ld?.description || d.productShortDescription || meta(html, "og:description") || ""), 5000),
    images: imgs, specs: [] as { k: string; v: string }[], variants: variants.slice(0, 100),
    source_platform: "ticimax", source_item_id: String(d.productId || main.urunKartiId || ""),
  };
}

// Next.js tabanlı vitrinler (ör. ikas): sayfa verisindeki ürün görselleri
function nextDataImages(html: string, base: URL): string[] {
  const m = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return [];
  const out: string[] = [];
  const walk = (o: any, d: number) => {
    if (!o || d > 9 || out.length >= 12) return;
    if (typeof o === "string") { if (/^https?:\/\/[^"\s]+\.(jpe?g|png|webp)(\?|$)/i.test(o)) out.push(o); return; }
    if (Array.isArray(o)) { o.forEach((x) => walk(x, d + 1)); return; }
    if (typeof o === "object") Object.values(o).forEach((x) => walk(x, d + 1));
  };
  try { walk(JSON.parse(m[1])?.props?.pageProps, 0); } catch { return []; }
  return uniq(out.map((x) => absUrl(x, base)).filter(Boolean) as string[]).slice(0, 12);
}

async function parseHtml(html: string, base: URL) {
  if (html.length > MAX_HTML) html = html.slice(0, MAX_HTML);
  const nodes = jsonLdNodes(html);
  const prod = nodes.find((n) => isType(n, "Product") || isType(n, "ProductGroup"));
  const list = nodes.filter((n) => isType(n, "ListItem") || isType(n, "ItemList"));

  // 1) Liste sayfası mı? (JSON-LD ItemList)
  const listUrls: string[] = [];
  for (const n of list) {
    const u = n.url || (n.item && (typeof n.item === "string" ? n.item : n.item.url || n.item["@id"]));
    if (typeof u === "string") { const a = absUrl(u, base); if (a && a !== base.toString()) listUrls.push(a); }
  }

  const specsDet = htmlSpecs(html);
  const imgsDet = htmlImages(html, base);
  const title = clean(stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ""), 200);

  // Ürün (deterministik)
  const item: any = {
    url: base.toString(), name: "", price: null, list_price: null, currency: null, stock: null,
    model_code: "", barcode: "", brand: "", category: "", description: "", images: [] as string[], specs: specsDet,
  };
  if (prod) {
    const offers = Array.isArray(prod.offers) ? prod.offers[0] : (prod.offers || {});
    const offer = offers && offers.offers ? (Array.isArray(offers.offers) ? offers.offers[0] : offers.offers) : offers;
    item.name = clean(prod.name, 300);
    item.price = parsePrice(offer?.price ?? offer?.lowPrice ?? offers?.lowPrice);
    item.currency = guessCurrency(offer?.priceCurrency || offers?.priceCurrency);
    item.model_code = clean(prod.mpn || prod.sku || prod.model?.name || prod.model || "", 80);
    item.barcode = clean(prod.gtin13 || prod.gtin || prod.gtin12 || prod.ean || "", 40);
    item.brand = clean(typeof prod.brand === "string" ? prod.brand : prod.brand?.name || "", 80);
    item.category = clean(typeof prod.category === "string" ? prod.category : "", 200);
    item.description = clean(stripTags(prod.description || ""), 5000);
    const im = Array.isArray(prod.image) ? prod.image : (prod.image ? [prod.image] : []);
    // Görsel; metin, { url } ya da { contentUrl: [..] } biçiminde gelebilir
    const flat: string[] = [];
    im.forEach((x: any) => {
      if (typeof x === "string") flat.push(x);
      else if (x) [x.url, x.contentUrl].flat().forEach((y: any) => { if (typeof y === "string") flat.push(y); });
    });
    item.images = flat.map((x) => absUrl(x, base)).filter(Boolean);
    if (Array.isArray(prod.additionalProperty)) {
      prod.additionalProperty.forEach((p: any) => { if (p?.name && p?.value != null) item.specs.push({ k: clean(p.name, 80), v: clean(p.value, 200) }); });
    }
  }
  if (!item.name) item.name = clean(meta(html, "og:title"), 300);
  if (item.price == null) item.price = parsePrice(meta(html, "product:price:amount") || meta(html, "og:price:amount") || meta(html, "price"));
  if (!item.currency) item.currency = guessCurrency(meta(html, "product:price:currency") || meta(html, "og:price:currency") || meta(html, "priceCurrency"));
  if (!item.description) item.description = clean(meta(html, "og:description") || meta(html, "description"), 5000);
  const og = meta(html, "og:image");
  if (og) { const a = absUrl(og, base); if (a) item.images.unshift(a); }
  if (item.images.length < 3) item.images = item.images.concat(imgsDet.slice(0, 10));
  item.images = uniq(item.images).slice(0, 12);

  const isProductByLd = !!(prod && item.name);
  if (!isProductByLd && listUrls.length >= 3) {
    return { kind: "category", links: uniq(listUrls).slice(0, 500), next_page: nextPageLink(html, base) };
  }

  // 2) Yapay zekâ: sayfa türünü anla / eksikleri tamamla
  const needAI = !isProductByLd || item.specs.length < 3 || item.price == null;
  if (!needAI) return { kind: "product", item };

  const text = stripTags(html.replace(/<(header|footer|nav)[\s\S]*?<\/\1>/gi, " ")).slice(0, 14000);
  const links = isProductByLd ? [] : htmlLinks(html, base).slice(0, 350);
  const system = `You extract e-commerce product data from a web page. Answer ONLY with JSON.
Decide if the page is a SINGLE product page or a LIST/CATEGORY page with many products.
JSON format:
{"kind":"product"|"category",
 "product":{"name":"","price":0,"currency":"TRY","list_price":0,"brand":"","model_code":"","barcode":"","category":"","description":"","specs":[{"k":"","v":""}]},
 "product_links":["full urls of individual product pages on this list"],
 "next_page":"full url of the next page of the list or empty"}
Rules: For a product page fill "product" (specs = technical specifications as key/value pairs, keep the page language; description = a clean plain-text product description, max 1500 chars; price = the main selling price as a number without currency symbols; model_code = model/sku/product code). For a list page fill "product_links" with ONLY links that go to individual product detail pages (not categories, filters, cart, login, blog). Never invent data.`;
  const user = `URL: ${base}\nTITLE: ${title}\n\nPAGE TEXT:\n${text}\n\n` +
    (links.length ? `LINKS (href | text):\n${links.map((l) => l.href + " | " + l.text).join("\n")}\n` : "");
  const ai = await askAI(system, user);

  if (ai && ai.kind === "category" && !isProductByLd) {
    const linkSet = new Set(links.map((l) => l.href));
    const pl = (Array.isArray(ai.product_links) ? ai.product_links : [])
      .map((x: any) => absUrl(String(x || ""), base)).filter((x: any) => x && (linkSet.has(x) || x.startsWith(base.origin)));
    const all = uniq([...listUrls, ...pl]);
    if (all.length) {
      const np = nextPageLink(html, base) || (ai.next_page ? absUrl(String(ai.next_page), base) : "") || "";
      return { kind: "category", links: all.slice(0, 500), next_page: np && isSafeUrl(np) ? np : "" };
    }
  }

  const p = (ai && ai.product) || {};
  if (!item.name) item.name = clean(p.name, 300);
  if (item.price == null) item.price = parsePrice(p.price);
  if (item.list_price == null) item.list_price = parsePrice(p.list_price);
  if (!item.currency) item.currency = guessCurrency(p.currency);
  if (!item.brand) item.brand = clean(p.brand, 80);
  if (!item.model_code) item.model_code = clean(p.model_code, 80);
  if (!item.barcode) item.barcode = clean(p.barcode, 40);
  if (!item.category) item.category = clean(p.category, 200);
  if (!item.description || item.description.length < 40) item.description = clean(p.description, 5000) || item.description;
  if (Array.isArray(p.specs) && p.specs.length > item.specs.length) {
    item.specs = p.specs.map((s: any) => ({ k: clean(s?.k, 80), v: clean(s?.v, 200) })).filter((s: any) => s.k && s.v).slice(0, 80);
  }
  if (!item.name) item.name = title;
  return { kind: "product", item };
}

// ---------------- Platform okuyucuları ----------------
type Variant = { supplier_variant_id: string; sku: string; attributes: Record<string, string>; price: number | null; stock: number | null; image: string | null };
const stockOf = (avail: unknown, qty: unknown): number | null => {
  const n = Number(qty);
  if (qty != null && qty !== "" && Number.isFinite(n)) return n;
  if (avail === false) return 0;
  return null; // var ama adet bilinmiyor
};

// AliExpress: satıcının (yoksa sitenin) AliExpress hesabıyla DS API
async function aliexpressItem(u: URL, authHeader: string, sys: { cronSecret: string; userId: string } | null = null) {
  const id = (u.pathname.match(/\/item\/(\d+)/) || [])[1] || u.searchParams.get("productId") || "";
  if (!id) return null;
  const r = await fetch(`${SUPABASE_URL}/functions/v1/aliexpress-search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader, apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" },
    body: JSON.stringify({ action: "detail", productId: id, country: "TR", ...(sys || {}) }),
  });
  const d = await r.json().catch(() => ({}));
  if (!d?.item?.name) return { error: String(d?.error || "AliExpress ürünü okunamadı").slice(0, 200) };
  const it = d.item;
  return {
    kind: "product",
    item: {
      url: `https://www.aliexpress.com/item/${id}.html`, name: clean(it.name, 300), price: it.price, list_price: null,
      currency: "USD", stock: it.stock ?? null, model_code: "", barcode: "", brand: "", category: "",
      description: clean(stripTags(it.description || ""), 5000), images: it.images || [], specs: it.specs || [],
      variants: (it.variants || []).map((v: any) => ({
        supplier_variant_id: v.supplier_variant_id, sku: v.sku_attr || "", attributes: v.attributes || {},
        price: v.price, stock: v.stock, image: v.image,
      })).filter((v: Variant) => Object.keys(v.attributes).length),
      source_platform: "aliexpress", source_item_id: id,
    },
  };
}

// Shopify
function shopifyProduct(p: any, origin: string) {
  const optNames: string[] = (p.options || []).map((o: any) => String(o?.name || o || ""));
  const imgById = new Map<number, string>();
  (p.images || []).forEach((im: any) => { if (im?.id && im?.src) imgById.set(im.id, im.src); });
  const fix = (x: string) => (x && x.startsWith("//") ? "https:" + x : x);
  const variants: Variant[] = (p.variants || []).map((v: any) => {
    const attributes: Record<string, string> = {};
    [v.option1, v.option2, v.option3].forEach((val: any, i: number) => {
      if (val && val !== "Default Title") attributes[optNames[i] || `Seçenek ${i + 1}`] = String(val);
    });
    return {
      supplier_variant_id: String(v.id), sku: clean(v.sku, 80), attributes,
      price: parsePrice(v.price), stock: stockOf(v.available, v.inventory_quantity),
      image: fix(v.featured_image?.src || (v.image_id ? imgById.get(v.image_id) || "" : "")) || null,
    };
  });
  const real = variants.filter((v) => Object.keys(v.attributes).length);
  const prices = variants.map((v) => v.price).filter((n): n is number => !!n);
  const imgs: string[] = (p.images || []).map((im: any) => fix(typeof im === "string" ? im : im?.src || "")).filter(Boolean);
  const anyUnknown = variants.some((v) => v.stock === null);
  return {
    url: `${origin}/products/${p.handle}`, name: clean(p.title, 300),
    price: prices.length ? Math.min(...prices) : null, list_price: parsePrice(p.variants?.[0]?.compare_at_price),
    currency: null, stock: anyUnknown ? null : variants.reduce((a, v) => a + (v.stock || 0), 0),
    model_code: clean(p.variants?.[0]?.sku || "", 80), barcode: clean(p.variants?.[0]?.barcode || "", 40),
    brand: clean(p.vendor, 80), category: clean(p.product_type, 200),
    description: clean(stripTags(p.body_html || p.description || ""), 5000),
    images: uniq(imgs).slice(0, 12), specs: [] as { k: string; v: string }[],
    variants: real.slice(0, 100),
    source_platform: "shopify", source_item_id: String(p.id),
  };
}
// Shopify ürün listesi fiyatları mağazanın ana para birimindedir; o da /meta.json'da yazar.
// (cart.js ziyaretçinin ülkesine göre değişir, kullanılmaz.)
const shopCurrency = new Map<string, string | null>();
async function shopifyCurrency(origin: string): Promise<string | null> {
  if (shopCurrency.has(origin)) return shopCurrency.get(origin)!;
  const r = await getJson(new URL(`${origin}/meta.json`));
  const c = typeof r?.data?.currency === "string" && /^[A-Z]{3}$/.test(r.data.currency) ? r.data.currency : null;
  shopCurrency.set(origin, c);
  return c;
}
const SHOPIFY_PAGES_PER_CALL = 4;
async function shopifyList(u: URL) {
  const coll = (u.pathname.match(/\/collections\/[^/]+/) || [""])[0];
  let page = Math.max(1, parseInt(u.searchParams.get("page") || "1", 10));
  const items: any[] = [];
  for (let i = 0; i < SHOPIFY_PAGES_PER_CALL; i++, page++) {
    const r = await getJson(new URL(`${u.origin}${coll}/products.json?limit=250&page=${page}`));
    const list = r?.data?.products;
    if (!Array.isArray(list) || !list.length) return { items, next: "" };
    const cur = await shopifyCurrency(u.origin);
    list.forEach((p: any) => items.push({ ...shopifyProduct(p, u.origin), currency: cur }));
    if (list.length < 250) return { items, next: "" };
  }
  return { items, next: `${u.origin}${coll}/products.json?page=${page}` };
}
async function shopifySingle(u: URL) {
  const handle = (u.pathname.match(/\/products\/([^/?#]+)/) || [])[1];
  if (!handle) return null;
  const r = await getJson(new URL(`${u.origin}/products/${handle}.json`));
  return r?.data?.product ? { ...shopifyProduct(r.data.product, u.origin), currency: await shopifyCurrency(u.origin) } : null;
}

// WooCommerce (herkese açık Store API)
function wooMoney(prices: any, key: string): number | null {
  if (!prices || prices[key] == null || prices[key] === "") return null;
  const n = Number(prices[key]) / Math.pow(10, Number(prices.currency_minor_unit ?? 2));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}
function wooProduct(p: any) {
  const price = wooMoney(p.prices, "price"), regular = wooMoney(p.prices, "regular_price");
  return {
    url: p.permalink, name: clean(stripTags(p.name || ""), 300), price,
    list_price: regular && price && regular > price ? regular : null, currency: p.prices?.currency_code || null,
    stock: p.is_in_stock === false ? 0 : (p.low_stock_remaining ?? null), model_code: clean(p.sku, 80), barcode: "",
    brand: clean((p.brands || [])[0]?.name || "", 80), category: clean((p.categories || []).map((c: any) => c.name).join(" > "), 200),
    description: clean(stripTags(p.description || p.short_description || ""), 5000),
    images: (p.images || []).map((im: any) => im.src).filter(Boolean).slice(0, 12),
    specs: (p.attributes || []).filter((a: any) => !a.has_variations)
      .map((a: any) => ({ k: clean(a.name, 80), v: clean((a.terms || []).map((t: any) => t.name).join(", "), 200) })).filter((x: any) => x.k && x.v),
    variants: [] as Variant[],
    source_platform: "woocommerce", source_item_id: String(p.id),
  };
}
async function wooVariants(origin: string, p: any, item: any) {
  const out: Variant[] = [];
  for (const v of (p.variations || []).slice(0, 40)) {
    const r = await getJson(new URL(`${origin}/wp-json/wc/store/v1/products/${v.id}`));
    const d = r?.data;
    const attributes: Record<string, string> = {};
    (v.attributes || []).forEach((a: any) => { if (a?.name) attributes[a.name] = String(a.value || ""); });
    out.push({
      supplier_variant_id: String(v.id), sku: clean(d?.sku, 80), attributes,
      price: wooMoney(d?.prices, "price"),
      stock: d ? (d.is_in_stock === false ? 0 : d.low_stock_remaining ?? null) : null,
      image: d?.images?.[0]?.src || null,
    });
  }
  item.variants = out;
  return item;
}
const WOO_PAGES_PER_CALL = 5;
async function wooList(u: URL) {
  let page = Math.max(1, parseInt(u.searchParams.get("page") || "1", 10));
  const items: any[] = [];
  for (let i = 0; i < WOO_PAGES_PER_CALL; i++, page++) {
    const r = await getJson(new URL(`${u.origin}/wp-json/wc/store/v1/products?per_page=100&page=${page}`));
    const list = r?.data;
    if (!Array.isArray(list) || !list.length) return { items, next: "" };
    list.forEach((p: any) => items.push(wooProduct(p)));
    const total = parseInt(r?.headers.get("x-wp-totalpages") || "0", 10);
    if (list.length < 100 || (total && page >= total)) return { items, next: "" };
  }
  return { items, next: `${u.origin}/wp-json/wc/store/v1/products?page=${page}` };
}
async function wooSingle(u: URL) {
  const slug = u.pathname.split("/").filter(Boolean).pop() || "";
  if (!slug) return null;
  const r = await getJson(new URL(`${u.origin}/wp-json/wc/store/v1/products?slug=${encodeURIComponent(slug)}`));
  const p = Array.isArray(r?.data) ? r!.data[0] : null;
  return p ? await wooVariants(u.origin, p, wooProduct(p)) : null;
}

// Trendyol: sayfanın içindeki ürün verisi.
// Not: Trendyol Türkiye dışındaki sunuculara uluslararası vitrini (ör. /de, Euro, Almanca) veriyor.
// Görsel, seçenek, barkod, marka ve özellikler aynı; fiyat o vitrinin para biriminde gelir.
function trendyolFromHtml(html: string, base: URL) {
  // Yeni yapı (2026): window["__envoy__SHARED_PROPS"] = { product: {...} }
  const em = html.match(/window\["__envoy__SHARED_PROPS"\]\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/);
  if (em) {
    let env: any = null;
    try { env = JSON.parse(em[1]); } catch { env = null; }
    const p = env?.product;
    if (p?.name) {
      const ldProd = jsonLdNodes(html).find((n) => isType(n, "Product"));
      const offer = Array.isArray(ldProd?.offers) ? ldProd.offers[0] : ldProd?.offers;
      const currency = guessCurrency(offer?.priceCurrency) || (/^\/(de|en|bg|ro|gr|cz|sk|hu|pl|az|sa|ae)\//.test(base.pathname) ? null : "TRY");
      const vs: any[] = Array.isArray(p.variants) ? p.variants : [];
      const variants: Variant[] = vs.map((v: any) => ({
        supplier_variant_id: String(v.itemNumber || v.barcode || ""),
        sku: clean(v.barcode, 80),
        attributes: { [clean(p.variantAttributeName || p.sizeAttributeName || "Seçenek", 40)]: String(v.beautifiedValue || v.value || "") },
        price: parsePrice(v.price?.value),
        stock: v.inStock === false ? 0 : null, image: null,
      })).filter((v) => v.supplier_variant_id && Object.values(v.attributes)[0]);
      // Fiyat seçeneklerin içinde (tek seçenekli üründe seçeneğin adı boş olabilir; fiyatı yine oradan)
      const prices = vs.map((v: any) => parsePrice(v.price?.value)).filter((n): n is number => !!n);
      const brand = clean(p.brand?.name || p.webBrand?.name, 80);
      return {
        url: base.toString(), name: clean((brand && !String(p.name).startsWith(brand) ? brand + " " : "") + p.name, 300),
        price: prices.length ? Math.min(...prices) : parsePrice(offer?.price), list_price: null,
        currency: currency || guessCurrency(offer?.priceCurrency), stock: p.inStock === false ? 0 : null,
        model_code: clean(p.productCode || "", 80), barcode: clean(vs[0]?.barcode || "", 40), brand,
        category: clean(String(p.category?.hierarchy || p.category?.name || "").replace(/\//g, " > "), 200),
        description: clean(stripTags(ldProd?.description || ""), 5000),
        images: uniq((p.images || []).map((x: string) => String(x))).slice(0, 12),
        specs: (p.attributes || []).map((a: any) => ({ k: clean(a.key?.name, 80), v: clean(a.value?.name, 200) })).filter((x: any) => x.k && x.v),
        variants: variants.length > 1 ? variants.slice(0, 100) : [],
        source_platform: "trendyol", source_item_id: String(p.id || ""),
      };
    }
  }
  // Eski yapı
  const m = html.match(/__PRODUCT_DETAIL_APP_INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});\s*(?:window\.|<\/script>)/);
  if (!m) return null;
  let st: any;
  try { st = JSON.parse(m[1]); } catch { return null; }
  const p = st?.product;
  if (!p?.name) return null;
  const cdn = (x: string) => (x.startsWith("http") ? x : "https://cdn.dsmcdn.com" + (x.startsWith("/") ? "" : "/") + x);
  const attrName = p.variants?.[0]?.attributeName || "Seçenek";
  const variants: Variant[] = (p.allVariants || p.variants || []).map((v: any) => ({
    supplier_variant_id: String(v.itemNumber || v.barcode || v.value || v.attributeValue || ""),
    sku: clean(v.barcode, 80),
    attributes: { [attrName]: String(v.value || v.attributeValue || "") },
    price: parsePrice(v.price?.sellingPrice?.value ?? v.price),
    stock: v.inStock === false ? 0 : null, image: null,
  })).filter((v: Variant) => Object.values(v.attributes)[0]);
  return {
    url: base.toString(), name: clean(p.name, 300),
    price: parsePrice(p.price?.sellingPrice?.value ?? p.price?.discountedPrice?.value), list_price: parsePrice(p.price?.originalPrice?.value),
    currency: "TRY", stock: p.hasStock === false ? 0 : null, model_code: clean(p.productCode || "", 80), barcode: "",
    brand: clean(p.brand?.name, 80), category: clean(p.category?.hierarchy || p.category?.name, 200),
    description: clean((p.contentDescriptions || []).map((d: any) => stripTags(d.description || "")).join("\n"), 5000),
    images: (p.images || []).map((x: string) => cdn(String(x))).slice(0, 12),
    specs: (p.attributes || []).map((a: any) => ({ k: clean(a.key?.name, 80), v: clean(a.value?.name, 200) })).filter((x: any) => x.k && x.v),
    variants: variants.length > 1 ? variants.slice(0, 100) : [],
    source_platform: "trendyol", source_item_id: String(p.id || (base.pathname.match(/-p-(\d+)/) || [])[1] || ""),
  };
}

// JSON-LD varyantları (ProductGroup.hasVariant)
function jsonLdVariants(html: string, base: URL): Variant[] {
  const group = jsonLdNodes(html).find((n) => isType(n, "ProductGroup"));
  const out: Variant[] = [];
  if (group && Array.isArray(group.hasVariant)) {
    const varies: string[] = (Array.isArray(group.variesBy) ? group.variesBy : [group.variesBy]).filter(Boolean)
      .map((x: string) => String(x).split("/").pop() || "");
    for (const v of group.hasVariant.slice(0, 100)) {
      const offer = Array.isArray(v.offers) ? v.offers[0] : v.offers || {};
      const attributes: Record<string, string> = {};
      varies.forEach((k) => {
        const key = k.charAt(0).toLowerCase() + k.slice(1);
        if (v[key]) attributes[k] = String(typeof v[key] === "object" ? v[key].name || "" : v[key]);
      });
      (v.additionalProperty || []).forEach((ap: any) => { if (ap?.name && ap?.value != null) attributes[ap.name] = String(ap.value); });
      if (!Object.keys(attributes).length && v.name) attributes["Seçenek"] = clean(v.name, 80);
      const im = Array.isArray(v.image) ? v.image[0] : v.image;
      out.push({
        supplier_variant_id: clean(v.sku || v["@id"] || "", 80), sku: clean(v.sku, 80), attributes,
        price: parsePrice(offer?.price), stock: /OutOfStock/i.test(String(offer?.availability || "")) ? 0 : null,
        image: im ? absUrl(typeof im === "string" ? im : im.url || "", base) : null,
      });
    }
  }
  return out.length > 1 ? out : [];
}

// Site ana sayfası: site haritasından ürün linkleri
const MAX_SITEMAP_LINKS = 3000;
const NOT_PRODUCT = /\/(blog|blogs|haber|news|kategori|category|categories|collections?|tag|tags|etiket|sayfa|page|pages|hakkimizda|iletisim|contact|about|cart|sepet|account|hesap|marka|brands?)(\/|$)/i;
async function sitemapProductLinks(u: URL): Promise<string[]> {
  const maps: string[] = [];
  try {
    const robots = await download(new URL(`${u.origin}/robots.txt`), "text/plain");
    (robots.text.match(/^\s*sitemap:\s*\S+/gim) || []).forEach((l) => {
      const x = l.replace(/^\s*sitemap:\s*/i, "").trim();
      if (isSafeUrl(x)) maps.push(x);
    });
  } catch { /* robots.txt yok */ }
  if (!maps.length) maps.push(`${u.origin}/sitemap.xml`, `${u.origin}/sitemap_index.xml`);
  const links: string[] = [];
  const seen = new Set<string>();
  const queue = maps.slice(0, 5);
  let fetched = 0;
  while (queue.length && fetched < 12 && links.length < MAX_SITEMAP_LINKS) {
    const m = queue.shift()!;
    if (seen.has(m)) continue;
    seen.add(m);
    const mu = isSafeUrl(m);
    if (!mu) continue;
    let xml = "";
    try { xml = (await download(mu, "application/xml,text/xml;q=0.9,*/*;q=0.5")).text; fetched++; } catch { continue; }
    const locs = (xml.match(/<loc>\s*[^<\s]+\s*<\/loc>/gi) || []).map((x) => decodeEntities(x.replace(/<\/?loc>/gi, "").trim()));
    if (/<sitemapindex/i.test(xml)) {
      const prod = locs.filter((x) => /product|urun|ürün|item/i.test(x));
      (prod.length ? prod : locs).slice(0, 10).forEach((x) => queue.push(x));
      continue;
    }
    for (const l of locs) {
      const lu = isSafeUrl(l);
      if (!lu || lu.hostname.replace(/^www\./, "") !== u.hostname.replace(/^www\./, "") || lu.pathname === "/" || NOT_PRODUCT.test(lu.pathname)) continue;
      links.push(lu.toString());
      if (links.length >= MAX_SITEMAP_LINKS) break;
    }
  }
  return uniq(links);
}

// ---------------- Ana ----------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const body = await req.json().catch(() => ({}));
  // Sistem çağrısı (source-sync): CRON_SECRET + satıcının kimliği (AliExpress hesabı için)
  const CRON = Deno.env.get("CRON_SECRET") ?? "";
  const sysCall = !!CRON && typeof body?.cronSecret === "string" && body.cronSecret.trim() === CRON.trim();
  const fUid = sysCall ? (typeof body?.userId === "string" ? body.userId : "system") : await userIdFromToken(req.headers.get("Authorization"));
  if (!fUid) return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);
  if (!(await featureEnabled(fUid, "link_import"))) return json({ error: FEATURE_OFF_MSG, feature: "link_import" }, 403);
  const en = String(body?.language || "").toLowerCase().startsWith("en");
  const E = (tr: string, eng: string) => (en ? eng : tr);

  try {
    const u = isSafeUrl(String(body?.url || "").trim());
    if (!u) return json({ error: E("Geçerli bir web adresi (http/https) yaz.", "Enter a valid web address (http/https).") }, 400);

    const authHeader = req.headers.get("Authorization") || "";
    const host = u.hostname.toLowerCase();

    // AliExpress ürün linki -> DS API
    if (/(^|\.)aliexpress\.(com|us|ru)$/.test(host) && /\/item\/\d+/.test(u.pathname)) {
      const ae: any = await aliexpressItem(u, authHeader,
        sysCall && typeof body?.userId === "string" ? { cronSecret: String(body.cronSecret), userId: body.userId } : null);
      if (ae?.error) return json({ error: E("AliExpress ürünü okunamadı: ", "Could not read the AliExpress product: ") + ae.error }, 422);
      if (ae) return json({ ...ae, url: ae.item.url, platform: "aliexpress" });
    }
    // Shopify / WooCommerce liste adresinin devamı (sayfalı)
    if (/\/products\.json$/.test(u.pathname)) {
      const r = await shopifyList(u);
      return json({ kind: "feed", url: u.toString(), items: r.items, total: r.items.length, next_page: r.next, platform: "shopify" });
    }
    if (/\/wp-json\/wc\/store\/v1\/products$/.test(u.pathname)) {
      const r = await wooList(u);
      return json({ kind: "feed", url: u.toString(), items: r.items, total: r.items.length, next_page: r.next, platform: "woocommerce" });
    }

    let page;
    try {
      page = await download(u);
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      if (msg.startsWith("blocked")) {
        // Sayfa engellense de mağaza altyapısının veri adresleri açık olabilir (Shopify / WooCommerce)
        const isRootReq = u.pathname.replace(/\/+$/, "") === "";
        if (/\/products\/[^/]+/.test(u.pathname)) {
          const it = await shopifySingle(u);
          if (it?.name) return json({ kind: "product", item: it, url: it.url, platform: "shopify" });
        }
        if (isRootReq || /\/collections(\/[^/]+)?\/?$/.test(u.pathname)) {
          const r = await shopifyList(u);
          if (r.items.length) return json({ kind: "feed", url: u.toString(), items: r.items, total: r.items.length, next_page: r.next, platform: "shopify" });
        }
        if (isRootReq) {
          const r = await wooList(u);
          if (r.items.length) return json({ kind: "feed", url: u.toString(), items: r.items, total: r.items.length, next_page: r.next, platform: "woocommerce" });
        } else {
          const it = await wooSingle(u);
          if (it?.name) return json({ kind: "product", item: it, url: it.url, platform: "woocommerce" });
        }
        return json({
          error: E("Bu site otomatik okumaya izin vermiyor. Kendi sitense ürünlerini XML beslemesi ya da Excel ile aktarabilirsin.",
            "This site blocks automatic reading. If it is your site, import via an XML feed or Excel."),
          blocked: true,
        }, 422);
      }
      if (msg.startsWith("http_4")) return json({ error: E("Site bu sayfayı vermedi (" + msg.slice(5) + "). Link doğru mu, giriş gerektiriyor mu?", "The site refused this page (" + msg.slice(5) + "). Is the link correct, does it need a login?"), httpStatus: Number(msg.slice(5)) || null }, 422);
      if (msg === "too_large") return json({ error: E("Dosya çok büyük (en fazla 40 MB).", "File is too large (max 40 MB).") }, 413);
      if (msg.includes("abort")) return json({ error: E("Site çok geç cevap verdi, tekrar dene.", "The site took too long, try again.") }, 504);
      return json({ error: E("Sayfaya ulaşılamadı.", "Could not reach the page.") }, 422);
    }

    const head = page.text.slice(0, 1000).trimStart();
    const looksXml = /xml/.test(page.type) && !/html/.test(page.type) || /^<\?xml/i.test(head) || /^<(rss|feed|urunler|products|catalog|root)[\s>]/i.test(head);
    if (looksXml && !/^<!doctype html|^<html/i.test(head)) {
      const items = parseFeed(page.text, page.finalUrl);
      if (!items.length) return json({ error: E("XML okundu ama içinde ürün bulunamadı.", "The XML was read but no products were found.") }, 422);
      return json({ kind: "feed", url: page.finalUrl.toString(), items, total: items.length });
    }
    if (page.text.length > MAX_HTML * 3) return json({ error: E("Sayfa çok büyük.", "The page is too large.") }, 413);

    const html = page.text;
    const fu = page.finalUrl;
    const isRoot = fu.pathname.replace(/\/+$/, "") === "";
    const sniff = html.slice(0, 400000);
    const isShopify = /cdn\.shopify\.com|Shopify\.shop\s*=|shopify-digital-wallet/i.test(sniff);
    const isWoo = /wp-content\/plugins\/woocommerce|woocommerce-page|wc-block-/i.test(sniff);
    // Türk e-ticaret altyapıları: herkese açık ürün API'leri yok; site haritası + sayfadaki JSON-LD / OpenGraph okunur
    const trPlatform = /cdn\.myikas\.com|myikas\.com|ikas-storefront|"ikas"/i.test(sniff) ? "ikas"
      : /ticimax|ticimaxcdn|static\.ticimax/i.test(sniff) ? "ticimax"
      : /ideasoft|ideacdn/i.test(sniff) ? "ideasoft" : /tsoft|t-soft/i.test(sniff) ? "tsoft" : "";

    if (isShopify) {
      if (/\/products\/[^/]+/.test(fu.pathname)) {
        const it = await shopifySingle(fu);
        if (it?.name) return json({ kind: "product", item: it, url: it.url, platform: "shopify" });
      } else if (isRoot || /\/collections(\/[^/]+)?\/?$/.test(fu.pathname)) {
        const r = await shopifyList(fu);
        if (r.items.length) return json({ kind: "feed", url: fu.toString(), items: r.items, total: r.items.length, next_page: r.next, platform: "shopify" });
      }
    }
    if (isWoo) {
      if (isRoot || /\/(shop|magaza|urunler|products)\/?$/i.test(fu.pathname)) {
        const r = await wooList(fu);
        if (r.items.length) return json({ kind: "feed", url: fu.toString(), items: r.items, total: r.items.length, next_page: r.next, platform: "woocommerce" });
      } else if (/\/(product|urun)\//i.test(fu.pathname) || /<body[^>]+class=["'][^"']*single-product/i.test(sniff)) {
        const it = await wooSingle(fu);
        if (it?.name) return json({ kind: "product", item: it, url: it.url, platform: "woocommerce" });
      }
    }
    if (/(^|\.)trendyol\.com$/.test(fu.hostname)) {
      const it = trendyolFromHtml(html, fu);
      if (it?.name) return json({ kind: "product", item: it, url: it.url, platform: "trendyol" });
    }
    if (trPlatform === "ticimax" && !isRoot) {
      const it = ticimaxFromHtml(html, fu);
      if (it?.name) return json({ kind: "product", item: it, url: it.url, platform: "ticimax" });
    }
    // Site ana sayfası: site haritasından tüm ürün linkleri
    if (isRoot) {
      const links = await sitemapProductLinks(fu);
      if (links.length >= 3) return json({ kind: "category", links: links.slice(0, 2000), next_page: "", url: fu.toString(), platform: trPlatform || "sitemap" });
    }

    const res = await parseHtml(html, fu);
    if (res.kind === "product" && (res as any).item) {
      (res as any).item.variants = jsonLdVariants(html, fu);
      (res as any).item.source_platform = trPlatform || "web";
      if (trPlatform && !(res as any).item.images?.length) (res as any).item.images = nextDataImages(html, fu);
    }
    if (res.kind === "product" && !(res as any).item?.name) {
      return json({ error: E("Bu sayfada ürün bilgisi bulunamadı.", "No product information found on this page.") }, 422);
    }
    return json({ ...res, url: page.finalUrl.toString(), platform: trPlatform || (res as any).platform || undefined });
  } catch (err) {
    console.error(err);
    return json({ error: E("Sunucu hatası", "Server error") }, 500);
  }
});