// =========================================================
// Seltigo Asistan - çekirdek (tüm kanallar aynı çekirdeği kullanır)
// Gelen mesaj -> (bağlı hesap + yetki) -> komut / dosya / buton -> cevaplar.
// Ürün ekleme: product-import (link), price-list-parse (PDF / katalog görüntüsü), görsel tanıma (tek ürün fotoğrafı),
//              product-ingest (kâr kuralı + zarar kontrolü + Kendi Mağazam yayını + arka plan görsel tamamlama).
// HIZ KURALI: ilan önce açılır; ağır işler arkada. Kritik işlerde ikinci onay.
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { featureEnabled, FEATURE_OFF_MSG } from "./features.ts";
import { channelIdsFromDefaults, connectedChannels, distributeProducts } from "./distribute.ts";
import type { Button, Reply } from "./assistant-channels.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const STT_API_KEY = Deno.env.get("STT_API_KEY") ?? "";          // sesli mesaj -> yazı (ücretli servis; boşsa kapalı)
const STT_URL = Deno.env.get("STT_URL") ?? "https://api.openai.com/v1/audio/transcriptions";
const STT_MODEL = Deno.env.get("STT_MODEL") ?? "whisper-1";
const SITE = "https://mustafabahsimb-eng.github.io/hizlisatici-ai";

export const db = createClient(SUPABASE_URL, SERVICE_KEY);

export type Incoming = {
  channel: "telegram" | "whatsapp" | "instagram" | "messenger" | "test";
  externalId: string;
  name?: string;
  text?: string;
  callback?: string;
  file?: { kind: "document" | "image" | "audio"; mime?: string; filename?: string; bytes: () => Promise<Uint8Array> };
};

const CHANNEL_NAMES: Record<string, string> = {
  own_store: "Kendi Mağazam", trendyol: "Trendyol", hepsiburada: "Hepsiburada", n11: "n11", amazon: "Amazon", instagram: "Instagram", whatsapp: "WhatsApp kataloğu",
};
const money = (v: unknown, cur = "TRY") => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "–";
  try { return new Intl.NumberFormat("tr-TR", { style: "currency", currency: cur || "TRY" }).format(n); } catch { return n.toFixed(2) + " " + cur; }
};
const short = (v: unknown, n = 200) => String(v ?? "").slice(0, n);
const lower = (s: string) => s.toLocaleLowerCase("tr");
function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- Diğer fonksiyonlara sistem çağrısı ----------
async function fn(name: string, userId: string, payload: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
    body: JSON.stringify({ ...payload, cronSecret: CRON_SECRET, userId }), signal: AbortSignal.timeout(140000),
  });
  return await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
}
async function ai(system: string, content: unknown[], maxTokens = 1500): Promise<any> {
  for (const model of ["claude-sonnet-5-5", "claude-sonnet-4-6"]) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content }] }), signal: AbortSignal.timeout(90000),
      });
      const d = await r.json();
      if (!r.ok) continue;
      const text = (d?.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      const m = text.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
    } catch (_) { /* sonraki model */ }
  }
  return null;
}

// ---------- Oturum / ayarlar ----------
type Link = { id: string; user_id: string; channel: string; external_id: string; role: string; is_owner: boolean; last_inbound_at: string | null; display_name?: string | null };
async function settings(userId: string): Promise<any> {
  const { data } = await db.from("assistant_settings").select("*").eq("user_id", userId).maybeSingle();
  return data || { approval_mode: "direct", default_channels: ["own_store"], quiet_start: "22:00", quiet_end: "08:00", morning_report: true, weekly_summary: true };
}
async function getState(link: Link): Promise<any> {
  const { data } = await db.from("assistant_sessions").select("state").eq("link_id", link.id).maybeSingle();
  return data?.state || {};
}
async function setState(link: Link, state: any) {
  await db.from("assistant_sessions").upsert({ link_id: link.id, state, updated_at: new Date().toISOString() });
}
const can = (link: Link, what: "products" | "orders" | "owner") =>
  link.role === "full" || (what === "products" && link.role === "products") || (what === "orders" && link.role === "orders");
const NO_PERM: Reply = { text: "Bu işlem için yetkin yok. Mağaza sahibi Seltigo panelindeki 🤖 Asistan ayarlarından yetkini değiştirebilir." };

// ---------- Yardım ----------
const HELP: Reply = {
  text: "Merhaba, ben Seltigo Asistan 👋\n\n" +
    "• Toptancı PDF'ini / katalog fotoğrafını gönder → ürünleri listelerim, [Hepsini ekle] ya da \"1-15'i %50 kârla ekle\"\n" +
    "• Ürün fotoğrafı + \"350'ye sat, 20 tane\" → ilanı açarım\n" +
    "• Ürün linki gönder → ürünü eklerim\n" +
    "• \"bu ay ne kadar kâr ettim\", \"en çok ne satıyor\", \"hangi ürün zarar ediyor\"\n" +
    "• \"bugün gönderilecekler\" → liste + kargo etiketleri PDF\n" +
    "• \"reklamlar nasıl\", \"reklamı durdur\", \"reklam bütçesini 500 yap\"\n" +
    "• \"müşteri soruları\" → özet + önerilen cevap\n" +
    "• \"sadece Trendyol'a\" gibi kanal da söyleyebilirsin.",
};

