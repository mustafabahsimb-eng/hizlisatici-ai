// =========================================================
// Amazon ilan metni: her pazarın kendi dilinde başlık, 5 madde, açıklama, arama terimleri (AI) + Amazon kurallarına uyum
// Kurallar (Amazon başlık / madde / arama terimi kılavuzları):
// - Başlık: en fazla 200 karakter (pazar tablosundaki sınır), ! $ ? _ { } ^ ¬ ¦ yok, aynı kelime en fazla 2 kez,
//   tanıtım ifadesi yok ("ücretsiz kargo", "en çok satan", "indirim" ...), emoji / HTML yok.
// - Maddeler: en fazla 5, her biri en fazla 500 karakter; tanıtım, iletişim bilgisi, kanıtsız sağlık / çevre iddiası yok.
// - Açıklama: en fazla 2000 karakter, düz metin, adres / e-posta / telefon / bağlantı yok.
// - Arama terimleri: en fazla 249 BAYT (karakter değil; Türkçe / Almanca harfler 2 bayt), virgül yok, tekrar yok,
//   başlıktaki kelimeler ve marka adı tekrar yazılmaz, ASIN yok.
// Uyulmayan her şey otomatik düzeltilir; düzeltme notu satıcıya gösterilir (fixed: true).
// =========================================================
import type { AmazonMarket } from "./amazon.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
export const AI_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-sonnet-4-6"]; // hız için önce Haiku

export const LIMITS = { title: 200, bullet: 500, bullets: 5, description: 2000, keywordBytes: 249 };
export type TextIssue = { code: string; field: string; msg: string; fixed: boolean };
export type AmazonContent = { title: string; bullets: string[]; description: string; keywords: string };

const TITLE_BAD = /[!$?_{}^¬¦]/g;
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;
const HTML = /<[^>]+>/g;
const URLS = /\b(?:https?:\/\/|www\.)\S+/gi;
const EMAILS = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const PHONES = /(?:\+?\d[\d ()-]{8,}\d)/g;
const ASIN = /\bB0[A-Z0-9]{8}\b/gi;

