// =========================================================
// HızlıSatıcı AI - product-import (Toplu Ürün Yükleme)
// Bir linki okur ve ürün bilgilerini çıkarır:
//   - XML beslemesi (bayi XML'i, Google Shopping vb.)  -> { kind: "feed", items: [...] }
//   - Kategori / liste sayfası                          -> { kind: "category", links: [...], next_page }
//   - Tek ürün sayfası                                  -> { kind: "product", item: {...} }
// Sadece giriş yapmış kullanıcılar kullanabilir.
// POST { url, language }
// =========================================================
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MAX_HTML = 3_000_000;   // 3 MB
const MAX_XML = 40_000_000;   // 40 MB
const MAX_FEED_ITEMS = 5000;

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
async function download(u: URL): Promise<{ text: string; type: string; finalUrl: URL }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(u.toString(), {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
      },
    });
    const finalUrl = isSafeUrl(r.url || u.toString());
    if (!finalUrl) throw new Error("blocked_redirect");
    if (!r.ok) throw new Error("http_" + r.status);
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
    return { text, type, finalUrl };
  } finally {
    clearTimeout(timer);
  }
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
    item.images = im.map((x: any) => absUrl(typeof x === "string" ? x : x?.url || x?.contentUrl || "", base)).filter(Boolean);
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

// ---------------- Ana ----------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!(await hsIsLoggedIn(req))) return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);

  const body = await req.json().catch(() => ({}));
  const en = String(body?.language || "").toLowerCase().startsWith("en");
  const E = (tr: string, eng: string) => (en ? eng : tr);

  try {
    const u = isSafeUrl(String(body?.url || "").trim());
    if (!u) return json({ error: E("Geçerli bir web adresi (http/https) yaz.", "Enter a valid web address (http/https).") }, 400);

    let page;
    try {
      page = await download(u);
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      if (msg.startsWith("http_4")) return json({ error: E("Site bu sayfayı vermedi (" + msg.slice(5) + "). Link doğru mu, giriş gerektiriyor mu?", "The site refused this page (" + msg.slice(5) + "). Is the link correct, does it need a login?") }, 422);
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

    const res = await parseHtml(page.text, page.finalUrl);
    if (res.kind === "product" && !(res as any).item?.name) {
      return json({ error: E("Bu sayfada ürün bilgisi bulunamadı.", "No product information found on this page.") }, 422);
    }
    return json({ ...res, url: page.finalUrl.toString() });
  } catch (err) {
    console.error(err);
    return json({ error: E("Sunucu hatası", "Server error") }, 500);
  }
});