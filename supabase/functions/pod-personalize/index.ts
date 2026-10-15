// =========================================================
// Kişiselleştirilmiş baskılı ürün siparişi — tam otomatik (zamanlanmış, 5 dk; CRON_SECRET)
// Printify'ın Etsy kişiselleştirme alanları yalnız Printify arayüzünde kurulabildiği (API'de alan oluşturma yok) için akış tamamen API ile:
//  1) Printify'da bekleyen (on-hold) siparişler okunur; Seltigo'nun kişiselleştirilmiş ürünü (pod_products.personalized) varsa:
//  2) Etsy siparişinden (metadata.shop_order_id = Etsy receipt) alıcının yazdığı isimler okunur (resmi Etsy API, getShopReceipt)
//  3) İsim katmanı çizilir (PNG, 300 dpi tasarım ölçeğinde; yazı tipi Pacifico, OFL) ve depoya konur
//  4) Printify'ın açtığı isimsiz sipariş İPTAL edilir (önce iptal: iki kez basılmasın), aynı adrese isimli yeni sipariş açılır
//     (taban tasarım + isim katmanı; "advanced print areas") ve üretime gönderilir
//  5) Kargo çıkınca takip numarası Etsy siparişine işlenir (createReceiptShipment); her adım asistan kanalından (Telegram) bildirilir
// Kişiselleştirilmemiş bekleyen siparişler (yalnız Seltigo'nun POD ürünleri) üretime gönderilir; satıcı hiçbir şeye dokunmaz.
// Ön koşul: Printify mağaza ayarında siparişler "elle onay" olmalı (yoksa Printify isimsiz baskıyı hemen üretir).
// Sistem: { cronSecret } | { cronSecret, dryRun: true } | { cronSecret, action: "render", names: [...], ink?: "dark" | "light", productId } (deneme çizimi)
// Paket anahtarı: pod_personalize
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { initWasm, Resvg } from "npm:@resvg/resvg-wasm@2.6.2";
import { etsy, etsyToken } from "../_shared/etsy.ts";
import { featureEnabled } from "../_shared/features.ts";

const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const short = (v: unknown, n = 300) => String(v ?? "").slice(0, n);
const FONT_URL = "https://raw.githubusercontent.com/google/fonts/main/ofl/pacifico/Pacifico-Regular.ttf";
const WASM_URL = "https://unpkg.com/@resvg/resvg-wasm@2.6.2/index_bg.wasm";
const TIME_BUDGET_MS = 110_000;

// ---------------- Printify ----------------
async function pf(token: string, method: string, path: string, body?: unknown) {
  for (let i = 0; ; i++) {
    const r = await fetch("https://api.printify.com/v1" + path, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "Seltigo" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000),
    });
    const text = await r.text(); let d: any = text; try { d = text ? JSON.parse(text) : {}; } catch { /* düz metin */ }
    if (r.ok) return d;
    if ((r.status === 429 || r.status >= 500) && i < 3) { await new Promise((res) => setTimeout(res, 1500 * 2 ** i)); continue; }
    throw new Error(`Printify ${r.status}: ${short(typeof d === "string" ? d : JSON.stringify(d?.errors || d), 200)}`);
  }
}