// Tanıtım ifadeleri (Amazon yasaklar) — pazar dillerinde
const PROMO: Record<string, string[]> = {
  en: ["free shipping", "free delivery", "best seller", "bestseller", "best-selling", "top rated", "top seller", "#1", "no. 1", "number one", "on sale", "sale", "discount", "cheap", "cheapest", "limited time", "hot deal", "hot item", "great deal", "best price", "lowest price", "100% satisfaction", "satisfaction guaranteed", "money back", "buy now", "new arrival"],
  tr: ["ücretsiz kargo", "bedava kargo", "kargo bedava", "en çok satan", "çok satan", "en iyi fiyat", "en ucuz", "ucuz", "indirim", "indirimli", "kampanya", "kampanyalı", "fırsat", "kaçırma", "hemen al", "stoklarla sınırlı", "yeni sezon", "%100 memnuniyet"],
  de: ["kostenloser versand", "versandkostenfrei", "gratis versand", "bestseller", "meistverkauft", "rabatt", "sonderangebot", "angebot", "günstig", "billig", "jetzt kaufen", "nur heute", "zufriedenheitsgarantie", "geld-zurück"],
  fr: ["livraison gratuite", "meilleure vente", "meilleur prix", "promo", "promotion", "soldes", "pas cher", "réduction", "offre spéciale", "achetez maintenant", "satisfait ou remboursé"],
  es: ["envío gratis", "envío gratuito", "más vendido", "mejor precio", "oferta", "descuento", "barato", "rebaja", "compra ahora", "garantía de satisfacción"],
  it: ["spedizione gratuita", "spedizione gratis", "più venduto", "miglior prezzo", "offerta", "sconto", "economico", "saldi", "compra ora", "soddisfatti o rimborsati"],
  nl: ["gratis verzending", "bestseller", "beste prijs", "korting", "aanbieding", "goedkoop", "uitverkoop", "nu kopen"],
  pl: ["darmowa dostawa", "darmowa wysyłka", "bestseller", "najlepsza cena", "promocja", "rabat", "tani", "wyprzedaż", "kup teraz"],
  sv: ["fri frakt", "gratis frakt", "bästsäljare", "bästa pris", "rea", "rabatt", "billig", "köp nu"],
  pt: ["frete grátis", "mais vendido", "melhor preço", "promoção", "desconto", "barato", "oferta", "compre agora"],
  ja: ["送料無料", "ベストセラー", "最安値", "激安", "セール", "割引", "今すぐ購入"],
  ar: ["شحن مجاني", "الأكثر مبيعا", "خصم", "عرض"],
};
// Kanıt (sertifika / ruhsat) isteyen iddialar: Amazon ilanı kaldırır (pestisit, sağlık, çevre iddiaları)
const CLAIMS: Record<string, string[]> = {
  en: ["antibacterial", "anti-bacterial", "antimicrobial", "antiviral", "anti-viral", "antifungal", "kills germs", "kills bacteria", "kills viruses", "fda approved", "fda-approved", "cures disease", "treats disease", "heals wounds", "prevents disease", "covid", "coronavirus", "eco-friendly", "eco friendly", "environmentally friendly", "non-toxic", "biodegradable", "compostable"],
  tr: ["antibakteriyel", "anti bakteriyel", "antimikrobiyal", "antiviral", "mikrop öldürür", "bakteri öldürür", "virüs öldürür", "tedavi eder", "iyileştirir", "hastalığı önler", "covid", "korona", "çevre dostu", "doğa dostu", "zehirsiz", "toksik değildir", "biyobozunur"],
  de: ["antibakteriell", "antimikrobiell", "antiviral", "tötet keime", "tötet bakterien", "heilt", "covid", "umweltfreundlich", "ungiftig", "biologisch abbaubar"],
  fr: ["antibactérien", "antimicrobien", "antiviral", "tue les germes", "guérit", "covid", "écologique", "non toxique", "biodégradable"],
  es: ["antibacteriano", "antimicrobiano", "antiviral", "mata gérmenes", "covid", "ecológico", "no tóxico", "biodegradable"],
  it: ["antibatterico", "antimicrobico", "antivirale", "uccide i germi", "guarisce", "covid", "ecologico", "atossico", "biodegradabile"],
  nl: ["antibacterieel", "antiviraal", "doodt bacteriën", "geneest", "covid", "milieuvriendelijk", "niet giftig", "biologisch afbreekbaar"],
  pl: ["antybakteryjny", "przeciwwirusowy", "zabija bakterie", "leczy", "covid", "ekologiczny", "nietoksyczny", "biodegradowalny"],
  sv: ["antibakteriell", "antiviral", "dödar bakterier", "botar", "covid", "miljövänlig", "giftfri", "biologiskt nedbrytbar"],
  pt: ["antibacteriano", "antimicrobiano", "antiviral", "mata germes", "covid", "ecológico", "atóxico", "biodegradável"],
  ja: ["抗菌", "抗ウイルス", "除菌", "治る", "コロナ", "エコ"],
  ar: ["مضاد للبكتيريا", "يقتل الجراثيم", "صديق للبيئة"],
};
// Başlıkta tekrar sayılmayan kısa bağlaçlar
const SMALL = new Set(["ve", "ile", "için", "veya", "and", "for", "with", "the", "of", "in", "a", "an", "or", "und", "für", "mit", "der", "die", "das", "et", "pour", "avec", "le", "la", "les", "de", "y", "con", "para", "el", "e", "per", "il", "en", "och", "med", "för", "i", "z", "do", "w", "na", "dla", "voor", "met", "het", "-", "&", "/", "|", ","]);

