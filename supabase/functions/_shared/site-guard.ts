// =========================================================
// Seltigo - site okuma güvenliği ve yardımcıları (site-connect, store-domain)
//  - SSRF koruması: yalnız http(s), 80/443, alan adının TÜM IP'leri herkese açık olmalı (iç ağ / özel / yerel IP yok),
//    yönlendirmeler tek tek yeniden denetlenir (en fazla 5)
//  - robots.txt: SeltigoBot ve * grupları, Allow/Disallow en uzun eşleşme, * ve $ jokerleri, Crawl-delay (en fazla 10 sn)
//  - hız sınırı: aynı siteye istekler arasında en az 700 ms (ya da Crawl-delay)
//  - altyapı tespiti (Shopify, WooCommerce, Wix, ikas, Ticimax, IdeaSoft, T-Soft, OpenCart, PrestaShop, Magento ...)
//  - ürün akışı keşfi (Google Merchant / XML / RSS / CSV)
//  - sahiplik doğrulaması: meta etiketi, DNS TXT, doğrulama dosyası
// =========================================================
export const BOT_UA = "Mozilla/5.0 (compatible; SeltigoBot/1.0; +https://mustafabahsimb-eng.github.io/hizlisatici-ai/seltigobot.html)";
export const VERIFY_META = "seltigo-site-verification";
export const VERIFY_FILE = "seltigo-verification.txt";
export const VERIFY_TXT_PREFIX = "seltigo-verification=";

export type SiteRef = { url: string; origin: string; host: string; scopePath: string };

// Paylaşımlı barındırma: alt yol farklı kişilere ait olabilir; doğrulama kapsamı alt yola daralır
const SHARED_HOSTS = /\.(github\.io|gitlab\.io|netlify\.app|vercel\.app|pages\.dev|web\.app|firebaseapp\.com|blogspot\.com|wordpress\.com|wixsite\.com)$/i;

export function normalizeSite(raw: string): SiteRef | null {
  let s = String(raw || "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".") || u.username || u.password) return null;
    if (u.port && !["80", "443"].includes(u.port)) return null;
    if (isIpLiteral(u.hostname) || /^(localhost|.*\.local|.*\.internal|.*\.lan|.*\.home)$/i.test(u.hostname)) return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    // Kapsam: paylaşımlı alanlarda verilen adresin klasörü (ör. kullanici.github.io/magaza/), diğerlerinde sitenin tamamı
    let scopePath = "/";
    if (SHARED_HOSTS.test(u.hostname)) scopePath = u.pathname.replace(/[^/]*$/, "") || "/";
    u.hash = "";
    return { url: u.href, origin: u.origin, host, scopePath };
  } catch { return null; }
}

function isIpLiteral(h: string) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":") || /^\[.*\]$/.test(h); }

export function isPrivateIp(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (s.includes(":")) {
    if (s === "::" || s === "::1") return true;
    if (/^(fc|fd)/.test(s) || /^fe[89ab]/.test(s)) return true;           // ULA, link-local
    const m = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);                  // IPv4 eşlemeli
    if (m) return isPrivateIp(m[1]);
    if (/^(64:ff9b|2001:db8|100::)/.test(s)) return true;
    return false;
  }
  const p = s.split(".").map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

// DNS (önce sistem çözücü, olmazsa DNS-over-HTTPS)
export async function dohQuery(name: string, type: string): Promise<string[]> {
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(8000),
    });
    const d = await r.json();
    const want = ({ A: 1, AAAA: 28, CNAME: 5, TXT: 16, NS: 2 } as Record<string, number>)[type];
    return (d?.Answer || []).filter((x: any) => x.type === want).map((x: any) => String(x.data).replace(/^"|"$/g, "").replace(/"\s*"/g, ""));
  } catch { return []; }
}
async function resolveIps(host: string): Promise<string[]> {
  const out: string[] = [];
  for (const t of ["A", "AAAA"] as const) {
    try {
      // deno-lint-ignore no-explicit-any
      const r = await (Deno as any).resolveDns(host, t);
      out.push(...r.map(String));
    } catch {
      out.push(...(await dohQuery(host, t)).filter((x) => /^[\d.]+$|:/.test(x)));
    }
  }
  return out;
}
const hostOk = new Map<string, number>();
export async function assertPublicHost(host: string) {
  const h = host.toLowerCase();
  if (isIpLiteral(h)) { if (isPrivateIp(h)) throw new Error("Bu adrese erişilemez (iç ağ)"); return; }
  const t = hostOk.get(h);
  if (t && Date.now() - t < 5 * 60_000) return;
  const ips = await resolveIps(h);
  if (!ips.length) throw new Error("Alan adı bulunamadı");
  if (ips.some(isPrivateIp)) throw new Error("Bu adrese erişilemez (iç ağ / özel IP)");
  hostOk.set(h, Date.now());
}

