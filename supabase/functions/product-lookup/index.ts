// =========================================================
// HızlıSatıcı AI - product-lookup (Toplu Ürün Yükleme: eksikleri üretici sitesinden tamamla)
// Sadece model koduyla gelen ürünlerin resim / teknik özellik / açıklamasını üreticinin sitesinde bulur.
// Sadece giriş yapmış kullanıcılar kullanabilir.
//
// POST { action: "site", brand, samples: [{code,name}], hint, language }
//   -> { site: "cenova.com.tr" }            (üreticinin sitesini bulur)
// POST { action: "find", site, brand, code, name, searchTpl, skipSiteSearch, language }
//   (searchTpl: bu fonksiyonun önceki cevabında verdiği bilgi, tarayıcı olduğu gibi geri gönderir)
//   -> { found: true, url, item, searchTpl } | { found: false, searchTpl }
// =========================================================
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const MAX_HTML = 3_000_000;

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
    const r = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { Authorization: "Bearer " + token, apikey: SUPABASE_ANON_KEY },
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
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return null; // IP adresi kabul etme, alan adı olmalı
  if (h.startsWith("[") || h.includes(":")) return null;
  if (h.endsWith("supabase.co") || h.endsWith("supabase.in")) return null;
  return u;
}
// "https://www.cenova.com.tr/urunler" / "cenova.com.tr" -> "cenova.com.tr"
function normSite(s: unknown): string {
  let v = String(s || "").trim().toLowerCase();
  if (!v) return "";
  if (!/^https?:\/\//.test(v)) v = "https://" + v;
  const u = isSafeUrl(v);
  if (!u) return "";
  const h = u.hostname.replace(/^www\./, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) ? h : "";
}

// ---------------- Metin yardımcıları ----------------
function decodeEntities(s: string): string {
  return String(s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}
function stripTags(s: string): string {
  return decodeEntities(String(s || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").trim();
}
function normCode(c: unknown): string {
  return String(c || "").toUpperCase()
    .replace(/İ/g, "I").replace(/Ş/g, "S").replace(/Ğ/g, "G").replace(/Ü/g, "U").replace(/Ö/g, "O").replace(/Ç/g, "C")
    .replace(/[^A-Z0-9]/g, "");
}
function absUrl(href: string, base: URL): string | null {
  try {
    const u = new URL(decodeEntities(href.trim()), base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch { return null; }
}
function sameSite(u: string, site: string): boolean {
  try { const h = new URL(u).hostname.toLowerCase().replace(/^www\./, ""); return h === site || h.endsWith("." + site); } catch { return false; }
}

// ---------------- Sayfayı indir ----------------
async function download(raw: string, ms = 12000): Promise<{ text: string; finalUrl: string } | null> {
  const u = isSafeUrl(raw);
  if (!u) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(u.toString(), {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
      },
    });
    if (!isSafeUrl(r.url || u.toString())) return null;
    if (!r.ok) { await r.body?.cancel(); return null; }
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length > MAX_HTML) return null;
    const type = (r.headers.get("content-type") || "").toLowerCase();
    let charset = (type.match(/charset=([\w-]+)/) || [])[1] || "utf-8";
    let text: string;
    try { text = new TextDecoder(charset).decode(buf); } catch { text = new TextDecoder("utf-8").decode(buf); }
    const declared = (text.slice(0, 3000).match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
    if (declared && declared.toLowerCase() !== charset.toLowerCase()) {
      try { text = new TextDecoder(declared.toLowerCase()).decode(buf); charset = declared; } catch { /* kalsın */ }
    }
    return { text, finalUrl: r.url || u.toString() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------- Yapay zekâ ----------------
function extractJson(text: string): any {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
// webSearch=true: Claude internette arar (allowedDomains verilirse sadece o sitede)
async function askAI(system: string, user: string, webSearch: boolean, allowedDomains?: string[]): Promise<any> {
  if (!ANTHROPIC_API_KEY) return null;
  const models = webSearch ? ["claude-sonnet-5", "claude-haiku-4-5"] : ["claude-haiku-4-5", "claude-sonnet-5"];
  for (const model of models) {
    try {
      const body: any = { model, max_tokens: 1500, system, messages: [{ role: "user", content: user }] };
      if (webSearch) {
        const tool: any = { type: "web_search_20250305", name: "web_search", max_uses: 3 };
        if (allowedDomains && allowedDomains.length) tool.allowed_domains = allowedDomains;
        body.tools = [tool];
      }
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { console.error(model, d?.error?.message); continue; }
      const text = (d?.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      const parsed = extractJson(text);
      if (parsed) return parsed;
    } catch (e) { console.error(model, e); }
  }
  return null;
}

// ---------------- 1) Üreticinin sitesini bul ----------------
async function siteReachable(site: string): Promise<boolean> {
  const p = await download("https://" + site + "/", 10000) || await download("https://www." + site + "/", 10000);
  return !!(p && p.text.length > 500);
}

async function findSite(brand: string, samples: { code: string; name: string }[], hint: string): Promise<string> {
  const list = samples.slice(0, 8).map((s) => `${s.code || "-"} | ${s.name || ""}`).join("\n");
  const system = `You identify the OFFICIAL website of a product manufacturer / brand (not a reseller, marketplace or price comparison site).
Answer ONLY with JSON: {"site":"example.com","confidence":"high|low"}. site = bare domain without https:// or www. Empty string if unknown.
Prefer the brand's own Turkish site (.com.tr) when the products are sold in Turkey and such a site exists.`;
  const user = `Brand (may be empty): ${brand || "-"}\nPrice list file / hint: ${hint || "-"}\nSample products (code | name):\n${list}`;

  // a) Önce bilgiden (ucuz), sonra siteye gerçekten ulaşılıyor mu diye kontrol et
  if (brand) {
    const a = await askAI(system, user, false);
    const s = normSite(a?.site);
    if (s && a?.confidence !== "low" && await siteReachable(s)) return s;
  }
  // b) İnternette ara
  const b = await askAI(system + "\nUse web search to confirm. If no brand is given, search the sample product codes to find which manufacturer makes them.", user, true);
  const s2 = normSite(b?.site);
  if (s2 && await siteReachable(s2)) return s2;
  return "";
}

// ---------------- 2) Sitede model kodunu ara ----------------
// Ana sayfadaki arama formundan arama adresi şablonu çıkar: "https://site/arama?q={q}"
function searchTplFromHome(html: string, base: URL): string {
  const forms = html.match(/<form[^>]*>[\s\S]*?<\/form>/gi) || [];
  for (const f of forms) {
    const open = (f.match(/<form[^>]*>/i) || [""])[0];
    if (/method=["']?post/i.test(open)) continue;
    const inputs = f.match(/<input[^>]*>/gi) || [];
    let name = "";
    for (const i of inputs) {
      const n = (i.match(/name=["']([^"']+)["']/i) || [])[1] || "";
      const type = ((i.match(/type=["']([^"']+)["']/i) || [])[1] || "text").toLowerCase();
      if (!n || ["hidden", "submit", "checkbox", "radio", "button", "password", "email"].includes(type)) continue;
      if (type === "search" || /^(q|s|k|search|query|keyword|keywords|ara|aranan|kelime|term|text|searchtext|search_query|filter_name)$/i.test(n)) { name = n; break; }
    }
    if (!name) continue;
    const action = (open.match(/action=["']([^"']*)["']/i) || [])[1] || base.pathname;
    const a = absUrl(action || "/", base);
    if (!a) continue;
    const u = new URL(a);
    // formdaki gizli alanları da ekle (ör. post_type=product)
    for (const i of inputs) {
      const type = ((i.match(/type=["']([^"']+)["']/i) || [])[1] || "").toLowerCase();
      const n = (i.match(/name=["']([^"']+)["']/i) || [])[1] || "";
      const v = (i.match(/value=["']([^"']*)["']/i) || [])[1] || "";
      if (type === "hidden" && n && n.length < 40 && v.length < 60 && !/token|csrf|nonce/i.test(n)) u.searchParams.set(n, v);
    }
    u.searchParams.set(name, "__Q__");
    return u.toString().replace("__Q__", "{q}");
  }
  return "";
}
const COMMON_TPLS = [
  "/arama?q={q}", "/search?q={q}", "/?s={q}&post_type=product", "/ara?q={q}", "/arama?k={q}",
  "/urunler?q={q}", "/index.php?route=product/search&search={q}", "/search?type=product&q={q}",
];

// Arama sonucu sayfasında model koduyla eşleşen ürün linkini bul
function pickProductLink(html: string, pageUrl: string, site: string, code: string): string {
  const base = new URL(pageUrl);
  const nc = normCode(code);
  if (nc.length < 3) return "";
  const re = /<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  let best = "", bestScore = 0;
  while ((m = re.exec(html))) {
    const href = absUrl(m[1], base);
    if (!href || !sameSite(href, site)) continue;
    if (/[?&](q|s|k|search|query|keyword|filter_name)=|\/(arama|search|ara|sepet|cart|login|giris|uye|account|hesap)(\/|\?|$)/i.test(href)) continue;
    const text = stripTags(m[2]);
    let path = "";
    try { path = decodeURIComponent(new URL(href).pathname); } catch { path = href; }
    const inHref = normCode(path).includes(nc);
    const inText = normCode(text).includes(nc);
    const score = (inHref ? 2 : 0) + (inText ? 1 : 0);
    if (score > bestScore) { bestScore = score; best = href; }
  }
  return best;
}

// Sayfa gerçekten bu model kodunun ürün sayfası mı?
function pageHasCode(html: string, code: string): boolean {
  const nc = normCode(code);
  return nc.length >= 3 && normCode(stripTags(html).slice(0, 200000)).includes(nc);
}

async function searchOnSite(site: string, code: string, tpl: string): Promise<{ url: string; tpl: string }> {
  const origin = "https://" + site;
  const tryTpl = async (t: string): Promise<string> => {
    const url = t.replace("{q}", encodeURIComponent(code));
    const page = await download(url, 10000);
    if (!page) return "";
    // Arama doğrudan ürün sayfasına yönlendirdiyse
    if (page.finalUrl !== url && sameSite(page.finalUrl, site) && !/[?&](q|s|k|search)=/i.test(page.finalUrl) && pageHasCode(page.text, code)) return page.finalUrl;
    return pickProductLink(page.text, page.finalUrl, site, code);
  };

  // 1) Daha önce işe yarayan şablon (bu sitede arama böyle çalışıyor; bulamadıysa ürün sitede yok demektir)
  if (tpl && sameSite(tpl.replace("{q}", "x"), site)) {
    const hit = await tryTpl(tpl);
    return { url: hit, tpl };
  }
  const started = Date.now();
  // 2) Ana sayfadaki arama formu
  const home = await download(origin + "/", 10000) || await download("https://www." + site + "/", 10000);
  const tried = new Set<string>(tpl ? [tpl] : []);
  if (home) {
    const t = searchTplFromHome(home.text, new URL(home.finalUrl));
    if (t && !tried.has(t) && sameSite(t.replace("{q}", "x"), site)) {
      tried.add(t);
      const hit = await tryTpl(t);
      if (hit) return { url: hit, tpl: t };
    }
  }
  // 3) Yaygın arama adresleri
  const root = home ? new URL(home.finalUrl).origin : origin;
  for (const c of COMMON_TPLS) {
    const t = root + c;
    if (tried.has(t)) continue;
    if (Date.now() - started > 45000) break; // süre sınırı
    tried.add(t);
    const hit = await tryTpl(t);
    if (hit) return { url: hit, tpl: t };
  }
  return { url: "", tpl: "" };
}

// ---------------- 2b) Ürün adresini tahmin et (ör. cenova.com.tr/dz-2628-dp) ----------------
function slugify(code: string): string {
  return String(code || "").toLowerCase()
    .replace(/ı/g, "i").replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ü/g, "u").replace(/ö/g, "o").replace(/ç/g, "c")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
const GUESS_PATTERNS = ["/{slug}", "/urun/{slug}", "/product/{slug}", "/urunler/{slug}", "/products/{slug}", "/{slug}.html"];
// Sayfanın başlığında / ana başlığında model kodu geçiyor mu? (boş "bulunamadı" sayfalarını elemek için)
function headHasCode(html: string, code: string): boolean {
  const nc = normCode(code);
  const parts = [
    (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "",
    ...(html.match(/<h1[^>]*>[\s\S]*?<\/h1>/gi) || []),
    (html.match(/<meta[^>]+property=["']og:title["'][^>]*>/i) || [])[0] || "",
  ];
  if (normCode(stripTags(parts.join(" "))).includes(nc)) return true;
  const ld = html.match(/"(?:sku|mpn|model)"\s*:\s*"([^"]+)"/i);
  return !!(ld && normCode(ld[1]) === nc);
}
async function tryGuess(site: string, code: string, pattern: string): Promise<string> {
  const slug = slugify(code);
  if (slug.length < 3) return "";
  const nc = normCode(code);
  for (const host of [site, "www." + site]) {
    const url = "https://" + host + pattern.replace("{slug}", slug);
    const page = await download(url, 9000);
    if (!page || !sameSite(page.finalUrl, site)) continue;
    let path = "";
    try { path = decodeURIComponent(new URL(page.finalUrl).pathname); } catch { continue; }
    if (!normCode(path).includes(nc)) continue;          // ana sayfaya / başka yere yönlendirdiyse
    if (headHasCode(page.text, code)) return page.finalUrl;
  }
  return "";
}
async function guessUrl(site: string, code: string, known: string): Promise<{ url: string; pattern: string }> {
  if (known) {
    // Bu sitenin adres kalıbı biliniyor; tutmadıysa bu ürün bu kalıpla bulunmuyor demektir
    const u = await tryGuess(site, code, known);
    return { url: u, pattern: known };
  }
  const started = Date.now();
  for (const p of GUESS_PATTERNS) {
    if (p === known) continue;
    if (Date.now() - started > 30000) break;
    const u = await tryGuess(site, code, p);
    if (u) return { url: u, pattern: p };
  }
  return { url: "", pattern: known };
}
// Tarayıcı bu bilgiyi olduğu gibi geri gönderir: "g=<adres kalıbı>\ns=<arama adresi>"
function parseTpl(v: string): { g: string; s: string } {
  const out = { g: "", s: "" };
  const str = String(v || "");
  if (!str.startsWith("g=") && !str.startsWith("s=")) { out.s = str; return out; } // eski biçim
  for (const line of str.split("\n")) {
    if (line.startsWith("g=")) out.g = GUESS_PATTERNS.includes(line.slice(2)) ? line.slice(2) : "";
    else if (line.startsWith("s=")) out.s = line.slice(2);
  }
  return out;
}
function buildTpl(g: string, s: string): string {
  return (g ? "g=" + g : "") + (g && s ? "\n" : "") + (s ? "s=" + s : "");
}

async function searchWithAI(site: string, brand: string, code: string, name: string): Promise<string> {
  const system = `You find the product detail page of a specific product on the web. Use web search.
Answer ONLY with JSON: {"url":"https://..."} — the exact product page URL for this model code. Empty string if not found. Never guess a URL you did not see in search results.`;
  const user = `Model code: ${code}\nProduct name: ${name || "-"}\nBrand: ${brand || "-"}\n` + (site ? `Search only on: ${site}` : `Prefer the manufacturer's official site.`);
  const a = await askAI(system, user, true, site ? [site, "www." + site] : undefined);
  const u = String(a?.url || "");
  if (!isSafeUrl(u)) return "";
  if (site && !sameSite(u, site)) return "";
  return u;
}

// Bulunan sayfayı mevcut product-import fonksiyonuyla oku (aynı okuma mantığı)
async function readProduct(url: string, auth: string, language: string): Promise<any> {
  const r = await fetch(SUPABASE_URL + "/functions/v1/product-import", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth, apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ url, language }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d?.kind !== "product" || !d?.item) return null;
  return d.item;
}
function itemHasCode(item: any, url: string, code: string): boolean {
  const nc = normCode(code);
  if (nc.length < 3) return false;
  const hay = normCode([
    url, item?.name, item?.model_code, item?.description,
    ...(Array.isArray(item?.specs) ? item.specs.map((s: any) => s?.k + " " + s?.v) : []),
  ].join(" "));
  return hay.includes(nc);
}

// ---------------- Ana ----------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!(await hsIsLoggedIn(req))) return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);

  const body = await req.json().catch(() => ({}));
  const language = String(body?.language || "tr");
  const en = language.toLowerCase().startsWith("en");
  const E = (tr: string, eng: string) => (en ? eng : tr);

  try {
    const action = String(body?.action || "");
    const brand = String(body?.brand || "").slice(0, 80);

    if (action === "site") {
      const samples = (Array.isArray(body?.samples) ? body.samples : []).slice(0, 8)
        .map((s: any) => ({ code: String(s?.code || "").slice(0, 60), name: String(s?.name || "").slice(0, 120) }));
      if (!samples.length && !brand) return json({ error: E("Ürün örneği gerekli.", "Sample products are required.") }, 400);
      const site = await findSite(brand, samples, String(body?.hint || "").slice(0, 120));
      return json({ site });
    }

    if (action === "find") {
      const code = String(body?.code || "").trim().slice(0, 80);
      const name = String(body?.name || "").slice(0, 200);
      const site = normSite(body?.site);
      if (normCode(code).length < 3) return json({ found: false, reason: "no_code" });
      const auth = req.headers.get("Authorization") || "";

      const known = parseTpl(String(body?.searchTpl || ""));
      let g = known.g, sTpl = known.s;
      let url = "", item: any = null;

      // a) Ürün adresini tahmin et (ör. site.com/dz-2628-dp) — en hızlısı
      if (site) {
        const gu = await guessUrl(site, code, g);
        if (gu.url) {
          g = gu.pattern;
          // sayfa başlığında kod geçtiği zaten doğrulandı
          item = await readProduct(gu.url, auth, language);
          if (item) url = gu.url;
        }
      }
      // b) Sitenin kendi aramasında ara (ücretsiz)
      if (!item && site && !body?.skipSiteSearch) {
        const s = await searchOnSite(site, code, sTpl);
        if (s.tpl) sTpl = s.tpl;
        if (s.url) {
          item = await readProduct(s.url, auth, language);
          if (item && itemHasCode(item, s.url, code)) url = s.url; else item = null;
        }
      }
      const tpl = buildTpl(g, sTpl);
      // c) Bulunamazsa internette ara (sadece o sitede)
      if (!item) {
        const u2 = await searchWithAI(site, brand, code, name);
        if (u2 && u2 !== url) {
          const it2 = await readProduct(u2, auth, language);
          if (it2 && itemHasCode(it2, u2, code)) { item = it2; url = u2; }
        }
      }
      if (!item) return json({ found: false, searchTpl: tpl });
      return json({
        found: true, url, searchTpl: tpl,
        item: {
          name: item.name || "", brand: item.brand || "", model_code: item.model_code || "",
          description: item.description || "", category: item.category || "",
          images: Array.isArray(item.images) ? item.images.slice(0, 12) : [],
          specs: Array.isArray(item.specs) ? item.specs.slice(0, 80) : [],
        },
      });
    }

    return json({ error: E("Geçersiz işlem.", "Invalid action.") }, 400);
  } catch (err) {
    console.error(err);
    return json({ error: E("Sunucu hatası", "Server error") }, 500);
  }
});