export const langOf = (m: AmazonMarket) => m.locale.split("_")[0];
const bytes = (s: string) => new TextEncoder().encode(s).length;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tidy = (s: string) => s.replace(/\s+([,.;:])/g, "$1").replace(/\s{2,}/g, " ").replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, "").trim();
export function cutWords(s: string, max: number): string {
  if (s.length <= max) return s;
  const c = s.slice(0, max + 1);
  const i = c.lastIndexOf(" ");
  return tidy((i > max * 0.6 ? c.slice(0, i) : c.slice(0, max)));
}

// Bir dildeki yasak ifadeleri çıkar (İngilizce her pazarda da kontrol edilir: satıcılar İngilizce kalıp kullanıyor)
function stripPhrases(s: string, lang: string, field: string, issues: TextIssue[], code: "promo" | "claim") {
  const lists = code === "promo" ? PROMO : CLAIMS;
  const words = [...new Set([...(lists[lang] || []), ...(lang === "en" ? [] : lists.en)])].sort((a, b) => b.length - a.length);
  // Küçük harfe karakter karakter çevrilmiş eş uzunlukta kopyada aranır (Türkçe "İ" / "I" doğru eşleşsin), asıl metinden kesilir
  const low = (x: string) => x.split("").map((ch) => { const l = ch.toLocaleLowerCase(lang); return l.length === 1 ? l : l[0]; }).join("");
  let out = s;
  for (const w0 of words) {
    const w = low(w0.trim());
    const re = /^[\p{L}\p{N}]/u.test(w) ? new RegExp(`(^|[^\p{L}\p{N}])(${esc(w)})(?=$|[^\p{L}\p{N}])`, "gu") : new RegExp(`()(${esc(w)})`, "gu");
    const lower = low(out);
    const cuts: [number, number][] = [];
    for (const m of lower.matchAll(re)) { const at = m.index! + m[1].length; cuts.push([at, at + m[2].length]); }
    if (!cuts.length) continue;
    for (const [a, b] of cuts.reverse()) out = out.slice(0, a) + " " + out.slice(b);
    issues.push({ code, field, fixed: true, msg: code === "promo" ? `Amazon tanıtım ifadesine izin vermiyor, çıkarıldı: "${w0.trim()}"` : `Kanıt isteyen iddia çıkarıldı (Amazon ilanı kaldırır): "${w0.trim()}"` });
  }
  return tidy(out);
}
function clean(s: string) {
  return String(s ?? "").replace(HTML, " ").replace(EMOJI, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

export function fixTitle(raw: string, lang: string, max = LIMITS.title, issues: TextIssue[] = []): string {
  let t = clean(raw);
  if (TITLE_BAD.test(t)) { t = t.replace(TITLE_BAD, " "); issues.push({ code: "title_chars", field: "title", fixed: true, msg: "Başlıktaki ! $ ? _ { } ^ ¬ ¦ işaretleri çıkarıldı (Amazon kuralı)." }); }
  t = stripPhrases(t, lang, "title", issues, "promo");
  t = stripPhrases(t, lang, "title", issues, "claim");
  // Aynı kelime en fazla 2 kez
  const seen = new Map<string, number>();
  const parts = t.split(/\s+/);
  const kept: string[] = [];
  let dropped = false;
  for (const w of parts) {
    const k = w.toLocaleLowerCase(lang).replace(/[^\p{L}\p{N}]/gu, "");
    if (!k || SMALL.has(k)) { kept.push(w); continue; }
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    if (n > 2) { dropped = true; continue; }
    kept.push(w);
  }
  if (dropped) issues.push({ code: "title_repeat", field: "title", fixed: true, msg: "Başlıkta 2'den fazla tekrar eden kelime çıkarıldı (Amazon kuralı)." });
  t = tidy(kept.join(" "));
  // Tamamı büyük harf kelimeler (5+ harf; LED / USB / XL gibi kısaltmalar korunur) -> İlk harfi büyük
  let caps = false;
  t = t.split(" ").map((w) => {
    const letters = w.replace(/[^\p{L}]/gu, "");
    if (letters.length >= 5 && letters === letters.toLocaleUpperCase(lang) && letters !== letters.toLocaleLowerCase(lang)) {
      caps = true;
      const lw = w.toLocaleLowerCase(lang);
      return lw.replace(/\p{L}/u, (ch) => ch.toLocaleUpperCase(lang));
    }
    return w;
  }).join(" ");
  if (caps) issues.push({ code: "title_caps", field: "title", fixed: true, msg: "Tamamı büyük harfle yazılmış kelimeler düzeltildi (Amazon kuralı)." });
  if (t.length > max) { t = cutWords(t, max); issues.push({ code: "title_length", field: "title", fixed: true, msg: `Başlık ${max} karaktere kısaltıldı.` }); }
  return t;
}

function noContact(s: string, field: string, issues: TextIssue[]) {
  const before = s;
  s = s.replace(URLS, "").replace(EMAILS, "").replace(PHONES, (m) => (m.replace(/\D/g, "").length >= 10 ? "" : m)).replace(ASIN, "");
  if (s !== before) issues.push({ code: "contact", field, fixed: true, msg: "Bağlantı / e-posta / telefon / ASIN çıkarıldı (Amazon ilanında iletişim bilgisi yasak)." });
  return tidy(s);
}

export function fixBullets(raw: string[], lang: string, issues: TextIssue[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const b0 of raw || []) {
    let b = clean(b0).replace(/^[•\-*–·✓✔]+\s*/, "");
    b = stripPhrases(b, lang, "bullet_point", issues, "promo");
    b = stripPhrases(b, lang, "bullet_point", issues, "claim");
    b = noContact(b, "bullet_point", issues);
    if (b.length > LIMITS.bullet) { b = cutWords(b, LIMITS.bullet); issues.push({ code: "bullet_length", field: "bullet_point", fixed: true, msg: `Madde ${LIMITS.bullet} karaktere kısaltıldı.` }); }
    const k = b.toLocaleLowerCase(lang);
    if (b.length < 3 || seen.has(k)) continue;
    seen.add(k);
    out.push(b);
  }
  if (out.length > LIMITS.bullets) { issues.push({ code: "bullet_count", field: "bullet_point", fixed: true, msg: "Amazon en fazla 5 madde kabul eder; fazlası çıkarıldı." }); out.length = LIMITS.bullets; }
  if (out.length < LIMITS.bullets) issues.push({ code: "bullet_few", field: "bullet_point", fixed: false, msg: `${out.length} madde var; Amazon 5 madde önerir.` });
  return out;
}

export function fixDescription(raw: string, lang: string, issues: TextIssue[] = []): string {
  let d = String(raw ?? "").replace(/<\/(p|li|div|h\d)>|<br\s*\/?>/gi, "\n").replace(HTML, " ").replace(EMOJI, "").replace(/&nbsp;/g, " ");
  d = d.split("\n").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
  d = d.split("\n").map((x) => noContact(stripPhrases(stripPhrases(x, lang, "product_description", issues, "promo"), lang, "product_description", issues, "claim"), "product_description", issues)).filter(Boolean).join("\n");
  if (d.length > LIMITS.description) { d = cutWords(d, LIMITS.description); issues.push({ code: "description_length", field: "product_description", fixed: true, msg: "Açıklama 2000 karaktere kısaltıldı." }); }
  return d;
}

export function fixKeywords(raw: string, lang: string, title: string, brand: string | null, issues: TextIssue[] = []): string {
  const lower = (s: string) => s.toLocaleLowerCase(lang);
  const titleWords = new Set(lower(title).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const brandWords = new Set(lower(brand || "").split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const promo = new Set([...(PROMO[lang] || []), ...PROMO.en].filter((w) => !w.includes(" ")).map(lower));
  let removed = false;
  const words: string[] = [];
  const seen = new Set<string>();
  for (const w0 of lower(clean(raw).replace(ASIN, " ")).split(/[\s,;|/]+/)) {
    const w = w0.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!w) continue;
    if (titleWords.has(w) || brandWords.has(w) || promo.has(w) || seen.has(w)) { removed = true; continue; }
    seen.add(w);
    words.push(w);
  }
  if (removed) issues.push({ code: "keywords_redundant", field: "generic_keyword", fixed: true, msg: "Arama terimlerinden başlıkta zaten olan / marka / tekrar / tanıtım kelimeleri çıkarıldı (yer açmak için)." });
  let out = "";
  for (const w of words) {
    const next = out ? out + " " + w : w;
    if (bytes(next) > LIMITS.keywordBytes) { issues.push({ code: "keywords_length", field: "generic_keyword", fixed: true, msg: "Arama terimleri 249 bayta kısaltıldı (Amazon sınırı; fazlası dizine alınmaz)." }); break; }
    out = next;
  }
  return out;
}

export function checkContent(c: AmazonContent, market: AmazonMarket, brand: string | null, maxTitle = LIMITS.title): { content: AmazonContent; issues: TextIssue[] } {
  const lang = langOf(market);
  const issues: TextIssue[] = [];
  const title = fixTitle(c.title, lang, maxTitle, issues);
  const content = {
    title,
    bullets: fixBullets(c.bullets, lang, issues),
    description: fixDescription(c.description, lang, issues),
    keywords: fixKeywords(c.keywords, lang, title, brand, issues),
  };
  if (!title) issues.push({ code: "title_missing", field: "title", fixed: false, msg: "Başlık boş." });
  return { content, issues };
}

// ---------- AI çağrısı (ortak): aynı anda en fazla 4 istek, yoğunlukta (429 / 529 / 5xx) bekleyip yeniden dener ----------
// Neden: bir ürün 5 Amazon pazarına aynı anda gidince ~15 AI isteği birden çıkar; sınır aşılırsa AI boş döner ve Amazon zorunlu alan eksik der.
const AI_MAX_PARALLEL = 4;
let aiActive = 0;
const aiWaiters: (() => void)[] = [];
async function aiSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (aiActive >= AI_MAX_PARALLEL) await new Promise<void>((r) => aiWaiters.push(r));
  aiActive++;
  try { return await fn(); } finally { aiActive--; aiWaiters.shift()?.(); }
}
// Metin cevabı (null: AI yok / hepsi başarısız)
export async function aiText(req: { system?: string; content: unknown; maxTokens?: number; timeoutMs?: number }): Promise<string | null> {
  if (!ANTHROPIC_API_KEY) return null;
  return await aiSlot(async () => {
    for (const model of AI_MODELS) {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const r = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model, max_tokens: req.maxTokens || 3000, ...(req.system ? { system: req.system } : {}), messages: [{ role: "user", content: req.content }] }),
            signal: AbortSignal.timeout(req.timeoutMs || 60000),
          });
          if (r.status === 429 || r.status === 529 || r.status >= 500) {
            await r.body?.cancel();
            const ra = Number(r.headers.get("retry-after")) || 0;
            await new Promise((res) => setTimeout(res, Math.min(8000, ra ? ra * 1000 : 1200 * 2 ** attempt) + Math.random() * 400));
            continue;
          }
          const d = await r.json();
          if (!r.ok) break; // bu model kullanılamıyor: sıradaki model
          return (d?.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
        } catch (_) { /* zaman aşımı / ağ: yeniden dene */ }
      }
    }
    return null;
  });
}