// Aynı siteye istek aralığı
const lastHit = new Map<string, number>();
const hostDelay = new Map<string, number>();
async function pace(host: string) {
  const gap = hostDelay.get(host) ?? 700;
  const last = lastHit.get(host) ?? 0;
  const wait = last + gap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
}

export type SafeResponse = { status: number; url: string; headers: Headers; text: string };
export async function safeFetch(raw: string, opt: { accept?: string; maxBytes?: number; timeout?: number; method?: string; headers?: Record<string, string>; body?: string; noPace?: boolean } = {}): Promise<SafeResponse> {
  let url = new URL(raw);
  for (let hop = 0; hop < 6; hop++) {
    if (!/^https?:$/.test(url.protocol) || (url.port && !["80", "443"].includes(url.port))) throw new Error("Desteklenmeyen adres");
    await assertPublicHost(url.hostname);
    if (!opt.noPace) await pace(url.hostname);
    const r = await fetch(url.href, {
      method: opt.method || "GET", redirect: "manual", body: opt.body,
      headers: { "User-Agent": BOT_UA, Accept: opt.accept || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.6", ...(opt.headers || {}) },
      signal: AbortSignal.timeout(opt.timeout || 20000),
    });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      await r.body?.cancel();
      url = new URL(r.headers.get("location")!, url);
      continue;
    }
    const max = opt.maxBytes || 4_000_000;
    const reader = r.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) { await reader.cancel(); break; }
        chunks.push(value);
      }
    }
    const buf = new Uint8Array(Math.min(size, max));
    let o = 0;
    for (const c of chunks) { buf.set(c.subarray(0, Math.max(0, buf.length - o)), o); o += c.length; if (o >= buf.length) break; }
    return { status: r.status, url: url.href, headers: r.headers, text: new TextDecoder().decode(buf) };
  }
  throw new Error("Çok fazla yönlendirme");
}