// ---------- Metin ayrıştırma (hızlı, ücretsiz; anlaşılmazsa yapay zekâ) ----------
type Cmd = { all?: boolean; range?: [number, number]; picks?: number[]; margin?: number; price?: number; stock?: number; channels?: string[]; intent?: string; url?: string };
export function parseCommand(textIn: string): Cmd {
  const t = lower(textIn || "").replace(/\s+/g, " ").trim();
  const c: Cmd = {};
  const url = textIn.match(/https?:\/\/\S+/);
  if (url) c.url = url[0].replace(/[),.;]+$/, "");
  if (/\b(hepsini|tümünü|tamamını|hepsi)\b/.test(t)) c.all = true;
  const rg = t.match(/(\d{1,4})\s*[-–]\s*(\d{1,4})/);
  if (rg) c.range = [Number(rg[1]), Number(rg[2])];
  const mg = t.match(/%\s*(\d{1,3})|(\d{1,3})\s*%|yüzde\s*(\d{1,3})/);
  if (mg) c.margin = Number(mg[1] || mg[2] || mg[3]);
  const pr = t.match(/(\d[\d.]*(?:,\d{1,2})?)\s*(?:'|’)?\s*(?:ye|ya|e|a)?\s*sat/) || t.match(/(?:fiyat[ıi]?|fiyatı)\s*(\d[\d.]*(?:,\d{1,2})?)/) || t.match(/(\d[\d.]*(?:,\d{1,2})?)\s*(?:tl|₺)/);
  if (pr) c.price = Number(pr[1].replace(/\./g, "").replace(",", "."));
  const st = t.match(/(\d{1,6})\s*(?:tane|adet)/);
  if (st) c.stock = Number(st[1]);
  const chans: string[] = [];
  if (/trendyol/.test(t)) chans.push("trendyol");
  if (/hepsiburada/.test(t)) chans.push("hepsiburada");
  if (/\bn11\b/.test(t)) chans.push("n11");
  if (/amazon/.test(t)) chans.push("amazon");
  if (/instagram/.test(t)) chans.push("instagram");
  if (/kendi mağaza|mağazam/.test(t)) chans.push("own_store");
  if (chans.length) c.channels = chans;
  if (/^\/?(start|yardım|help|merhaba|selam)\b/.test(t)) c.intent = "help";
  else if (/reklam/.test(t) && /(durdur|kapat|dur\b)/.test(t)) c.intent = "ads_pause";
  else if (/reklam/.test(t) && /bütçe/.test(t) && /(\d[\d.,]*)/.test(t)) { c.intent = "ads_budget"; c.price = Number((t.match(/(\d[\d.]*(?:,\d+)?)/) || [])[1]?.replace(/\./g, "").replace(",", ".")); }
  else if (/reklam/.test(t) && /(başlat|aç|yayınla|devam)/.test(t)) c.intent = "ads_resume";
  else if (/reklam/.test(t)) c.intent = "ads_status";
  else if (/(kâr|kar) ettim|kârım|karım|ne kadar kazandım/.test(t)) c.intent = "profit";
  else if (/en çok (ne )?sat/.test(t)) c.intent = "top";
  else if (/zarar (ediyor|eden)/.test(t)) c.intent = "losing";
  else if (/bugün gönderilecek|gönderilecekler|kargo etiket/.test(t)) c.intent = "shipments";
  else if (/müşteri sor/.test(t)) c.intent = "questions";
  else if (/^rapor|sabah raporu|günlük rapor/.test(t)) c.intent = "report";
  else if (/haftalık özet/.test(t)) c.intent = "weekly";
  else if (/^yayınla\b/.test(t)) c.intent = "publish";
  else if (/^(iptal|vazgeç)\b/.test(t)) c.intent = "cancel";
  else if (/\b(ekle)\b/.test(t) && (c.all || c.range)) c.intent = "add";
  return c;
}

// ---------- Ürün ekleme ----------
async function ingest(link: Link, items: any[], opts: { margin?: number; salePrice?: number; stock?: number; aeSource?: string; channels?: string[] }) {
  const st = await settings(link.user_id);
  const channels = opts.channels?.length ? opts.channels : (st.default_channels || ["own_store"]);
  const approve = st.approval_mode === "approve";
  const res = await fn("product-ingest", link.user_id, {
    items, via: "assistant-" + link.channel, publish: !approve && channels.includes("own_store"),
    margin: opts.margin, salePrice: opts.salePrice, stock: opts.stock, aeSource: opts.aeSource, consent: true, imageTerms: true,
    sourceUrl: items[0]?.url || "asistan",
  });
  if (res?.needAeSource) return { needAe: true } as any;
  if (!res?.ok) throw new Error(res?.error || "Ürün eklenemedi");
  const ids = (res.products || []).map((p: any) => Number(p.id));
  // Diğer kanallar (Varsayılan kanallar): onay modunda [Yayınla]'ya basılınca gönderilir
  const dist = approve ? { sent: {}, missing: [] as string[] } : await sendToChannels(link, ids, channels);
  return { products: res.products as any[], approve, notLive: dist.missing, sent: dist.sent, imageJobs: res.imageJobs };
}
// Ürünleri satıcının varsayılan kanallarına gönder (bağlı olanlara); bağlı olmayanlar "missing"
async function sendToChannels(link: Link, ids: number[], channels: string[]): Promise<{ sent: Record<string, any>; missing: string[] }> {
  const others = (channels || []).filter((c) => c !== "own_store");
  if (!ids.length || !others.length) return { sent: {}, missing: [] };
  if (!(await featureEnabled(link.user_id, "multi_channel"))) return { sent: {}, missing: others };
  try {
    const ch = await connectedChannels(db, link.user_id);
    const { ids: want, missing } = channelIdsFromDefaults(ch, others);
    const sent = want.length ? await distributeProducts(db, link.user_id, ids, want) : {};
    return { sent, missing };
  } catch (e) {
    console.error("sendToChannels", String(e));
    return { sent: {}, missing: others };
  }
}
function sentLines(sent: Record<string, any>): string {
  const parts = Object.entries(sent || {}).map(([k, v]: [string, any]) =>
    v?.listings != null ? `${k}: ${v.listings} ilan${v.test ? " (test)" : ""}` : v?.queued != null ? `${k}: ${v.queued} paylaşım sıraya alındı` : v?.synced != null ? `${k}: ✓` : v?.error ? `${k}: ${short(v.error, 80)}` : "").filter(Boolean);
  return parts.length ? `\n📤 Diğer kanallar: ${parts.join(" · ")}` : "";
}
function addedReply(r: any): Reply {
  const lines = r.products.slice(0, 15).map((p: any, i: number) => `${i + 1}. ${short(p.name, 60)} — ${money(p.sale_price, p.currency)}`);
  const more = r.products.length > 15 ? `\n… ve ${r.products.length - 15} ürün daha` : "";
  const notLive = (r.notLive?.length ? `\n\nℹ️ ${r.notLive.map((c: string) => CHANNEL_NAMES[c] || c).join(", ")} bağlı değil; Hesaplarım'dan bağlayınca oraya da gönderirim.` : "") + sentLines(r.sent);
  const img = r.imageJobs ? `\n🔎 Eksik görseller arka planda tamamlanıyor.` : "";
  if (r.approve) {
    return {
      text: `${r.products.length} ürün hazır (henüz yayında değil):\n${lines.join("\n")}${more}${notLive}${img}`,
      buttons: [{ id: "publish", title: "Yayınla" }, { id: "edit_prices", title: "Fiyatları düzenle" }],
    };
  }
  return {
    text: `✅ ${r.products.length} ürün Kendi Mağazam'da yayında:\n${lines.join("\n")}${more}${notLive}${img}`,
    link: r.products.length === 1 ? { title: "✏️ Ürünü düzenle", url: `${SITE}/urun-duzenle.html?id=${r.products[0].id}` } : { title: "Ürünlerim", url: `${SITE}/dashboard.html` },
  };
}
async function publishProducts(link: Link, ids: number[]) {
  for (const id of ids) {
    const { data: p } = await db.from("products").select("id, name, generated_description, sale_price, cost_currency").eq("id", id).eq("user_id", link.user_id).maybeSingle();
    if (!p) continue;
    let price = Number(p.sale_price) || 0;
    if (p.cost_currency && p.cost_currency !== "TRY") {
      const { data: k } = await db.rpc("fx_rate", { p_from: p.cost_currency, p_to: "TRY", p_date: null });
      if (k) price = Math.round(price * Number(k) * 100) / 100;
    }
    const { data: ex } = await db.from("listings").select("id").eq("product_id", id).eq("marketplace_code", "own_store").maybeSingle();
    if (ex) await db.from("listings").update({ status: "published", price, published_at: new Date().toISOString() }).eq("id", ex.id);
    else {
      const li = await db.from("listings").insert({
        user_id: link.user_id, product_id: id, source_product_id: id, marketplace_code: "own_store", language: "tr", currency: "TRY",
        title: p.name, description: p.generated_description || "", keywords: [], category_key: null, price, commission_pct: 0, vat_payer: "seller",
        price_mode: "manual", status: "published", published_at: new Date().toISOString(),
      }).select("id").single();
      const { data: dv } = await db.from("product_variants").select("id").eq("product_id", id).eq("is_default", true).maybeSingle();
      if (li.data && dv) await db.from("listing_variants").insert({ listing_id: li.data.id, variant_id: dv.id, user_id: link.user_id, price, status: "published" });
    }
    await db.from("products").update({ store_visible: true }).eq("id", id);
  }
}

// Dosyadan ürün listesi (PDF / katalog görüntüsü / tablo)
async function rowsFromFile(link: Link, file: Incoming["file"]): Promise<any[]> {
  const bytes = await file!.bytes();
  const mime = (file!.mime || "").toLowerCase();
  const name = (file!.filename || "").toLowerCase();
  if (mime.includes("pdf") || name.endsWith(".pdf")) {
    // Büyük PDF: 3'er sayfalık parçalar
    const { PDFDocument } = await import("npm:pdf-lib@1.17.1");
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const n = Math.min(src.getPageCount(), 60);
    const parts: Uint8Array[] = [];
    for (let i = 0; i < n; i += 3) {
      const doc = await PDFDocument.create();
      const pages = await doc.copyPages(src, [i, i + 1, i + 2].filter((k) => k < n));
      pages.forEach((p) => doc.addPage(p));
      parts.push(await doc.save());
    }
    const out = await Promise.all(parts.map((p) => fn("price-list-parse", link.user_id, { pdfBase64: "data:application/pdf;base64," + b64(p) })));
    return out.flatMap((d) => d?.rows || []);
  }
  if (mime.startsWith("image/") || /\.(jpe?g|png|webp)$/.test(name)) {
    const d = await fn("price-list-parse", link.user_id, { imageBase64: `data:${mime || "image/jpeg"};base64,` + b64(bytes) });
    return d?.rows || [];
  }
  // Tablo (CSV / metin): satırlar metin olarak okunur
  const text = new TextDecoder("utf-8").decode(bytes).slice(0, 120000);
  const d = await fn("price-list-parse", link.user_id, { text });
  return d?.rows || [];
}
function rowToItem(r: any) {
  if (r._item) return r._item; // linkten gelen tam ürün (görseller, seçenekler)
  return {
    name: r.name || r.code, price: r.price, list_price: r.list_price, currency: r.currency, model_code: r.code || "", brand: r.brand || "",
    images: [], specs: [], variants: [], description: "", url: "", source_platform: null,
  };
}
async function previewRows(link: Link, rows: any[], fromName: string): Promise<Reply> {
  const st = await getState(link);
  const { data: rule } = await db.from("import_rules").select("rules").eq("user_id", link.user_id).maybeSingle();
  const margin = Number(rule?.rules?.margin ?? 30);
  await setState(link, { ...st, pending: { rows: rows.slice(0, 500), from: fromName, at: Date.now() } });
  const lines = rows.slice(0, 20).map((r, i) => `${i + 1}. ${short(r.name || r.code, 50)}${r.code ? " (" + r.code + ")" : ""} — alış ${money(r.price, r.currency || "TRY")} → satış ${money((Number(r.price) || 0) * (1 + margin / 100), r.currency || "TRY")}`);
  return {
    text: `📄 ${fromName}: ${rows.length} ürün buldum (kâr kuralın: alışın üstüne %${margin}).\n${lines.join("\n")}${rows.length > 20 ? `\n… ve ${rows.length - 20} ürün daha` : ""}\n\nHepsini eklemek için [Hepsini ekle], seçerek eklemek için örn. "1-15 ekle" ya da "1-15'i %50 kârla ekle" yaz.`,
    buttons: [{ id: "add_all", title: "Hepsini ekle" }, { id: "add_pick", title: "Seçerek ekle" }],
  };
}

// Tek ürün fotoğrafı: görselden ürünü tanı
async function productFromPhoto(link: Link, bytes: Uint8Array, mime: string, cmd: Cmd) {
  const path = `${link.user_id}/assistant/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  await db.storage.from("product-images").upload(path, bytes, { contentType: mime || "image/jpeg", upsert: false });
  const url = db.storage.from("product-images").getPublicUrl(path).data.publicUrl;
  const info = await ai(
    "You identify a product from a seller's photo for an e-commerce listing in Turkish. Answer ONLY JSON: " +
    '{"name":"","brand":"","category":"","description":"","specs":[{"k":"","v":""}],"isCatalogPage":false}. ' +
    "name: clear Turkish product title (brand + type + key feature). description: 2-3 Turkish sentences from what is visible only. " +
    "Never invent materials, sizes or certifications. isCatalogPage=true if the image is a page listing many products with prices.",
    [{ type: "image", source: { type: "base64", media_type: mime || "image/jpeg", data: b64(bytes) } }, { type: "text", text: "Identify the product." }],
  );
  return { info, url };
}

// ---------- Sorular / raporlar ----------
function monthStart() { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); }
async function salesSince(userId: string, since: string) {
  const { data: so } = await db.from("store_orders").select("product_id, quantity, unit_price, currency, status, created_at").eq("user_id", userId).gte("created_at", since);
  const list = (so || []).filter((o: any) => o.status !== "cancelled");
  const ids = [...new Set(list.map((o: any) => o.product_id))];
  const { data: ps } = ids.length ? await db.from("products").select("id, name, generated_title, supplier_price, cost_currency").in("id", ids) : { data: [] };
  const pm = new Map((ps || []).map((p: any) => [p.id, p]));
  let revenue = 0, cost = 0;
  const byProduct = new Map<number, { name: string; qty: number; revenue: number }>();
  for (const o of list) {
    const q = Number(o.quantity) || 1;
    const r = (Number(o.unit_price) || 0) * q;
    revenue += r;
    const p: any = pm.get(o.product_id);
    let c = (Number(p?.supplier_price) || 0) * q;
    if (p?.cost_currency && p.cost_currency !== "TRY") { const { data: k } = await db.rpc("fx_rate", { p_from: p.cost_currency, p_to: "TRY", p_date: null }); c = c * (Number(k) || 1); }
    cost += c;
    const cur = byProduct.get(o.product_id) || { name: p?.generated_title || p?.name || "Ürün", qty: 0, revenue: 0 };
    cur.qty += q; cur.revenue += r;
    byProduct.set(o.product_id, cur);
  }
  return { count: list.length, revenue, cost, profit: revenue - cost, top: [...byProduct.values()].sort((a, b) => b.qty - a.qty) };
}
async function profitReply(link: Link): Promise<Reply> {
  const s = await salesSince(link.user_id, monthStart());
  return { text: `📊 Bu ay: ${s.count} sipariş, ciro ${money(s.revenue)}, ürün maliyeti ${money(s.cost)}, tahmini kâr ${money(s.profit)}.\n(Kargo ve pazaryeri komisyonları bağlı kanallar canlıya geçince hesaba katılır.)` };
}
async function topReply(link: Link): Promise<Reply> {
  const s = await salesSince(link.user_id, monthStart());
  if (!s.top.length) return { text: "Bu ay henüz satış yok." };
  return { text: "🏆 Bu ay en çok satanlar:\n" + s.top.slice(0, 5).map((t, i) => `${i + 1}. ${short(t.name, 60)} — ${t.qty} adet, ${money(t.revenue)}`).join("\n") };
}
async function losingReply(link: Link): Promise<Reply> {
  const { data: ps } = await db.from("products").select("id, name, generated_title, supplier_price, sale_price, cost_currency, commission_rate")
    .eq("user_id", link.user_id).is("deleted_at", null).gt("supplier_price", 0).limit(2000);
  const losing = (ps || []).filter((p: any) => Number(p.sale_price) > 0 && Number(p.sale_price) * (1 - (Number(p.commission_rate) || 0) / 100) < Number(p.supplier_price));
  if (!losing.length) return { text: "✅ Zarar ettiren ürün görmüyorum (satış fiyatı, alış ve komisyonun üstünde)." };
  return { text: "⚠️ Zarar ettiren ürünler:\n" + losing.slice(0, 10).map((p: any) => `• ${short(p.generated_title || p.name, 50)}: alış ${money(p.supplier_price, p.cost_currency)}, satış ${money(p.sale_price, p.cost_currency)}`).join("\n"),
    link: { title: "Ürünlerim", url: `${SITE}/dashboard.html` } };
}
export async function morningReport(userId: string): Promise<Reply> {
  const y = new Date(Date.now() - 24 * 3600_000).toISOString();
  const s = await salesSince(userId, y);
  const { count: toShip } = await db.from("store_orders").select("id", { count: "exact", head: true }).eq("user_id", userId).is("shipped_at", null).neq("status", "cancelled");
  const { count: low } = await db.from("products").select("id", { count: "exact", head: true }).eq("user_id", userId).in("stock_status", ["az", "tukendi"]).is("deleted_at", null);
  const { count: holds } = await db.from("orders").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", "onay_bekliyor");
  const ads = (await adsSummary(userId)).filter((c: any) => c.status === "active");
  const adSpend = ads.reduce((a: number, c: any) => a + Number(c.spend_7d || 0), 0), adRev = ads.reduce((a: number, c: any) => a + Number(c.revenue_7d || 0), 0);
  const adLine = ads.length ? `\n📣 Reklam (7 gün): harcama ${money(adSpend, ads[0].currency || "TRY")}, satış ${money(adRev, ads[0].currency || "TRY")}${adSpend > 0 ? ", ROAS " + (adRev / adSpend).toFixed(2) : ""}.` : "";
  return { text: `☀️ Sabah raporu\nDün: ${s.count} sipariş, ${money(s.revenue)} ciro, tahmini kâr ${money(s.profit)}.\nGönderilecek: ${toShip || 0} · Stoğu azalan/biten: ${low || 0} · Onay bekleyen sipariş: ${holds || 0}.` + adLine,
    buttons: toShip ? [{ id: "shipments", title: "Gönderilecekler" }] : undefined };
}
export async function weeklySummary(userId: string): Promise<Reply> {
  const s = await salesSince(userId, new Date(Date.now() - 7 * 24 * 3600_000).toISOString());
  return { text: `📅 Haftalık özet\n${s.count} sipariş, ${money(s.revenue)} ciro, tahmini kâr ${money(s.profit)}.` +
    (s.top.length ? "\nEn çok satanlar:\n" + s.top.slice(0, 3).map((t, i) => `${i + 1}. ${short(t.name, 50)} — ${t.qty} adet`).join("\n") : "") };
}
// Pazaryeri kodu -> okunur ad (ör. trendyol_tr -> Trendyol, amazon_de -> Amazon DE)
const MP_NAMES: Record<string, string> = { trendyol_tr: "Trendyol", hepsiburada_tr: "Hepsiburada", n11_tr: "n11", ciceksepeti_tr: "Çiçeksepeti", pazarama_tr: "Pazarama", trendruum_tr: "Trendruum", pttavm_tr: "PTT AVM",
  shopify: "Shopify", woocommerce: "WooCommerce", etsy: "Etsy", wix: "Wix", own_store: "Kendi Mağazam" };
export function mpName(code: string): string {
  const c = String(code || "");
  return MP_NAMES[c] || c.replace(/^(amazon|ebay|walmart)_(\w+)$/, (_: string, a: string, x: string) => a[0].toUpperCase() + a.slice(1) + " " + x.toUpperCase());
}
// Kaynak sitelerden gelen seçenek adları Türkçe (eski siparişlerde "Size: 31 · Color: blue" -> "Beden: 31 · Renk: blue")
const OPTION_TR: Record<string, string> = { size: "Beden", color: "Renk", colour: "Renk", material: "Malzeme", style: "Model", pattern: "Desen", capacity: "Kapasite", length: "Uzunluk", "ships from": "Gönderim yeri" };
export function trVariant(label: string): string {
  return String(label || "").split(/\s*·\s*/).map((part) => {
    const m = /^([^:]+):\s*(.*)$/.exec(part);
    return m ? `${OPTION_TR[m[1].trim().toLowerCase()] || m[1].trim()}: ${m[2]}` : part;
  }).join(" · ");
}

async function shipmentsReply(link: Link): Promise<Reply> {
  const { data: so } = await db.from("store_orders").select("id, product_id, quantity, customer_name, customer_city, variant_label, created_at")
    .eq("user_id", link.user_id).is("shipped_at", null).neq("status", "cancelled").order("created_at").limit(50);
  // Pazaryeri (ör. Amazon) siparişleri: satıcının kendi gönderdiği ürünler (AliExpress / CJ'yi tedarikçi gönderir)
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: mos } = await db.from("marketplace_orders").select("id, marketplace_code, product_id, quantity, buyer_name, buyer_address, status, created_at")
    .eq("user_id", link.user_id).neq("marketplace_code", "own_store").or(`status.eq.new,shipped_at.gte.${since}`).order("created_at").limit(50);
  const mpIds = (mos || []).map((m: any) => m.product_id).filter(Boolean);
  const { data: sup } = mpIds.length ? await db.from("products").select("id, supplier").in("id", mpIds) : { data: [] as any[] };
  const dropship = new Set((sup || []).filter((p: any) => ["aliexpress", "cj", "printify"].includes(p.supplier)).map((p: any) => p.id));
  const mp = (mos || []).filter((m: any) => !dropship.has(m.product_id));
  const rows = [
    ...(so || []).map((o: any) => ({ key: "s:" + o.id, product_id: o.product_id, qty: o.quantity, name: o.customer_name, city: o.customer_city, variant: o.variant_label, ch: "" })),
    ...mp.map((m: any) => ({ key: "m:" + m.id, product_id: m.product_id, qty: m.quantity, name: m.buyer_name, city: m.buyer_address?.city, variant: null,
      ch: mpName(m.marketplace_code) })),
  ];
  if (!rows.length) return { text: "📦 Bugün gönderilecek sipariş yok." };
  const ids = [...new Set(rows.map((o) => o.product_id).filter(Boolean))];
  const { data: ps } = await db.from("products").select("id, name, generated_title").in("id", ids);
  const pm = new Map((ps || []).map((p: any) => [p.id, p.generated_title || p.name]));
  const shs: any[] = [];
  if (so?.length) shs.push(...((await db.from("shipments").select("label_path").in("store_order_id", so.map((o: any) => o.id)).not("label_path", "is", null)).data || []));
  if (mp.length) shs.push(...((await db.from("shipments").select("label_path").in("marketplace_order_id", mp.map((m: any) => m.id)).not("label_path", "is", null)).data || []));
  const lines = rows.map((o, i) => `${i + 1}. ${o.ch ? "[" + o.ch + "] " : ""}${short(pm.get(o.product_id) || "—", 45)}${o.variant ? " (" + trVariant(o.variant) + ")" : ""} ×${o.qty || 1} — ${o.name || ""}, ${o.city || ""}`);
  let document: Reply["document"];
  if (shs.length) {
    const { PDFDocument } = await import("npm:pdf-lib@1.17.1");
    const merged = await PDFDocument.create();
    for (const s of shs) {
      const { data: f } = await db.storage.from("shipping-labels").download(s.label_path);
      if (!f) continue;
      const src = await PDFDocument.load(new Uint8Array(await f.arrayBuffer()));
      (await merged.copyPages(src, src.getPageIndices())).forEach((p) => merged.addPage(p));
    }
    if (merged.getPageCount()) document = { bytes: await merged.save(), filename: `kargo-etiketleri-${new Date().toISOString().slice(0, 10)}.pdf` };
  }
  return { text: `📦 Gönderilecekler (${rows.length}):\n${lines.join("\n")}` + (document ? `\n\n🏷️ ${shs.length} kargo etiketi ekte.` : "\n\nKargo hesabı bağlanınca etiketler otomatik hazırlanır."), document };
}
async function questionsReply(link: Link): Promise<Reply> {
  const { data: qs } = await db.from("support_questions").select("id, product_title, question, ai_answer, created_at")
    .eq("user_id", link.user_id).eq("status", "open").eq("needs_human", true).order("created_at").limit(10);
  if (!qs?.length) return { text: "💬 Cevap bekleyen müşteri sorusu yok." };
  const q = qs[0];
  return {
    text: `💬 Cevap bekleyen ${qs.length} soru var. İlki:\nÜrün: ${short(q.product_title, 60)}\nSoru: ${short(q.question, 400)}\n\nÖnerilen cevap:\n${short(q.ai_answer || "—", 600)}`,
    buttons: [{ id: `ans_send:${q.id}`, title: "Cevabı gönder" }, { id: `ans_edit:${q.id}`, title: "Cevabı düzenle" }],
  };
}

// ---------- Bildirim metinleri (kuyruktan) ----------
// ---------- Seltigo Ads ----------
async function adsSummary(userId: string) {
  const { data: cs } = await db.from("ad_campaigns").select("id, name, status, daily_budget, currency, spend_7d, revenue_7d, roas_7d").eq("user_id", userId).in("status", ["active", "paused", "pending_approval"]).order("created_at", { ascending: false }).limit(10);
  return cs || [];
}
const ADS_ST: Record<string, string> = { active: "yayında", paused: "durdu", pending_approval: "onay bekliyor" };
async function adsAlert(p: any): Promise<Reply> {
  const { data: c } = await db.from("ad_campaigns").select("id, status, daily_budget, currency, product_ids, paused_reason").eq("id", p.campaign_id).maybeSingle();
  if (!c) return { text: "📣 Reklam bildirimi", link: { title: "Reklamları gör", url: `${SITE}/ads.html` } };
  const b = money(c.daily_budget, c.currency || "TRY");
  if (p.event === "pending_approval" && c.status === "pending_approval")
    return { text: `📣 Yeni reklam hazır: ${(c.product_ids || []).length} kârlı ürün, günlük ${b}. Yayına alayım mı?`, buttons: [{ id: `ads_ok:${c.id}`, title: "Onayla" }, { id: `ads_stop:${c.id}`, title: "Durdur" }] };
  if (p.event === "active") return { text: `📣 Reklam yayında: ${(c.product_ids || []).length} ürün, günlük ${b}.`, buttons: [{ id: `ads_stop:${c.id}`, title: "Durdur" }] };
  if (p.event === "scaled") return { text: `📈 Reklam iyi gidiyor; ${short(p.reason, 160)}.`, buttons: [{ id: `ads_stop:${c.id}`, title: "Durdur" }] };
  if (p.event === "cap") return { text: `⛔ Aylık reklam bütçe sınırına ulaşıldı; reklamlar durduruldu.`, link: { title: "Reklamları gör", url: `${SITE}/ads.html` } };
  return { text: `⏸️ Reklam durduruldu: ${short(p.reason || c.paused_reason, 200)}.`, link: { title: "Reklamları gör", url: `${SITE}/ads.html` } };
}
async function adsCommand(link: Link, cmd: Cmd): Promise<Reply> {
  const cs = await adsSummary(link.user_id);
  if (cmd.intent === "ads_status") {
    if (!cs.length) return { text: "📣 Açık reklamın yok.", link: { title: "Reklamları gör", url: `${SITE}/ads.html` } };
    return { text: "📣 Reklamlar (son 7 gün):\n" + cs.map((c: any) => `• ${ADS_ST[c.status] || c.status}: harcama ${money(c.spend_7d || 0, c.currency || "TRY")}, satış ${money(c.revenue_7d || 0, c.currency || "TRY")}${c.roas_7d != null ? ", ROAS " + c.roas_7d : ""} · günlük ${money(c.daily_budget, c.currency || "TRY")}`).join("\n") };
  }
  const target = cmd.intent === "ads_resume" ? cs.find((c: any) => ["paused", "pending_approval"].includes(c.status)) : cs.find((c: any) => c.status === "active") || cs[0];
  if (!target) return { text: "Uygun reklam bulunamadı." };
  if (cmd.intent === "ads_pause") { const r = await fn("ads", link.user_id, { action: "pause", campaignId: target.id, reason: "Asistandan durduruldu" }); return { text: r?.ok ? "⏸️ Reklam durduruldu." : "İşlem yapılamadı: " + short(r?.error, 200) }; }
  if (cmd.intent === "ads_resume") { const r = await fn("ads", link.user_id, { action: target.status === "pending_approval" ? "approve" : "resume", campaignId: target.id }); return { text: r?.ok ? `▶️ Reklam yayında (günlük ${money(r.budget, target.currency || "TRY")}).` : "İşlem yapılamadı: " + short(r?.error, 200) }; }
  if (cmd.intent === "ads_budget") {
    if (!(Number(cmd.price) > 0)) return { text: "Bütçeyi sayıyla yaz (örn. \"reklam bütçesini 500 yap\")." };
    const r = await fn("ads", link.user_id, { action: "budget", campaignId: target.id, amount: cmd.price });
    return { text: r?.ok ? `✅ Günlük reklam bütçesi ${money(r.budget, target.currency || "TRY")} oldu${r.capped ? " (bütçe sınırın nedeniyle)" : ""}.` : "İşlem yapılamadı: " + short(r?.error, 200) };
  }
  return { text: "Anlamadım." };
}

// İade bildirimleri: karar bekleyen talep [Onayla] [Reddet], para iadesi [Parayı iade ettim]
const RET_REASON: Record<string, string> = { size: "Beden / ölçü uymadı", changed_mind: "Vazgeçtim", defective: "Ürün kusurlu", damaged: "Hasarlı geldi", wrong_item: "Yanlış ürün geldi",
  not_as_described: "Açıklamayla uyuşmuyor", late: "Geç geldi", other: "Diğer" };
async function returnAlert(p: any): Promise<Reply> {
  const { data: r } = await db.from("returns").select("id, status, reason_code, reason_text, amount, currency, withdrawal, decision_note, refund_status, refund_due_at, product_id, source").eq("id", p.return_id).maybeSingle();
  if (!r) return { text: `↩️ İade: ${short(p.text, 300)}`, link: { title: "İadeleri gör", url: `${SITE}/orders.html#returns` } };
  const { data: pr } = r.product_id ? await db.from("products").select("generated_title, name").eq("id", r.product_id).maybeSingle() : { data: null };
  const head = `${short(pr?.generated_title || pr?.name || "", 60)} — ${RET_REASON[r.reason_code] || r.reason_code}${r.amount != null ? " · " + money(r.amount, r.currency || "TRY") : ""}`;
  if (p.status === "refund_due" || p.status === "refund_pending" || (r.refund_status === "pending" && p.status !== "requested")) {
    const due = r.refund_due_at ? ` Son gün: ${String(r.refund_due_at).slice(0, 10)}.` : "";
    return { text: `💸 ${p.status === "refund_due" ? short(p.text, 80) : "Müşteriye para iadesi yap"}: ${head}.${due}`, buttons: [{ id: `ret_paid:${r.id}`, title: "Parayı iade ettim" }] };
  }
  if (r.status === "requested") {
    const legal = r.withdrawal && /^Yasal cayma/.test(r.decision_note || "");
    const quote = r.reason_text ? "\n“" + short(r.reason_text, 200) + "”" : "";
    const why = r.decision_note ? "\n" + short(r.decision_note, 160) : "";
    return { text: `↩️ İade talebi: ${head}${quote}${why}`,
      buttons: legal ? [{ id: `ret_ok:${r.id}`, title: "Onayla" }] : [{ id: `ret_ok:${r.id}`, title: "Onayla" }, { id: `ret_no:${r.id}`, title: "Reddet" }] };
  }
  if (r.status === "received") return { text: `📦 İade ürünü geri geldi: ${head}.`, link: { title: "İadeleri gör", url: `${SITE}/orders.html#returns` } };
  return { text: `↩️ İade: ${head} (${r.status})`, link: { title: "İadeleri gör", url: `${SITE}/orders.html#returns` } };
}

export async function renderAlert(kind: string, p: any, userId: string): Promise<{ reply: Reply; need: "orders" | "products" | "owner" } | null> {
  // Hazır metinli bildirim (sezon takvimi, kişiselleştirilmiş baskı siparişi vb.)
  if (kind === "notice") return { need: "owner", reply: { text: short(p.text, 900) } };
  if (kind === "new_order") {
    const { data: pr } = await db.from("products").select("generated_title, name").eq("id", p.product_id).maybeSingle();
    // Pazaryeri siparişi (ör. amazon_tr -> "Amazon TR"); Kendi Mağazam siparişinde düğme, diğerlerinde sipariş sayfası bağlantısı
    const mp = p.marketplace ? mpName(p.marketplace) : "";
    const text = `🛒 Yeni sipariş${mp ? " (" + mp + ")" : ""}: ${short(pr?.generated_title || pr?.name, 60)}${p.variant ? " (" + trVariant(p.variant) + ")" : ""} ×${p.quantity || 1} — ${money((Number(p.unit_price) || 0) * (p.quantity || 1), p.currency || "TRY")}\n${p.customer || ""}, ${p.city || ""}`;
    return { need: "orders", reply: p.store_order_id
      ? { text, buttons: [{ id: `order:${p.store_order_id}`, title: "Siparişi gör" }] }
      : { text, link: { title: "Siparişi gör", url: `${SITE}/orders.html` } } };
  }
  if (kind === "stock") return { need: "products", reply: { text: `📉 Stok ${p.status === "tukendi" ? "bitti" : "bitiyor"}: ${short(p.name, 60)}${p.qty != null ? " (kalan " + p.qty + ")" : ""}`, buttons: [{ id: `stock:${p.product_id}`, title: "Stok ekle" }] } };
  if (kind === "loss_approval") return { need: "owner", reply: { text: `⚠️ Onay bekleyen sipariş: ${short(p.message, 400)}`, buttons: [{ id: `approve:${p.order_id}`, title: "Onayla" }, { id: `cancel:${p.order_id}`, title: "İptal" }] } };
  if (kind === "cj_balance") return { need: "owner", reply: { text: `💳 CJ bakiyen yetmiyor; sipariş bekliyor. ${short(p.message, 300)}`, buttons: [{ id: "balance", title: "Bakiye yükle" }] } };
  if (kind === "site_import") return { need: "owner", reply: {
    text: `🌐 ${short(p.site, 60)} sitendeki ${p.count} ürün Kendi Mağazam'da yayında.`,
    link: { title: "Mağazayı aç", url: `${SITE}/magaza.html?slug=${encodeURIComponent(p.slug || "")}` } } };
  if (kind === "connection") return { need: "owner", reply: { text: `🔌 ${short(p.name, 40)} bağlantının süresi doluyor${p.expires ? " (" + p.expires + ")" : ""}.`, buttons: [{ id: "reconnect", title: "Yeniden bağla" }] } };
  if (kind === "return") return { need: "orders", reply: await returnAlert(p) };
  if (kind === "ads") return { need: "owner", reply: await adsAlert(p) };
  if (kind === "content") return { need: "owner", reply: { text: `🗓️ Önümüzdeki günler için ${p.count || 0} gönderi / hikâye hazır; onayını bekliyor.`,
    buttons: [{ id: "ct_all", title: "Hepsini onayla" }], link: { title: "İçerik Takvimi", url: `${SITE}/content.html` } } };
  if (kind === "competitor") return { need: "owner", reply: {
    text: `📉 Rakip fiyat düşürdü: ${short(p.name, 50)} — rakip ${money(p.competitor_price)}, senin ${money(p.my_price)}. Önerilen: ${money(p.suggested)} (alt sınırının altına inmez).`,
    buttons: [{ id: `price_drop:${p.product_id}:${p.suggested}`, title: "Fiyatı düşür" }, { id: "keep_price", title: "Böyle kalsın" }] } };
  if (kind === "morning_report") return { need: "owner", reply: await morningReport(userId) };
  if (kind === "weekly_summary") return { need: "owner", reply: await weeklySummary(userId) };
  return null;
}

// ---------- Butonlar ----------
async function handleButton(link: Link, id: string): Promise<Reply[]> {
  const st = await getState(link);
  const [act, a1, a2] = id.split(":");
  if (act === "add_all" || act === "add_pick") {
    if (!can(link, "products")) return [NO_PERM];
    if (!st.pending?.rows?.length) return [{ text: "Eklenecek liste yok. Önce PDF / katalog gönder." }];
    if (act === "add_pick") return [{ text: "Hangi ürünler? Örn: \"1-15 ekle\", \"1,3,7 ekle\" ya da \"1-15'i %50 kârla ekle\"." }];
    return await addFromPending(link, st, { all: true });
  }
  if (act === "publish") {
    if (!can(link, "products")) return [NO_PERM];
    const ids: number[] = st.awaitPublish || [];
    if (!ids.length) return [{ text: "Yayın bekleyen ürün yok." }];
    await publishProducts(link, ids);
    await setState(link, { ...st, awaitPublish: null, awaitPriceEdit: null });
    const stp = await settings(link.user_id);
    const dist = await sendToChannels(link, ids, stp.default_channels || ["own_store"]);
    const miss = dist.missing.length ? `
ℹ️ ${dist.missing.map((c: string) => CHANNEL_NAMES[c] || c).join(", ")} bağlı değil; Hesaplarım'dan bağlayınca oraya da gönderirim.` : "";
    return [{ text: `✅ ${ids.length} ürün Kendi Mağazam'da yayında.${sentLines(dist.sent)}${miss}`, link: { title: "Ürünlerim", url: `${SITE}/dashboard.html` } }];
  }
  if (act === "edit_prices") {
    await setState(link, { ...st, awaitPriceEdit: st.awaitPublish || [] });
    return [{ text: "Yeni kâr oranını ya da fiyatı yaz. Örn: \"%45\" (hepsine) ya da \"2. ürün 350\"." }];
  }
  if (act === "ae_src" && st.awaitAe) {
    const r = await ingest(link, [st.awaitAe.item], { ...st.awaitAe.opts, aeSource: a1 });
    await setState(link, { ...st, awaitAe: null, awaitPublish: r.approve ? r.products.map((p: any) => p.id) : null });
    return [addedReply(r)];
  }
  if (act === "order") return [{ text: "Sipariş ayrıntıları:", link: { title: "Siparişi gör", url: `${SITE}/orders.html` } }];
  if (act === "stock") {
    if (!can(link, "products")) return [NO_PERM];
    await setState(link, { ...st, awaitStock: Number(a1) });
    return [{ text: "Kaç adet stok ekleyeyim? Sadece sayıyı yaz (örn. 20)." }];
  }
  if (act === "approve" || act === "cancel") {
    if (!can(link, "owner")) return [NO_PERM];
    // İkinci onay (kritik iş)
    await setState(link, { ...st, confirm: { action: act, orderId: a1, at: Date.now() } });
    return [{ text: act === "approve" ? "Sipariş zarar kontrolüne rağmen ödenecek. Emin misin?" : "Sipariş iptal edilecek. Emin misin?", buttons: [{ id: "confirm", title: "Evet" }, { id: "deny", title: "Vazgeç" }] }];
  }
  if (act === "price_drop") {
    if (!can(link, "owner")) return [NO_PERM];
    await setState(link, { ...st, confirm: { action: "price_drop", productId: Number(a1), price: Number(a2), at: Date.now() } });
    return [{ text: `Fiyat ${money(a2)} olacak. Emin misin?`, buttons: [{ id: "confirm", title: "Evet" }, { id: "deny", title: "Vazgeç" }] }];
  }
  if (act === "keep_price") return [{ text: "Tamam, fiyat aynı kaldı." }];
  if (act === "ct_all") {
    if (!can(link, "owner")) return [NO_PERM];
    const r = await fn("content", link.user_id, { action: "approve", all: true });
    return [{ text: r?.ok ? `✅ ${r.approved} içerik onaylandı; zamanı gelince paylaşılacak.` : "İşlem yapılamadı: " + short(r?.error, 200) }];
  }
  if (act === "ads_ok" || act === "ads_stop") {
    if (!can(link, "owner")) return [NO_PERM];
    const r = await fn("ads", link.user_id, act === "ads_ok" ? { action: "approve", campaignId: a1 } : { action: "pause", campaignId: a1, reason: "Asistandan durduruldu" });
    return [{ text: r?.ok ? (act === "ads_ok" ? `▶️ Reklam yayında (günlük ${money(r.budget)}).` : "⏸️ Reklam durduruldu.") : "İşlem yapılamadı: " + short(r?.error, 200) }];
  }
  if (act === "ret_ok") {
    if (!can(link, "orders")) return [NO_PERM];
    const r = await fn("returns", link.user_id, { action: "decide", returnId: a1, approve: true, note: "Satıcı onayladı (asistan)" });
    return [{ text: r?.ok ? "✅ İade onaylandı." + (r.label ? " İade etiketi müşteriye iletildi." : "") : "İşlem yapılamadı: " + short(r?.error, 200) }];
  }
  if (act === "ret_no" || act === "ret_paid") {
    if (!can(link, "owner")) return [NO_PERM];
    // İkinci onay (kritik iş: red / para)
    await setState(link, { ...st, confirm: { action: act, returnId: a1, at: Date.now() } });
    return [{ text: act === "ret_no" ? "İade talebi reddedilecek. Emin misin?" : "Müşteriye parayı iade ettiğini kaydediyorum. Emin misin?", buttons: [{ id: "confirm", title: "Evet" }, { id: "deny", title: "Vazgeç" }] }];
  }
  if (act === "confirm") return await runConfirmed(link, st);
  if (act === "deny") { await setState(link, { ...st, confirm: null }); return [{ text: "Vazgeçildi." }]; }
  if (act === "balance") return [{ text: "CJ bakiyeni yükledikten sonra bekleyen siparişler otomatik ödenir.", link: { title: "CJ'ye git", url: "https://cjdropshipping.com/myCJ.html#/wallet" } }];
  if (act === "reconnect") return [{ text: "Bağlantıyı yenilemek için:", link: { title: "Yeniden bağla", url: `${SITE}/accounts.html` } }];
  if (act === "shipments") return [await shipmentsReply(link)];
  if (act === "ans_send") {
    if (!can(link, "orders")) return [NO_PERM];
    const { data: q } = await db.from("support_questions").select("id, ai_answer").eq("id", a1).eq("user_id", link.user_id).maybeSingle();
    if (!q) return [{ text: "Soru bulunamadı." }];
    await db.from("support_questions").update({ seller_answer: q.ai_answer, status: "answered", answered_at: new Date().toISOString() }).eq("id", q.id);
    return [{ text: "✅ Cevap gönderildi." }, await questionsReply(link)];
  }
  if (act === "ans_edit") {
    await setState(link, { ...st, awaitAnswer: a1 });
    return [{ text: "Cevabını yaz; olduğu gibi gönderirim." }];
  }
  return [{ text: "Bu düğmenin süresi dolmuş olabilir. Tekrar dener misin?" }];
}
async function runConfirmed(link: Link, st: any): Promise<Reply[]> {
  const c = st.confirm;
  await setState(link, { ...st, confirm: null });
  if (!c || Date.now() - c.at > 10 * 60_000) return [{ text: "Onay süresi doldu (10 dk). İşlemi yeniden başlat." }];
  if (c.action === "approve" || c.action === "cancel") {
    const r = await fn("cj-order-worker", link.user_id, { action: c.action, orderId: c.orderId });
    return [{ text: r?.error ? "İşlem yapılamadı: " + short(r.error, 200) : (c.action === "approve" ? "✅ Sipariş onaylandı, işleniyor." : "✅ Sipariş iptal edildi.") }];
  }
  if (c.action === "price_drop") {
    const { data: p } = await db.from("products").select("id, sale_price").eq("id", c.productId).eq("user_id", link.user_id).maybeSingle();
    if (!p) return [{ text: "Ürün bulunamadı." }];
    await db.from("products").update({ sale_price: c.price }).eq("id", p.id);
    await db.from("listings").update({ price: c.price }).eq("product_id", p.id).eq("marketplace_code", "own_store");
    return [{ text: `✅ Fiyat ${money(c.price)} oldu.` }];
  }
  if (c.action === "ret_no" || c.action === "ret_paid") {
    const r = await fn("returns", link.user_id, c.action === "ret_no" ? { action: "decide", returnId: c.returnId, approve: false, note: "Satıcı reddetti" } : { action: "refunded", returnId: c.returnId });
    return [{ text: r?.ok ? (c.action === "ret_no" ? "✅ İade talebi reddedildi." : "✅ Para iadesi kaydedildi.") : "İşlem yapılamadı: " + short(r?.error, 200) }];
  }
  if (c.action === "delete") {
    await db.from("products").update({ deleted_at: new Date().toISOString() }).in("id", c.ids).eq("user_id", link.user_id);
    return [{ text: `🗑️ ${c.ids.length} ürün silindi.` }];
  }
  return [{ text: "Onaylanacak işlem bulunamadı." }];
}

async function addFromPending(link: Link, st: any, cmd: Cmd): Promise<Reply[]> {
  const rows: any[] = st.pending?.rows || [];
  let pick: any[] = rows;
  if (cmd.range) pick = rows.slice(Math.max(0, cmd.range[0] - 1), Math.min(rows.length, cmd.range[1]));
  else if (cmd.picks?.length) pick = cmd.picks.map((i) => rows[i - 1]).filter(Boolean);
  if (!pick.length) return [{ text: "Bu numaralarda ürün yok." }];
  const r = await ingest(link, pick.map(rowToItem), { margin: cmd.margin, channels: cmd.channels });
  await setState(link, { ...st, pending: null, awaitPublish: r.approve ? r.products.map((p: any) => p.id) : null });
  return [addedReply(r)];
}

// ---------- Ana giriş ----------
export async function handleIncoming(inc: Incoming): Promise<{ link: Link | null; replies: Reply[] }> {
  const { data: link } = await db.from("assistant_links").select("*").eq("channel", inc.channel).eq("external_id", inc.externalId).maybeSingle() as { data: Link | null };
  const text = (inc.text || "").trim();

  // Bağlama (yalnız panelden alınan tek kullanımlık kodla)
  const codeM = text.match(/^(?:\/start\s+|bağla\s+|bagla\s+)?([A-Z0-9]{8})$/i);
  if (!link || codeM && !link) {
    if (codeM) {
      const code = codeM[1].toUpperCase();
      const { data: c } = await db.from("assistant_link_codes").select("*").eq("code", code).is("used_at", null).gt("expires_at", new Date().toISOString()).maybeSingle();
      if (c && c.channel === inc.channel) {
        await db.from("assistant_link_codes").update({ used_at: new Date().toISOString() }).eq("code", code);
        const ins = await db.from("assistant_links").upsert({
          user_id: c.user_id, channel: inc.channel, external_id: inc.externalId, display_name: inc.name || null, role: c.role, is_owner: c.is_owner, last_inbound_at: new Date().toISOString(),
        }, { onConflict: "channel,external_id" }).select("*").single();
        return { link: ins.data as Link, replies: [{ text: "✅ Seltigo hesabına bağlandın.\n\n" + HELP.text }] };
      }
      return { link: null, replies: [{ text: "Bu kod geçersiz ya da süresi dolmuş. Seltigo panelinde 🤖 Asistan bölümünden yeni kod al." }] };
    }
    return { link: null, replies: [{ text: "Merhaba! Bu hesap henüz bir Seltigo hesabına bağlı değil. Seltigo panelinde 🤖 Asistan bölümünden bağlama kodunu al ve buraya gönder." }] };
  }

  await db.from("assistant_links").update({ last_inbound_at: new Date().toISOString(), display_name: inc.name || link.display_name }).eq("id", link.id);
  await db.from("assistant_messages").insert({ user_id: link.user_id, channel: link.channel, direction: "in" });
  link.last_inbound_at = new Date().toISOString();

  // Paket anahtarları (tek yerden aç / kapa: feature_flags)
  if (!(await featureEnabled(link.user_id, "assistant"))) return { link, replies: [{ text: "Seltigo Asistan paketinde kapalı. " + FEATURE_OFF_MSG }] };
  if (link.channel === "whatsapp" && !(await featureEnabled(link.user_id, "assistant_whatsapp"))) {
    return { link, replies: [{ text: "Seltigo Asistan'ın WhatsApp sürümü paketinde kapalı; Telegram'dan kullanabilirsin." }] };
  }
  // WhatsApp ayrı ücretli paket + aylık mesaj sınırı (test kanalı ve Telegram serbest)
  if (link.channel === "whatsapp") {
    const st0 = await settings(link.user_id);
    if (!st0.whatsapp_plan && Deno.env.get("ASSISTANT_WA_REQUIRE_PLAN") === "true") {
      return { link, replies: [{ text: "Seltigo Asistan'ın WhatsApp sürümü ayrı bir pakettir. Paketini panelden açabilirsin; bu arada Telegram'dan ücretsiz kullanabilirsin.", link: { title: "Paketler", url: `${SITE}/paket.html` } }] };
    }
    const { count } = await db.from("assistant_messages").select("id", { count: "exact", head: true }).eq("user_id", link.user_id).eq("channel", "whatsapp").eq("direction", "out").gte("created_at", monthStart());
    if ((count || 0) >= Number(st0.whatsapp_monthly_limit || 1000)) return { link, replies: [{ text: "Bu ayki WhatsApp mesaj sınırına ulaştın. Telegram'dan devam edebilir ya da paketini büyütebilirsin." }] };
  }

  try {
    if (inc.callback) return { link, replies: await handleButton(link, inc.callback) };

    const st = await getState(link);
    // Dosyalar
    if (inc.file) {
      if (!can(link, "products")) return { link, replies: [NO_PERM] };
      if (inc.file.kind === "audio") {
        if (!(await featureEnabled(link.user_id, "assistant_voice"))) return { link, replies: [{ text: "🎙️ Sesli komut paketinde kapalı. Yazarak gönderebilirsin." }] };
        if (!STT_API_KEY) return { link, replies: [{ text: "🎙️ Sesli komut şu an kapalı (konuşmayı yazıya çeviren servis henüz açılmadı). Şimdilik yazarak gönderebilir misin?" }] };
        const bytes = await inc.file.bytes();
        const fd = new FormData();
        fd.append("model", STT_MODEL);
        fd.append("language", "tr");
        fd.append("file", new Blob([bytes as BlobPart], { type: inc.file.mime || "audio/ogg" }), inc.file.filename || "ses.ogg");
        const r = await fetch(STT_URL, { method: "POST", headers: { Authorization: `Bearer ${STT_API_KEY}` }, body: fd });
        const d = await r.json().catch(() => ({}));
        if (!d?.text) return { link, replies: [{ text: "Sesli mesajı anlayamadım, yazarak dener misin?" }] };
        const sub = await handleIncoming({ ...inc, file: undefined, text: d.text });
        return { link, replies: [{ text: `🎙️ "${short(d.text, 200)}"` }, ...sub.replies] };
      }
      const cmd = parseCommand(text);
      if (inc.file.kind === "image" && (cmd.price || cmd.stock || text.length > 0)) {
        // Tek ürün fotoğrafı + "350'ye sat, 20 tane"
        const bytes = await inc.file.bytes();
        const { info, url } = await productFromPhoto(link, bytes, inc.file.mime || "image/jpeg", cmd);
        if (info?.isCatalogPage && !cmd.price) {
          const rows = await rowsFromFile(link, { ...inc.file, bytes: async () => bytes });
          if (rows.length >= 2) return { link, replies: [await previewRows(link, rows, "Katalog fotoğrafı")] };
        }
        if (!info?.name) return { link, replies: [{ text: "Fotoğraftaki ürünü tanıyamadım. Ürünün adını da yazar mısın?" }] };
        const item = { name: info.name, brand: info.brand || "", description: info.description || "", specs: info.specs || [], images: [url], price: cmd.price || null, currency: "TRY", url: "", source_platform: null, imgSrc: { kind: "seller_photo", url: "" } };
        const r = await ingest(link, [item], { salePrice: cmd.price, stock: cmd.stock, channels: cmd.channels });
        await setState(link, { ...st, awaitPublish: r.approve ? r.products.map((p: any) => p.id) : null });
        return { link, replies: [addedReply(r)] };
      }
      const rows = await rowsFromFile(link, inc.file);
      if (!rows.length) return { link, replies: [{ text: "Dosyada ürün bulamadım. Fiyat listesi ya da katalog olduğundan emin misin?" }] };
      return { link, replies: [await previewRows(link, rows, inc.file.filename || "Dosya")] };
    }

    const cmd = parseCommand(text);
    // Bekleyen sorular
    if (st.awaitStock && /^\d{1,6}$/.test(text)) {
      const { data: p } = await db.from("products").select("id, stock_qty").eq("id", st.awaitStock).eq("user_id", link.user_id).maybeSingle();
      await setState(link, { ...st, awaitStock: null });
      if (!p) return { link, replies: [{ text: "Ürün bulunamadı." }] };
      const q = (Number(p.stock_qty) || 0) + Number(text);
      await db.from("products").update({ stock_qty: q, stock_status: q > 5 ? "stokta" : "az", store_visible: true }).eq("id", p.id);
      return { link, replies: [{ text: `✅ Stok ${q} oldu.` }] };
    }
    if (st.awaitAnswer) {
      await db.from("support_questions").update({ seller_answer: text.slice(0, 2000), status: "answered", answered_at: new Date().toISOString() }).eq("id", st.awaitAnswer).eq("user_id", link.user_id);
      await setState(link, { ...st, awaitAnswer: null });
      return { link, replies: [{ text: "✅ Cevabın gönderildi." }, await questionsReply(link)] };
    }
    if (st.awaitPriceEdit?.length && (cmd.margin != null || cmd.price != null)) {
      const ids: number[] = st.awaitPriceEdit;
      const nth = text.match(/(\d{1,3})\s*\.\s*ürün/);
      const targets = nth ? [ids[Number(nth[1]) - 1]].filter(Boolean) : ids;
      for (const id of targets) {
        const { data: p } = await db.from("products").select("id, supplier_price").eq("id", id).maybeSingle();
        if (!p) continue;
        const sale = cmd.price != null && nth ? cmd.price : Math.round(Number(p.supplier_price) * (1 + (cmd.margin ?? 0) / 100) * 100) / 100;
        await db.from("products").update({ sale_price: sale }).eq("id", id);
      }
      const { data: ps } = await db.from("products").select("id, name, sale_price, cost_currency").in("id", ids);
      return { link, replies: [{ text: "Güncel fiyatlar:\n" + (ps || []).map((p: any, i: number) => `${i + 1}. ${short(p.name, 50)} — ${money(p.sale_price, p.cost_currency)}`).join("\n"),
        buttons: [{ id: "publish", title: "Yayınla" }, { id: "edit_prices", title: "Fiyatları düzenle" }] }] };
    }
    if (cmd.intent === "publish") return { link, replies: await handleButton(link, "publish") };
    if (cmd.intent === "cancel") { await setState(link, {}); return { link, replies: [{ text: "Tamam, bekleyen işlemi bıraktım." }] }; }
    if ((cmd.intent === "add" || (st.pending && (cmd.range || cmd.all || /\d+\s*,\s*\d+/.test(text)) && /ekle/.test(lower(text)))) && st.pending) {
      if (!can(link, "products")) return { link, replies: [NO_PERM] };
      const picks = (text.match(/^\s*([\d\s,]+)\s*ekle/i) || [])[1];
      if (picks && !cmd.range) cmd.picks = picks.split(/[\s,]+/).map(Number).filter(Boolean);
      return { link, replies: await addFromPending(link, st, cmd) };
    }
    if (/\bsil\b/.test(lower(text)) && /hepsini|tümünü|ürünleri/.test(lower(text))) {
      if (!can(link, "owner")) return { link, replies: [NO_PERM] };
      const { data: ps } = await db.from("products").select("id").eq("user_id", link.user_id).is("deleted_at", null).limit(1000);
      const ids = (ps || []).map((p: any) => p.id);
      await setState(link, { ...st, confirm: { action: "delete", ids, at: Date.now() } });
      return { link, replies: [{ text: `⚠️ ${ids.length} ürünün hepsi silinecek. Emin misin?`, buttons: [{ id: "confirm", title: "Evet" }, { id: "deny", title: "Vazgeç" }] }] };
    }
    if (cmd.url) {
      if (!can(link, "products")) return { link, replies: [NO_PERM] };
      const d = await fn("product-import", link.user_id, { url: cmd.url, language: "tr" });
      if (d?.kind === "feed" || d?.kind === "category") {
        const items = d.kind === "feed" ? d.items : [];
        if (items.length) {
          await setState(link, { ...st, pending: { rows: items.map((i: any) => ({ name: i.name, code: i.model_code, price: i.price, list_price: i.list_price, currency: i.currency, brand: i.brand, _item: i })), from: "Link", at: Date.now() } });
          return { link, replies: [await previewRows(link, items.map((i: any) => ({ name: i.name, code: i.model_code, price: i.price, currency: i.currency })), "Mağaza linki")] };
        }
        return { link, replies: [{ text: "Bu bir liste sayfası; tek ürün linki gönderir misin? (Tüm siteyi panelden Toplu Ürün Yükleme ile çekebilirsin.)" }] };
      }
      if (!d?.item?.name) return { link, replies: [{ text: "Bu linkten ürün okuyamadım: " + short(d?.error || "", 150) }] };
      if (d.item.source_platform === "aliexpress") {
        await setState(link, { ...st, awaitAe: { item: d.item, opts: { salePrice: cmd.price, stock: cmd.stock, margin: cmd.margin, channels: cmd.channels } } });
        return { link, replies: [{ text: `${short(d.item.name, 80)}\nAliExpress ürünleri için kaynak (AliExpress seçilirse siparişler otomatik AliExpress'e verilir):`,
          buttons: [{ id: "ae_src:aliexpress", title: "AliExpress" }, { id: "ae_src:own", title: "Kendi stoğum" }] }] };
      }
      const r = await ingest(link, [d.item], { salePrice: cmd.price, stock: cmd.stock, margin: cmd.margin, channels: cmd.channels });
      await setState(link, { ...st, awaitPublish: r.approve ? r.products.map((p: any) => p.id) : null });
      return { link, replies: [addedReply(r)] };
    }
    if (cmd.intent === "help" || !text) return { link, replies: [HELP] };
    if (cmd.intent === "profit") return { link, replies: [can(link, "owner") ? await profitReply(link) : NO_PERM] };
    if (cmd.intent?.startsWith("ads_")) return { link, replies: [can(link, "owner") ? await adsCommand(link, cmd) : NO_PERM] };
    if (cmd.intent === "top") return { link, replies: [can(link, "owner") ? await topReply(link) : NO_PERM] };
    if (cmd.intent === "losing") return { link, replies: [can(link, "owner") ? await losingReply(link) : NO_PERM] };
    if (cmd.intent === "shipments") return { link, replies: [can(link, "orders") ? await shipmentsReply(link) : NO_PERM] };
    if (cmd.intent === "questions") return { link, replies: [can(link, "orders") ? await questionsReply(link) : NO_PERM] };
    if (cmd.intent === "report") return { link, replies: [can(link, "owner") ? await morningReport(link.user_id) : NO_PERM] };
    if (cmd.intent === "weekly") return { link, replies: [can(link, "owner") ? await weeklySummary(link.user_id) : NO_PERM] };
    // Anlaşılmadı: yapay zekâya niyet sor
    const g = await ai("Classify a Turkish e-commerce seller's chat message to a store assistant. Answer ONLY JSON {\"intent\":\"profit|top|losing|shipments|questions|report|weekly|help|other\"}.", [{ type: "text", text }], 100);
    if (g?.intent && g.intent !== "other" && g.intent !== "help") return handleIncoming({ ...inc, text: ({ profit: "bu ay ne kadar kâr ettim", top: "en çok ne satıyor", losing: "hangi ürün zarar ediyor", shipments: "bugün gönderilecekler", questions: "müşteri soruları", report: "rapor", weekly: "haftalık özet" } as any)[g.intent] });
    return { link, replies: [HELP] };
  } catch (e) {
    return { link, replies: [{ text: "Bir sorun oldu: " + short((e as Error).message, 200) + "\nTekrar dener misin?" }] };
  }
}

export type { Button, Reply };