// ---------- AI (metin + isteğe bağlı görsel) -> JSON ----------
export async function aiJson(system: string, user: string, opts: { imageUrl?: string | null; maxTokens?: number } = {}): Promise<any | null> {
  const content: unknown[] = [];
  if (opts.imageUrl && /^https:\/\//.test(opts.imageUrl)) content.push({ type: "image", source: { type: "url", url: opts.imageUrl } });
  content.push({ type: "text", text: user });
  const text = await aiText({ system, content, maxTokens: opts.maxTokens || 3000 });
  const m = text?.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch (_) { return null; }
}

const LANG_NAMES: Record<string, string> = { tr: "Turkish", en: "English", de: "German", fr: "French", it: "Italian", es: "Spanish", nl: "Dutch", sv: "Swedish", pl: "Polish", pt: "Portuguese", ja: "Japanese", ar: "Arabic" };

// Pazarın dilinde Amazon metni. AI yoksa ilan / ürün metni kurallardan geçirilerek kullanılır.
export async function localizedContent(product: any, listing: any, market: AmazonMarket, maxTitle = LIMITS.title): Promise<{ content: AmazonContent; issues: TextIssue[]; ai: boolean }> {
  const lang = langOf(market);
  const src = {
    title: listing.title || product?.generated_title || product?.name || "", description: String(listing.description || product?.generated_description || "").replace(HTML, " ").slice(0, 3000),
    bullets: Array.isArray(listing.bullet_points) ? listing.bullet_points : [], keywords: Array.isArray(listing.keywords) ? listing.keywords.join(" ") : String(listing.keywords || ""),
    brand: product?.brand || null, model: product?.model_code || null, specs: product?.specs || null, color: product?.color || null, material: product?.material || null,
  };
  const system = `You write Amazon product detail page content for marketplace ${market.domain} in ${LANG_NAMES[lang] || lang} (locale ${market.locale}). Output ONLY JSON {"title":"","bullets":["","","","",""],"description":"","keywords":""}.
Rules: title = Brand + product type + key features (material, size, color, quantity), max ${Math.min(maxTitle, 200)} characters, sentence case, no ! $ ? _ { } ^ ¬ ¦, no word more than twice, no promotional words (sale, free shipping, best seller, cheap, #1), no subjective claims.
bullets = exactly 5 benefit-led bullet points, each 150-250 characters, start with a short capitalised feature phrase, facts only from the input, no promotion, no contact info, no health / antibacterial / eco claims.
description = 2-4 short plain-text paragraphs, max 1800 characters, no HTML, no contact info.
keywords = backend search terms: synonyms, alternative names, uses, spelling variants NOT already in the title, no brand names, no commas, lowercase, space separated, max 240 bytes.
Translate naturally (not word by word). Never invent specifications that are not in the input; if a fact is unknown leave it out.`;
  const r = await aiJson(system, JSON.stringify(src), { maxTokens: 2500 });
  const draft: AmazonContent = r && typeof r.title === "string"
    ? { title: r.title, bullets: Array.isArray(r.bullets) ? r.bullets.map(String) : [], description: String(r.description || ""), keywords: String(r.keywords || "") }
    : { title: src.title, bullets: src.bullets.length ? src.bullets : specBullets(product, src.description), description: src.description, keywords: src.keywords };
  const { content, issues } = checkContent(draft, market, src.brand, maxTitle);
  return { content, issues, ai: !!(r && typeof r.title === "string") };
}

// AI yoksa: ürün özelliklerinden madde ("Malzeme: Seramik"), yetmezse açıklamanın cümlelerinden
function specBullets(product: any, description = ""): string[] {
  const s = product?.specs;
  let out: string[] = [];
  if (Array.isArray(s)) out = s.map((x: any) => (x?.k && x?.v ? `${x.k}: ${x.v}` : "")).filter(Boolean);
  else if (s && typeof s === "object") out = Object.entries(s).map(([k, v]) => `${k}: ${v}`);
  if (out.length < 5) {
    const sent = String(description || "").replace(/<[^>]+>/g, " ").split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter((x) => x.length >= 20);
    out = [...out, ...sent];
  }
  return out.slice(0, 5);
}