// ---------- robots.txt ----------
type Rule = { allow: boolean; path: string };
const robotsCache = new Map<string, { rules: Rule[]; delay: number; sitemaps: string[]; at: number }>();
export function parseRobots(txt: string, agent = "seltigobot") {
  const groups: { agents: string[]; rules: Rule[]; delay: number }[] = [];
  const sitemaps: string[] = [];
  let cur: { agents: string[]; rules: Rule[]; delay: number } | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
    if (k === "sitemap") { if (v) sitemaps.push(v); continue; }
    if (k === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], delay: 0 }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (k === "allow" || k === "disallow") { if (v || k === "allow") cur.rules.push({ allow: k === "allow", path: v }); }
    else if (k === "crawl-delay") cur.delay = Math.min(10, Math.max(0, Number(v) || 0));
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && agent.includes(a)));
  const pick = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  return { rules: pick.flatMap((g) => g.rules), delay: Math.max(0, ...pick.map((g) => g.delay)), sitemaps };
}
function ruleMatch(path: string, pattern: string): boolean {
  if (!pattern) return false;
  const esc = pattern.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const re = esc.endsWith("$") ? new RegExp("^" + esc) : new RegExp("^" + esc);
  return re.test(path);
}
export function robotsAllows(rules: Rule[], pathWithQuery: string): boolean {
  let best: Rule | null = null;
  for (const r of rules) {
    if (!r.path) continue;
    if (ruleMatch(pathWithQuery, r.path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}
export async function robotsFor(origin: string) {
  const c = robotsCache.get(origin);
  if (c && Date.now() - c.at < 30 * 60_000) return c;
  let parsed = { rules: [] as Rule[], delay: 0, sitemaps: [] as string[] };
  try {
    const r = await safeFetch(origin + "/robots.txt", { accept: "text/plain,*/*", maxBytes: 500_000, timeout: 10000 });
    if (r.status === 200) parsed = parseRobots(r.text);
    // 401/403: site botları istemiyor -> hiçbir şey okunmaz; 404 / 5xx: kısıt yok (Google kuralı)
    if (r.status === 401 || r.status === 403) parsed.rules = [{ allow: false, path: "/" }];
  } catch { /* robots okunamadı: kısıt yok */ }
  const host = new URL(origin).hostname;
  if (parsed.delay) hostDelay.set(host, Math.max(700, parsed.delay * 1000));
  const v = { ...parsed, at: Date.now() };
  robotsCache.set(origin, v);
  return v;
}
export async function allowedByRobots(url: string): Promise<boolean> {
  const u = new URL(url);
  const r = await robotsFor(u.origin);
  return robotsAllows(r.rules, u.pathname + u.search);
}

// ---------- Altyapı tespiti ----------
export type Platform = "shopify" | "woocommerce" | "wix" | "ikas" | "ticimax" | "ideasoft" | "tsoft" | "opencart" | "prestashop" | "magento" | "squarespace" | "bigcommerce" | "custom";
export function detectPlatform(html: string, headers?: Headers): { platform: Platform; evidence: string } {
  const h = (k: string) => headers?.get(k) || "";
  const gen = (html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i)?.[1] || "").toLowerCase();
  const t = html.slice(0, 600_000);
  const tests: [Platform, () => string | null][] = [
    ["shopify", () => h("x-shopid") ? "x-shopid başlığı" : /cdn\.shopify\.com|Shopify\.theme|shopify-digital-wallet/i.test(t) ? "cdn.shopify.com" : null],
    ["wix", () => h("x-wix-request-id") ? "x-wix-request-id başlığı" : /static\.wixstatic\.com|wix\.com website builder/i.test(t + gen) ? "wixstatic" : null],
    ["woocommerce", () => /woocommerce/i.test(gen) ? "generator: WooCommerce" : /wp-content\/plugins\/woocommerce|woocommerce-(page|cart)|wc-block/i.test(t) ? "woocommerce eklentisi" : null],
    ["ikas", () => /cdn\.myikas\.com|ikas-storefront|myikas\.com/i.test(t) ? "myikas" : null],
    ["ticimax", () => /ticimax/i.test(t) ? "ticimax" : null],
    ["ideasoft", () => /ideasoft|myideasoft|ideacdn/i.test(t + gen) ? "ideasoft" : null],
    ["tsoft", () => /t-soft|tsoftstatic|tsoft\.com\.tr/i.test(t + gen) ? "T-Soft" : null],
    ["opencart", () => /catalog\/view\/theme|route=product\/product|opencart/i.test(t + gen) ? "opencart" : null],
    ["prestashop", () => /prestashop/i.test(t + gen) ? "prestashop" : null],
    ["magento", () => /mage\/cookies|Magento_|magento/i.test(t + gen) ? "magento" : null],
    ["squarespace", () => /static1\.squarespace\.com/i.test(t) ? "squarespace" : null],
    ["bigcommerce", () => /cdn\d*\.bigcommerce\.com/i.test(t) ? "bigcommerce" : null],
  ];
  for (const [p, f] of tests) { const e = f(); if (e) return { platform: p, evidence: e }; }
  return { platform: "custom", evidence: gen || "bilinen altyapı izi yok" };
}

// Bilinen altyapıda en iyi okuma yolu (satıcıya gösterilir)
export const PLATFORM_INFO: Record<string, { name: string; api: "store_connection" | "public" | "feed"; note: string }> = {
  shopify: { name: "Shopify", api: "store_connection", note: "Shopify uygulamasıyla bağlanırsan stok ve taslak ürünler de gelir; bağlamadan herkese açık ürün listesi okunur." },
  woocommerce: { name: "WooCommerce", api: "store_connection", note: "WooCommerce REST anahtarıyla bağlanırsan stok miktarı da gelir; bağlamadan Store API okunur." },
  wix: { name: "Wix", api: "store_connection", note: "Wix uygulamasıyla bağlanırsan Wix Stores API'den okunur; bağlamadan site haritası taranır." },
  ikas: { name: "ikas", api: "feed", note: "ikas panelindeki Google ürün akışı (feed) adresini girersen fiyat + stok akıştan okunur; girmezsen site taranır." },
  ticimax: { name: "Ticimax", api: "feed", note: "Ticimax panelindeki XML ürün çıktısı adresini girersen fiyat + stok XML'den okunur; girmezsen site taranır." },
  ideasoft: { name: "IdeaSoft", api: "feed", note: "IdeaSoft panelindeki XML / Google ürün akışı adresini girersen oradan okunur; girmezsen site taranır." },
  tsoft: { name: "T-Soft", api: "feed", note: "T-Soft panelindeki XML ürün servisi adresini girersen oradan okunur; girmezsen site taranır." },
  opencart: { name: "OpenCart", api: "public", note: "Site haritası ve ürün sayfalarındaki yapısal veri okunur." },
  prestashop: { name: "PrestaShop", api: "public", note: "Site haritası ve ürün sayfalarındaki yapısal veri okunur." },
  magento: { name: "Magento", api: "public", note: "Site haritası ve ürün sayfalarındaki yapısal veri okunur." },
  squarespace: { name: "Squarespace", api: "public", note: "Site haritası ve ürün sayfaları okunur." },
  bigcommerce: { name: "BigCommerce", api: "public", note: "Site haritası ve ürün sayfaları okunur." },
  custom: { name: "Kendi yapımı site", api: "public", note: "Ürün akışı (XML / CSV) varsa o, yoksa site haritası → ürün sayfaları (schema.org, OpenGraph, mikroveri; gerekirse yapay zekâ) okunur." },
};

// Ürün akışı adayları (sayfadaki <link rel=alternate>, bilinen yollar)
export function feedCandidates(html: string, origin: string, platform: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link[^>]+rel=["']alternate["'][^>]*>/gi)) {
    const tag = m[0];
    const type = tag.match(/type=["']([^"']+)/i)?.[1] || "";
    const href = tag.match(/href=["']([^"']+)/i)?.[1];
    if (href && /xml|rss|atom|csv/i.test(type) && !/comments|wp-json|oembed/i.test(href)) out.push(new URL(href, origin).href);
  }
  const common = ["/google-merchant.xml", "/googlemerchant.xml", "/merchant.xml", "/products.xml", "/product-feed.xml", "/feed/products.xml", "/urunler.xml", "/xml/urunler.xml"];
  if (platform === "woocommerce") common.push("/wp-content/uploads/woo-feed/google/xml/feed.xml", "/?feed=products");
  if (platform === "ticimax") common.push("/XMLExport/GoogleMerchant.xml");
  return [...new Set([...out, ...common.map((p) => origin + p)])];
}
export function looksLikeProductFeed(text: string): boolean {
  const t = text.slice(0, 200_000);
  if (/<(rss|feed|products|urunler|catalog)[\s>]/i.test(t) && /<(item|entry|product|urun)[\s>]/i.test(t) && /(g:price|<price|<fiyat|g:id|<stok|<stock)/i.test(t)) return true;
  const first = t.split(/\r?\n/)[0] || "";
  return /(^|[,;\t])"?(id|sku|title|name|ad|urun_adi)"?([,;\t])/i.test(first) && /(price|fiyat)/i.test(first);
}

// ---------- Sahiplik doğrulaması ----------
export type VerifyResult = { ok: boolean; method?: "meta" | "dns" | "file"; detail: string };
export async function verifyOwnership(ref: SiteRef, token: string, only?: "meta" | "dns" | "file"): Promise<VerifyResult> {
  const notes: string[] = [];
  const base = ref.origin + ref.scopePath;
  if (!only || only === "meta") {
    try {
      const r = await safeFetch(base, { maxBytes: 1_500_000, noPace: true });
      const metas = [...r.text.matchAll(new RegExp(`<meta[^>]+${VERIFY_META}[^>]*>`, "gi"))].map((m) => m[0]);
      if (metas.some((m) => m.match(/content=["']([^"']+)/i)?.[1]?.trim() === token)) return { ok: true, method: "meta", detail: "Meta etiketi bulundu" };
      notes.push(metas.length ? "meta etiketi var ama kod farklı" : "meta etiketi bulunamadı");
    } catch (e) { notes.push("ana sayfa açılamadı: " + (e as Error).message); }
  }
  if (!only || only === "dns") {
    if (ref.scopePath !== "/") notes.push("paylaşımlı alan adında DNS doğrulaması kullanılamaz");
    else {
      const names = [`_seltigo.${ref.host}`, ref.host];
      for (const n of names) {
        const txt = await dohQuery(n, "TXT");
        if (txt.some((x) => x.trim() === VERIFY_TXT_PREFIX + token || (n.startsWith("_seltigo.") && x.trim() === token))) return { ok: true, method: "dns", detail: `DNS TXT kaydı bulundu (${n})` };
      }
      notes.push("DNS TXT kaydı bulunamadı (yeni eklendiyse yayılması birkaç dakika sürebilir)");
    }
  }
  if (!only || only === "file") {
    try {
      const r = await safeFetch(base + VERIFY_FILE, { accept: "text/plain,*/*", maxBytes: 10_000, noPace: true });
      if (r.status === 200 && r.text.includes(token)) return { ok: true, method: "file", detail: "Doğrulama dosyası bulundu" };
      notes.push(`doğrulama dosyası ${r.status === 200 ? "kodu içermiyor" : "bulunamadı (" + r.status + ")"}`);
    } catch (e) { notes.push("doğrulama dosyası açılamadı: " + (e as Error).message); }
  }
  return { ok: false, detail: notes.join("; ") };
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function hmacHex(secret: string, body: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body));
  return [...new Uint8Array(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function randomToken(bytes = 24): string {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