// ---------------- İsim katmanı ----------------
let ready: Promise<Uint8Array> | null = null;
function fontReady() {
  ready ??= (async () => {
    await initWasm(fetch(WASM_URL));
    const r = await fetch(FONT_URL); if (!r.ok) throw new Error("yazı tipi indirilemedi");
    return new Uint8Array(await r.arrayBuffer());
  })();
  return ready;
}
// Alıcının yazdığı metinden isimler: virgül / satır / "&" / " and " ile ayrılır; en fazla 8; Pacifico'nun desteklediği Latin harfler kalır
export function parseNames(raw: string): string[] {
  return String(raw || "").replace(/^\s*(names?|kids?|children)\s*:\s*/i, "").split(/\s*(?:,|;|\n|\/|&|\+|\band\b|•|\|)\s*/i)
    .map((n) => n.replace(/[^\p{Script=Latin}\s'\-.]/gu, "").replace(/\s+/g, " ").trim()).filter((n) => n.length > 0 && n.length <= 20).slice(0, 8);
}
export function layoutLines(names: string[]): string[] {
  const sep = "  •  ";
  if (names.join("").length <= 24) return [names.join(sep)];
  const out: string[] = []; for (let i = 0; i < names.length; i += 3) out.push(names.slice(i, i + 3).join(sep)); return out;
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// cfg: pod_products.personalization.names = { top_px, max_w_px, font_px, line_gap_px }, canvas [W, H]
export async function renderNames(names: string[], color: string, cfg: any): Promise<{ png: Uint8Array; heightPx: number }> {
  const font = await fontReady(); const W = cfg.canvas?.[0] || 4500;
  const lines = layoutLines(names); let size = cfg.names.font_px;
  for (let attempt = 0; attempt < 6; attempt++) {
    const lh = size * 1.55, h = Math.ceil(lh * lines.length + size * 0.6);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}">` +
      lines.map((l, i) => `<text x="${W / 2}" y="${(i + 1) * lh - size * 0.35}" font-family="Pacifico" font-size="${size}" fill="${color}" text-anchor="middle">${esc(l)}</text>`).join("") + `</svg>`;
    const rv = new Resvg(svg, { font: { fontBuffers: [font], defaultFontFamily: "Pacifico", loadSystemFonts: false }, fitTo: { mode: "original" } });
    const bb = rv.innerBBox();
    if (bb && bb.width > cfg.names.max_w_px) { size = Math.floor(size * cfg.names.max_w_px / bb.width * 0.98); rv.free(); continue; }
    const png = rv.render().asPng(); rv.free();
    return { png, heightPx: h };
  }
  throw new Error("isimler sığdırılamadı");
}
// Tasarım pikselini (4500x5400 tuval) Printify baskı alanı oranına çevir: taban görsel x=.5 y=.5 scale=1 ile yerleşir
export const yFrac = (centerPx: number, cfg: any) => 0.5 + (centerPx - (cfg.canvas?.[1] || 5400) / 2) / ((cfg.canvas?.[0] || 4500) * (cfg.area_ratio || 1.2));

async function uploadPng(path: string, png: Uint8Array) {
  const { error } = await db.storage.from("product-images").upload(path, new Blob([new Uint8Array(png)], { type: "image/png" }), { upsert: true, contentType: "image/png" });
  if (error) throw new Error("depoya yazılamadı: " + error.message);
  return db.storage.from("product-images").getPublicUrl(path).data.publicUrl;
}

async function notify(userId: string, text: string, dedupe: string) {
  await db.rpc("assistant_enqueue", { p_user: userId, p_kind: "notice", p_payload: { text }, p_dedupe: dedupe });
}

// ---------------- Etsy ----------------
async function etsyCtx(userId: string) {
  const { data: conn } = await db.from("store_connections").select("id, external_seller_id").eq("marketplace_code", "etsy").eq("status", "connected").eq("user_id", userId).is("deleted_at", null).limit(1).maybeSingle();
  if (!conn) throw new Error("Etsy bağlı değil");
  const { token, cred } = await etsyToken(db, conn.id);
  return { ctx: { token }, shopId: String(cred.shop_id || conn.external_seller_id) };
}
// Etsy siparişindeki kişiselleştirme metinleri: ilan no -> [metin, metin…] (aynı ilandan birden çok adet / satır olabilir)
async function receiptPersonalizations(e: { ctx: any; shopId: string }, receiptId: string) {
  const r = await etsy(e.ctx, "GET", `/shops/${e.shopId}/receipts/${receiptId}`);
  const out = new Map<string, string[]>();
  for (const t of r.transactions || []) {
    const v = (t.variations || []).find((x: any) => /personali[sz]ation/i.test(String(x.formatted_name || "")));
    const text = v ? String(v.formatted_value || "") : "";
    for (let q = 0; q < Math.max(1, Number(t.quantity) || 1); q++) out.set(String(t.listing_id), [...(out.get(String(t.listing_id)) || []), text]);
  }
  return out;
}

// ---------------- Ana akış ----------------
async function handleOrder(userId: string, token: string, shopId: string, o: any, pods: Map<string, any>, dryRun: boolean) {
  const lines = o.line_items || [];
  const personal = lines.filter((l: any) => pods.get(String(l.product_id))?.personalized);
  const allOurs = lines.length && lines.every((l: any) => pods.has(String(l.product_id)));
  if (!personal.length) {
    if (!allOurs) return { id: o.id, skipped: "Seltigo dışı ürün" };
    if (dryRun) return { id: o.id, action: "üretime gönderilecek" };
    await pf(token, "POST", `/shops/${shopId}/orders/${o.id}/send_to_production.json`);
    return { id: o.id, action: "üretime gönderildi" };
  }
  const { data: rec } = await db.from("pod_personal_orders").select("*").eq("source_order_id", String(o.id)).maybeSingle();
  if (rec && ["created", "in_production", "shipped", "skipped"].includes(rec.status)) return { id: o.id, skipped: "zaten işlendi" };
  const receipt = String(o.metadata?.shop_order_id || "");
  if (!receipt) throw new Error("Etsy sipariş numarası yok");
  const e = await etsyCtx(userId);
  const texts = await receiptPersonalizations(e, receipt);
  const used = new Map<string, number>();
  const items: any[] = []; const files: any[] = []; const allNames: string[] = [];
  for (const l of lines) {
    const pod = pods.get(String(l.product_id));
    if (!pod?.personalized) { items.push({ product_id: l.product_id, variant_id: l.variant_id, quantity: l.quantity }); continue; }
    const cfg = pod.personalization || {};
    const lid = String(pod.external_listing_id || ""); const k = used.get(lid) || 0; used.set(lid, k + 1);
    const raw = (texts.get(lid) || [])[k] || "";
    const names = parseNames(raw);
    if (!names.length) throw new Error(`Alıcı isim yazmamış ya da okunamadı ("${short(raw, 60)}")`);
    allNames.push(...names);
    const ink = (cfg.dark_variant_ids || []).includes(Number(l.variant_id)) ? "light" : "dark";
    const color = cfg.ink?.[ink] || (ink === "light" ? "#F6EAD6" : "#3A2219");
    if (dryRun) { items.push({ variant_id: l.variant_id, names, ink }); continue; }
    const { png, heightPx } = await renderNames(names, color, cfg);
    const url = await uploadPng(`pod/${userId}/${o.id}-${items.length}.png`, png);
    files.push({ url, names, ink });
    const one = Math.max(1, Number(l.quantity) || 1);
    items.push({
      print_provider_id: pod.print_provider_id, blueprint_id: pod.blueprint_id, variant_id: l.variant_id, quantity: one,
      print_areas: { front: [
        { src: cfg.base_urls?.[ink], x: 0.5, y: 0.5, scale: 1, angle: 0 },
        { src: url, x: 0.5, y: yFrac(cfg.names.top_px + heightPx / 2, cfg), scale: 1, angle: 0 },
      ] },
    });
  }
  if (dryRun) return { id: o.id, receipt, items };
  const base = { user_id: userId, provider_shop_id: shopId, source_order_id: String(o.id), etsy_receipt_id: receipt, personalization: [...texts.values()].flat().join(" | "), names: allNames, print_files: files, updated_at: new Date().toISOString() };
  await db.from("pod_personal_orders").upsert({ ...base, status: "pending" }, { onConflict: "source_order_id" });
  // Önce isimsiz siparişi iptal et (iki kez basılmasın); sonra isimli siparişi aç ve üretime gönder
  if (o.status !== "canceled") await pf(token, "POST", `/shops/${shopId}/orders/${o.id}/cancel.json`);
  const a = o.address_to || {};
  const created = await pf(token, "POST", `/shops/${shopId}/orders.json`, {
    external_id: `seltigo-${o.id}`, label: `Etsy ${receipt}`, line_items: items, shipping_method: o.shipping_method || 1, send_shipping_notification: false,
    address_to: { first_name: a.first_name, last_name: a.last_name, email: a.email, phone: a.phone, country: a.country, region: a.region, address1: a.address1, address2: a.address2, city: a.city, zip: a.zip, company: a.company },
  });
  await pf(token, "POST", `/shops/${shopId}/orders/${created.id}/send_to_production.json`);
  await db.from("pod_personal_orders").update({ new_order_id: String(created.id), status: "in_production", error: null, updated_at: new Date().toISOString() }).eq("source_order_id", String(o.id));
  await notify(userId, `🧵 İsimli sipariş üretime gitti (Etsy ${receipt}): ${allNames.join(", ")}`, `pod:${o.id}:prod`);
  return { id: o.id, receipt, newOrder: created.id, names: allNames };
}

// Kargo çıkınca takip numarasını Etsy siparişine işle
async function syncTracking(userId: string, token: string) {
  const { data: rows } = await db.from("pod_personal_orders").select("*").eq("user_id", userId).eq("status", "in_production").limit(30);
  const out: any[] = [];
  for (const r of rows || []) {
    try {
      const o = await pf(token, "GET", `/shops/${r.provider_shop_id}/orders/${r.new_order_id}.json`);
      const sh = (o.shipments || [])[0];
      if (!sh?.number) continue;
      const e = await etsyCtx(userId);
      await etsy(e.ctx, "POST", `/shops/${e.shopId}/receipts/${r.etsy_receipt_id}/tracking`, { form: { tracking_code: sh.number, carrier_name: sh.carrier || "other", send_bcc: false } });
      await db.from("pod_personal_orders").update({ status: "shipped", tracking: sh, updated_at: new Date().toISOString() }).eq("id", r.id);
      await notify(userId, `📦 İsimli sipariş kargoda (Etsy ${r.etsy_receipt_id}): ${sh.carrier || ""} ${sh.number}`, `pod:${r.source_order_id}:ship`);
      out.push({ id: r.id, shipped: sh.number });
    } catch (e) { out.push({ id: r.id, error: short((e as Error).message) }); }
  }
  return out;
}

async function run(dryRun: boolean) {
  const started = Date.now();
  const { data: users } = await db.from("pod_products").select("user_id, provider_shop_id").eq("provider", "printify").eq("status", "published");
  const shops = new Map<string, Set<string>>();
  for (const u of users || []) shops.set(u.user_id, (shops.get(u.user_id) || new Set()).add(u.provider_shop_id));
  const out: any[] = [];
  for (const [userId, shopIds] of shops) {
    if (!(await featureEnabled(userId, "pod_personalize"))) { out.push({ userId, skipped: "paket" }); continue; }
    const { data: conn } = await db.from("printify_connections").select("api_token").eq("user_id", userId).maybeSingle();
    if (!conn?.api_token) { out.push({ userId, error: "Printify bağlı değil" }); continue; }
    const token = String(conn.api_token).trim();
    const { data: prods } = await db.from("pod_products").select("*").eq("user_id", userId).eq("provider", "printify");
    const pods = new Map<string, any>((prods || []).map((p: any) => [String(p.provider_product_id), p]));
    for (const shopId of shopIds) {
      const list = await pf(token, "GET", `/shops/${shopId}/orders.json?status=on-hold&limit=50`);
      for (const o of list.data || []) {
        if (Date.now() - started > TIME_BUDGET_MS) break;
        try { out.push(await handleOrder(userId, token, shopId, o, pods, dryRun)); }
        catch (e) {
          const msg = short((e as Error).message);
          if (!dryRun) {
            await db.from("pod_personal_orders").upsert({ user_id: userId, provider_shop_id: shopId, source_order_id: String(o.id), etsy_receipt_id: String(o.metadata?.shop_order_id || ""), status: "error", error: msg, updated_at: new Date().toISOString() }, { onConflict: "source_order_id" });
            await notify(userId, `⚠️ İsimli sipariş hazırlanamadı (Etsy ${o.metadata?.shop_order_id || "?"}): ${msg}. Sipariş bekliyor; her 5 dakikada yeniden denenir.`, `pod:${o.id}:err:${new Date().toISOString().slice(0, 13)}`);
          }
          out.push({ id: o.id, error: msg });
        }
      }
    }
    if (!dryRun) out.push({ userId, tracking: await syncTracking(userId, token) });
  }
  return { ok: true, dryRun, ms: Date.now() - started, results: out };
}

Deno.serve(async (req) => {
  const b = await req.json().catch(() => ({}));
  if (!CRON_SECRET || String(b?.cronSecret || "").trim() !== CRON_SECRET.trim()) return json({ ok: false, error: "unauthorized" }, 401);
  try {
    if (b.action === "render" && Array.isArray(b.names) && b.productId) {
      const { data: pod } = await db.from("pod_products").select("*").eq("provider_product_id", String(b.productId)).maybeSingle();
      if (!pod?.personalization) return json({ ok: false, error: "kişiselleştirilmiş ürün bulunamadı" });
      const ink = b.ink === "light" ? "light" : "dark"; const names = parseNames(b.names.join(","));
      const { png, heightPx } = await renderNames(names, pod.personalization.ink?.[ink] || "#3A2219", pod.personalization);
      const url = await uploadPng(`pod/test/${pod.provider_product_id}-${ink}.png`, png);
      return json({ ok: true, names, url, y: yFrac(pod.personalization.names.top_px + heightPx / 2, pod.personalization) });
    }
    return json(await run(b.dryRun === true));
  } catch (e) {
    return json({ ok: false, error: short((e as Error).message) }, 500);
  }
});
