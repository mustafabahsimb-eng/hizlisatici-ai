// =========================================================
// Seltigo - catalog-import ("PDF + link ile ürün yükleme"; WhatsApp / Telegram asistanı ve panel aynı motoru kullanır)
// Kaynaklar (ayrı ayrı ya da birlikte; asistanda 10 dk içinde gelen ikinci kaynak aynı yüklemeye eklenir):
//   - PDF (resimli katalog / resimsiz fiyat listesi): önce ÜCRETSİZ okuyucu (_shared/pdf-catalog.ts: yazı katmanı + gömülü
//     görseller, konuma göre eşleşme); okunamayan sayfalar (taranmış / karmaşık) yapay zekâyla (kota sayılır)
//   - link: product-import (Shopify / WooCommerce / ikas / Ticimax / XML: API ya da veri adresi; yoksa JSON-LD / OpenGraph / site haritası)
//   - birlikte: fiyat + stok PDF'ten, görsel + açıklama linkten; eşleşme barkod > SKU / model kodu > ad benzerliği
// Fiyat: PDF fiyatı toptan / bayi ise maliyet, satış = kâr kuralı (Ayarlar > import_rules.margin; yoksa asistan bir kez sorar)
// Kayıt: product-ingest (dedupe: aynı barkod / SKU / model kodu varsa yeni ürün açılmaz, fiyat + stok güncellenir), TASLAK
// Yayın: satıcı [Yayınla] deyince Kendi Mağazam + Varsayılan kanallar (bağlı olanlar)
// İş, sync_jobs kuyruğunda parça parça işlenir ('catalog_import'; sync-worker bu fonksiyona devreder; her parça ayrı istekte,
// Edge Function süre sınırına takılmaz). Bitince WhatsApp / Telegram'dan özet gider; panel catalog_imports'u okur.
//
// Sistem (CRON_SECRET):  { action: "run", jobId }                               -> sync-worker'dan, arka planda işler
//                        { action: "start", userId, source, linkId?, pdfPath?, pdfName?, url?, margin? }
//                        { action: "publish" | "set_margin" | "cancel", userId, importId, margin? }
// Satıcı (userAccessToken): { action: "start", pdfPath?, pdfName?, url?, margin?, channels? } (pdfPath: catalog-uploads/<uid>/...)
//                           { action: "publish", importId, channels? } | { action: "cancel", importId }
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { PDFDocument } from "npm:pdf-lib@1.17.1";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";
import { openPdf, readPages, parseRows, parsePrice, currencyOf, type PdfRow, type PageInfo } from "../_shared/pdf-catalog.ts";
import { featureEnabled, FEATURE_OFF_MSG } from "../_shared/features.ts";
import { sendReply, type Reply } from "../_shared/assistant-channels.ts";
import { channelIdsFromDefaults, connectedChannels, distributeProducts } from "../_shared/distribute.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SITE = "https://mustafabahsimb-eng.github.io/hizlisatici-ai";
const BUCKET = "catalog-uploads";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_PAGES = 100;
const PAGES_PER_CHUNK = 6;
const LINKS_PER_CHUNK = 8;
const MAX_LINK_PRODUCTS = 1000;
const SAVE_CHUNK = 10;            // küçük parçalar paralel kaydedilir (HIZ)
const PUBLISH_CHUNK = 60;
const ATTACH_MINUTES = 10;
const AI_MODELS = ["claude-sonnet-5-5", "claude-sonnet-4-6"];

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const short = (v: unknown, n = 300) => String(v ?? "").slice(0, n);
const clean = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
function background(p: Promise<unknown>) {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  const q = p.catch((e) => console.error("catalog-import", String(e)));
  if (rt?.waitUntil) rt.waitUntil(q);
}
async function fn(name: string, userId: string, payload: Record<string, unknown>, timeout = 90000): Promise<any> {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
    body: JSON.stringify({ ...payload, cronSecret: CRON_SECRET, userId }), signal: AbortSignal.timeout(timeout),
  });
  return await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
}
const money = (v: unknown, cur = "TRY") => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "–";
  try { return new Intl.NumberFormat("tr-TR", { style: "currency", currency: cur || "TRY" }).format(n); } catch { return n.toFixed(2) + " " + cur; }
};

// ---------- Kuyruk ----------
async function enqueue(userId: string, payloads: Record<string, unknown>[], priority = 4) {
  if (!payloads.length) return;
  const { error } = await db.from("sync_jobs").insert(payloads.map((p) => ({
    user_id: userId, job_type: "catalog_import", payload: p, status: "queued", priority, max_attempts: 3, run_after: new Date().toISOString(),
  })));
  if (error) throw new Error("Kuyruk: " + error.message);
  // İşçiyi hemen uyandır (tetikleyici 5 sn'de bir çalışır; adımlar arasında beklenmesin)
  background(fetch(`${SUPABASE_URL}/functions/v1/sync-worker`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON_KEY}` },
    body: JSON.stringify({ cronSecret: CRON_SECRET, chained: true }),
  }).then((r) => r.body?.cancel()));
}
async function getImp(id: string) {
  const { data } = await db.from("catalog_imports").select("*").eq("id", id).maybeSingle();
  return data;
}
const patchImp = (id: string, f: Record<string, unknown>) => db.from("catalog_imports").update({ ...f, updated_at: new Date().toISOString() }).eq("id", id);

// ---------- Yapay zekâ (yalnız ücretsiz okuyucunun okuyamadığı sayfalar) ----------
async function aiAllowed(userId: string): Promise<boolean> {
  if (!ANTHROPIC_API_KEY) return false;
  const { data, error } = await db.rpc("ai_quota_ok", { p_user: userId });
  return error ? true : data !== false;
}
async function ai(userId: string, importId: string, system: string, content: unknown[], maxTokens = 12000): Promise<{ text: string; err: string }> {
  let err = "";
  for (const model of AI_MODELS) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content }] }), signal: AbortSignal.timeout(120000),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { err = String(d?.error?.message || r.status); if (/credit balance/i.test(err)) break; continue; }
      await db.from("ai_usage_log").insert({ user_id: userId, fn: "catalog-import", units: 1, input_tokens: d?.usage?.input_tokens ?? null, output_tokens: d?.usage?.output_tokens ?? null, ref: importId });
      await db.rpc("catalog_import_bump", { p_id: importId, p_field: "ai_calls", p_by: 1 });
      return { text: (d?.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n"), err: "" };
    } catch (e) { err = String((e as Error).message || e); }
  }
  return { text: "", err };
}
const AI_SYSTEM = `You read a supplier / dealer PRICE LIST or PRODUCT CATALOGUE page (often Turkish) and extract every product.
Output ONE LINE PER PRODUCT, tab-separated, exactly these 12 columns, nothing else (no header, no markdown):
CODE<TAB>BARCODE<TAB>NAME<TAB>BRAND<TAB>PRICE<TAB>LIST_PRICE<TAB>CURRENCY<TAB>STOCK<TAB>VARIANTS<TAB>DESCRIPTION<TAB>IMAGE<TAB>BOX
- CODE: model / stock code / SKU as written. BARCODE: EAN/GTIN digits if written. NAME: product name as written (max 160 chars). Required.
- PRICE: dealer / net / wholesale price (bayi, net, alış, toptan); if only one price exists put it here. LIST_PRICE: recommended retail (PSF, tavsiye, perakende, liste) if separately given.
- CURRENCY: TRY, USD, EUR or GBP. STOCK: integer quantity if given.
- VARIANTS: if the product lists options, write them like Renk=Siyah,Beyaz;Beden=S,M,L (else empty).
- DESCRIPTION: short description if written (max 300 chars).
- IMAGE: if labelled product photos (I1, I2, ...) are given, the label of THIS product's photo; empty if none or unsure. Never assign a photo showing several products.
- BOX: only when the input is a scanned page image: the product PHOTO position on that image as x0,y0,x1,y1 in a 0-1000 scale; else empty.
Skip headers, category titles, totals, notes, contact info. Never invent products, codes or prices.
Also output ONE first line: #DOC<TAB>wholesale|retail|unknown<TAB>CURRENCY_IF_STATED (wholesale if prices are dealer / net / toptan).`;

async function aiPage(userId: string, importId: string, pdfBytes: Uint8Array, pg: PageInfo): Promise<{ rows: PdfRow[]; type: string; err: string }> {
  const src = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const one = await PDFDocument.create();
  (await one.copyPages(src, [pg.page - 1])).forEach((p) => one.addPage(p));
  const b64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
  const scan = pg.images.find((i) => i.full && i.jpeg);
  const content: unknown[] = [];
  if (scan) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64(scan.jpeg!) } }, { type: "text", text: "This is a scanned page image. Give BOX for each product photo." });
  else content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64(await one.save()) } });
  const photos = pg.images.filter((i) => !i.full && i.thumb).slice(0, 40);
  photos.forEach((im, k) => content.push({ type: "text", text: `I${k + 1}:` }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64(im.thumb!) } }));
  content.push({ type: "text", text: "Extract every product as tab-separated lines." });
  const { text, err } = await ai(userId, importId, AI_SYSTEM, content);
  if (!text) return { rows: [], type: "unknown", err };
  const rows: PdfRow[] = [];
  let type = "unknown", docCur: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const c = line.split("\t").map((x) => x.trim());
    if (c[0] === "#DOC") { type = /wholesale/.test(c[1] || "") ? "wholesale" : /retail/.test(c[1] || "") ? "retail" : "unknown"; docCur = currencyOf(c[2] || ""); continue; }
    if (c.length < 5 || !(c[2] || c[0])) continue;
    const variants = String(c[8] || "").split(";").map((p) => p.split("=")).filter((p) => p.length === 2 && p[1].trim());
    const attrsList: Record<string, string>[] = [];
    if (variants.length) {
      let combos: Record<string, string>[] = [{}];
      for (const [k, vs] of variants) combos = combos.flatMap((a) => vs.split(",").map((v) => v.trim()).filter(Boolean).slice(0, 30).map((v) => ({ ...a, [k.trim()]: v })));
      attrsList.push(...combos.slice(0, 100));
    }
    const r: PdfRow = {
      page: pg.page, name: clean(c[2] || c[0], 300), brand: clean(c[3], 80), model_code: clean(c[0], 80), sku: "", barcode: /^\d{8,14}$/.test(c[1] || "") ? c[1] : "",
      specs: [], cost: parsePrice(c[4]), list_price: parsePrice(c[5]), currency: currencyOf(c[6] || "") || docCur, stock: /^\d+$/.test(c[7] || "") ? Number(c[7]) : null,
      variants: attrsList.map((a) => ({ attributes: a })), description: clean(c[9], 1000), images: [], box: null,
    };
    if (r.cost == null && r.list_price != null) { r.cost = r.list_price; r.list_price = null; }
    const lab = (c[10] || "").match(/^I(\d+)$/i);
    if (lab && photos[Number(lab[1]) - 1]) r.images = [photos[Number(lab[1]) - 1].id];
    if (scan && c[11]) {
      const n = c[11].split(/[ ,;]+/).map(Number);
      if (n.length === 4 && n.every(Number.isFinite) && n[2] - n[0] > 30 && n[3] - n[1] > 30) {
        try {
          const im = await Image.decode(scan.jpeg!);
          const x0 = Math.round(n[0] / 1000 * im.width), y0 = Math.round(n[1] / 1000 * im.height);
          const w = Math.round((n[2] - n[0]) / 1000 * im.width), h = Math.round((n[3] - n[1]) / 1000 * im.height);
          const crop = im.crop(x0, y0, Math.max(10, w), Math.max(10, h));
          const id = `p${pg.page}-c${rows.length + 1}`;
          pg.images.push({ id, page: pg.page, box: [0, 0, 0, 0], w: crop.width, h: crop.height, jpeg: await crop.encodeJPEG(85), thumb: null });
          r.images = [id];
        } catch { /* kırpılamadı: görsel yok */ }
      }
    }
    rows.push(r);
  }
  return { rows, type, err: "" };
}

// ---------- PDF parçası ----------
async function pdfChunk(imp: any, from: number, to: number) {
  const { data: f, error } = await db.storage.from(BUCKET).download(imp.pdf_path);
  if (error || !f) throw new Error("PDF indirilemedi");
  const bytes = new Uint8Array(await f.arrayBuffer());
  const pdf = await openPdf(bytes);
  const pages = await readPages(pdf, from, to, true);
  const res = parseRows(pages);
  let rows = res.rows.filter((r) => !res.needAi.includes(r.page));
  let type = res.priceType;
  let usedAi = false;
  const failedPages: { page: number; err: string }[] = [];
  if (res.needAi.length) {
    if (await aiAllowed(imp.user_id)) {
      const out = await Promise.all(res.needAi.map((p) => aiPage(imp.user_id, imp.id, bytes, pages.find((x) => x.page === p)!)));
      out.forEach((o, i) => {
        if (o.err && !o.rows.length) failedPages.push({ page: res.needAi[i], err: o.err });
        rows = rows.concat(o.rows);
        if (o.type === "wholesale" || (type === "unknown" && o.type === "retail")) type = o.type as any;
      });
      usedAi = true;
    } else res.needAi.forEach((p) => failedPages.push({ page: p, err: ANTHROPIC_API_KEY ? "Yapay zekâ kotası doldu" : "Yapay zekâ kapalı" }));
  }
  // Kullanılan görselleri yükle (herkese açık ürün görseli deposu)
  const imgById = new Map(pages.flatMap((p) => p.images).map((i) => [i.id, i]));
  const urlOf = new Map<string, string>();
  for (const id of [...new Set(rows.flatMap((r) => r.images))]) {
    const im = imgById.get(id);
    if (!im?.jpeg) continue;
    const path = `${imp.user_id}/catalog/${imp.id}/${id}.jpg`;
    const up = await db.storage.from("product-images").upload(path, im.jpeg, { contentType: "image/jpeg", upsert: true });
    if (!up.error) urlOf.set(id, db.storage.from("product-images").getPublicUrl(path).data.publicUrl);
  }
  const ins = rows.map((r, i) => ({
    import_id: imp.id, user_id: imp.user_id, source: "pdf", page: r.page, idx: r.page * 1000 + i, name: r.name, brand: r.brand || res.brand || null,
    model_code: r.model_code || null, sku: r.sku || null, barcode: r.barcode || null, cost: r.cost, list_price: r.list_price,
    currency: r.currency || res.currency || null, stock: r.stock, variants: r.variants.length ? r.variants : null, description: r.description || null,
    specs: r.specs.length ? r.specs : null, images: r.images.map((id) => urlOf.get(id)).filter(Boolean),
  }));
  ins.push(...failedPages.map((f) => ({
    import_id: imp.id, user_id: imp.user_id, source: "pdf", page: f.page, idx: f.page * 1000 + 999, name: `Sayfa ${f.page}`, status: "error",
    error: /credit balance|kota|kapalı/i.test(f.err) ? "Taranmış / karmaşık sayfa; yapay zekâ şu an kullanılamıyor (" + short(f.err, 80) + ")" : "Sayfa okunamadı: " + short(f.err, 120),
  })) as any[]);
  // Yeniden denemede aynı sayfalar iki kez yazılmasın
  await db.from("catalog_import_rows").delete().eq("import_id", imp.id).eq("source", "pdf").gte("page", from).lte("page", to);
  for (let i = 0; i < ins.length; i += 200) {
    const { error: e } = await db.from("catalog_import_rows").insert(ins.slice(i, i + 200));
    if (e) throw new Error("Satır kaydı: " + e.message);
  }
  const pdfKind = pages.some((p) => p.images.some((i) => !i.full)) ? "images" : pages.some((p) => p.textChars < 30) ? "scan" : "text";
  const patch: Record<string, unknown> = {};
  if (type === "wholesale" || (type === "retail" && !imp.price_type)) patch.price_type = type;
  if (!imp.pdf_kind || pdfKind === "images") patch.pdf_kind = pdfKind;
  if (usedAi) patch.method = rows.length && res.rows.length ? "mixed" : "ai";
  // PDF'te yazan toptancı sitesi: görsel tamamlamada 2. kaynak
  if (res.site && !imp.distributed?.wholesalerSite) patch.distributed = { ...(imp.distributed || {}), wholesalerSite: res.site };
  if (Object.keys(patch).length) await patchImp(imp.id, patch);
  const after = await db.rpc("catalog_import_bump", { p_id: imp.id, p_field: "pdf_chunks_done", p_by: 1 });
  const a = after.data as any;
  if (a && a.pdf_chunks_done >= a.pdf_chunks) await db.from("catalog_imports").update({ pdf_status: "done" }).eq("id", imp.id).eq("pdf_status", "running");
}

// ---------- Link ----------
function rowFromItem(imp: any, it: any, idx: number) {
  const vars = (Array.isArray(it.variants) ? it.variants : []).slice(0, 100);
  return {
    import_id: imp.id, user_id: imp.user_id, source: "link", idx, name: clean(it.name, 300), brand: clean(it.brand, 80) || null,
    model_code: clean(it.model_code, 80) || null, sku: clean(vars[0]?.sku, 80) || null, barcode: /^\d{8,14}$/.test(String(it.barcode || "")) ? String(it.barcode) : null,
    cost: Number(it.price) > 0 ? Number(it.price) : null, list_price: Number(it.list_price) > 0 ? Number(it.list_price) : null, currency: it.currency || null,
    stock: Number.isFinite(Number(it.stock)) && it.stock !== null ? Number(it.stock) : null, variants: vars.length ? vars : null,
    description: clean(it.description, 5000) || null, specs: Array.isArray(it.specs) && it.specs.length ? it.specs.slice(0, 80) : null,
    images: (Array.isArray(it.images) ? it.images : []).filter((u: any) => /^https?:\/\//.test(String(u))).slice(0, 12), url: it.url || null, item: it,
  };
}
async function linkDiscover(imp: any, url: string) {
  const d = await fn("product-import", imp.user_id, { url, language: "tr" }, 110000);
  const { count } = await db.from("catalog_import_rows").select("id", { count: "exact", head: true }).eq("import_id", imp.id).eq("source", "link");
  let n = count || 0;
  if (d?.platform && !imp.link_platform) await patchImp(imp.id, { link_platform: d.platform });
  if (d?.kind === "feed") {
    const items = (d.items || []).filter((i: any) => i?.name).slice(0, MAX_LINK_PRODUCTS - n);
    if (items.length) await db.from("catalog_import_rows").insert(items.map((it: any) => rowFromItem(imp, it, n++)));
    if (d.next_page && n < MAX_LINK_PRODUCTS) { await enqueue(imp.user_id, [{ importId: imp.id, step: "link", url: d.next_page }]); return; }
    await finishLink(imp.id, "done");
  } else if (d?.kind === "category") {
    const links = [...new Set((d.links || []).map(String))].slice(0, 3000);
    await patchImp(imp.id, { pending_links: links, link_platform: imp.link_platform || d.platform || "sitemap" });
    await finishLink(imp.id, "links");
  } else if (d?.kind === "product" && d.item?.name) {
    await db.from("catalog_import_rows").insert(rowFromItem(imp, d.item, n));
    await finishLink(imp.id, "done");
  } else {
    await patchImp(imp.id, { error: "Link okunamadı: " + short(d?.error || "ürün bulunamadı", 200) });
    await finishLink(imp.id, "failed");
  }
}
async function finishLink(id: string, status: string) {
  await db.from("catalog_imports").update({ link_status: status, updated_at: new Date().toISOString() }).eq("id", id).in("link_status", ["discover", "pages"]);
}
async function linkPages(imp: any, links: string[], base: number) {
  const out = await Promise.all(links.map((l) => fn("product-import", imp.user_id, { url: l, language: "tr" }, 60000).catch(() => null)));
  const rows = out.map((d, i) => d?.kind === "product" && d.item?.name ? rowFromItem(imp, d.item, base + i) : null).filter(Boolean);
  await db.from("catalog_import_rows").delete().eq("import_id", imp.id).eq("source", "link").gte("idx", base).lt("idx", base + links.length);
  if (rows.length) await db.from("catalog_import_rows").insert(rows as any[]);
  const after = await db.rpc("catalog_import_bump", { p_id: imp.id, p_field: "link_chunks_done", p_by: 1 });
  const a = after.data as any;
  if (a && a.link_chunks_done >= a.link_chunks) await finishLink(imp.id, "done");
}

// ---------- Eşleştirme (barkod > SKU / model > ad benzerliği) ----------
const norm = (s: unknown) => String(s ?? "").toLocaleLowerCase("tr").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i")
  .replace(/&#0?38;|&amp;/g, "&").replace(/[^a-z0-9]+/g, " ").trim();
const codeKey = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const tokens = (s: unknown) => new Set(norm(s).split(" ").filter((t) => t.length >= 2 && !["the", "ve", "ile", "set", "adet"].includes(t)));
export function nameSim(a: unknown, b: unknown): number {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((t) => { if (B.has(t)) inter++; });
  return (2 * inter) / (A.size + B.size);
}
function rowBarcodes(r: any): string[] {
  return [r.barcode, ...((r.variants || []) as any[]).map((v) => v?.barcode)].map((x) => String(x || "")).filter((x) => /^\d{8,14}$/.test(x));
}
function rowCodes(r: any): string[] {
  return [r.model_code, r.sku, ...((r.variants || []) as any[]).map((v) => v?.sku)].map(codeKey).filter((x) => x.length >= 3);
}
export function matchRows(pdf: any[], link: any[]): Map<number, { link: any; by: string }> {
  const out = new Map<number, { link: any; by: string }>();
  const used = new Set<number>();
  const take = (p: any, l: any, by: string) => { out.set(p.id, { link: l, by }); used.add(l.id); };
  const byBarcode = new Map<string, any>(), byCode = new Map<string, any>();
  for (const l of link) { rowBarcodes(l).forEach((b) => byBarcode.set(b, l)); rowCodes(l).forEach((c) => byCode.set(c, l)); }
  for (const p of pdf) { const l = rowBarcodes(p).map((b) => byBarcode.get(b)).find((x) => x && !used.has(x.id)); if (l) take(p, l, "barcode"); }
  for (const p of pdf) { if (out.has(p.id)) continue; const l = rowCodes(p).map((c) => byCode.get(c)).find((x) => x && !used.has(x.id)); if (l) take(p, l, "sku"); }
  const pairs: { p: any; l: any; s: number }[] = [];
  for (const p of pdf) {
    if (out.has(p.id)) continue;
    for (const l of link) {
      if (used.has(l.id)) continue;
      let s = nameSim(p.name, l.name);
      if (p.brand && l.brand && norm(p.brand) !== norm(l.brand) && !norm(l.name).includes(norm(p.brand))) s -= 0.15;
      if (s >= 0.55) pairs.push({ p, l, s });
    }
  }
  pairs.sort((a, b) => b.s - a.s);
  for (const x of pairs) if (!out.has(x.p.id) && !used.has(x.l.id)) take(x.p, x.l, "name");
  return out;
}
// Site haritasındaki linklerden PDF ürünlerine benzeyenler (her ürün için en iyi 2)
function pickLinks(links: string[], pdfRows: any[]): string[] {
  const slug = (u: string) => { try { return decodeURIComponent(new URL(u).pathname).replace(/[-_/.]+/g, " "); } catch { return u; } };
  const pick = new Set<string>();
  for (const r of pdfRows) {
    const scored = links.map((l) => {
      const s = slug(l);
      const code = rowCodes(r).some((c) => codeKey(s).includes(c)) ? 1 : 0;
      return { l, s: Math.max(code, nameSim(r.name, s)) };
    }).filter((x) => x.s >= 0.34).sort((a, b) => b.s - a.s).slice(0, 2);
    scored.forEach((x) => pick.add(x.l));
    if (pick.size >= 300) break;
  }
  return [...pick];
}

// ---------- İlerleme: kaynaklar bitti mi? ----------
async function advance(id: string) {
  const imp = await getImp(id);
  if (!imp || !["parsing"].includes(imp.status)) return;
  if (imp.pdf_status === "running") return;
  if (["discover", "pages"].includes(imp.link_status)) return;
  if (imp.link_status === "links") {
    const all: string[] = Array.isArray(imp.pending_links) ? imp.pending_links : [];
    const { data: pdfRows } = await db.from("catalog_import_rows").select("id, name, model_code, sku, variants").eq("import_id", id).eq("source", "pdf").neq("status", "error");
    const chosen = pdfRows?.length ? pickLinks(all, pdfRows) : all.slice(0, MAX_LINK_PRODUCTS);
    const { data: ok } = await db.from("catalog_imports").update({ link_status: "pages", link_chunks: Math.ceil(chosen.length / LINKS_PER_CHUNK), link_chunks_done: 0, pending_links: null })
      .eq("id", id).eq("link_status", "links").select("id");
    if (!ok?.length) return;
    if (!chosen.length) { await finishLink(id, "done"); return advance(id); }
    const jobs = [];
    for (let i = 0; i < chosen.length; i += LINKS_PER_CHUNK) jobs.push({ importId: id, step: "links", links: chosen.slice(i, i + LINKS_PER_CHUNK), base: 100000 + i });
    await enqueue(imp.user_id, jobs);
    return;
  }
  // Birleştirme hafif: kuyruğa koymadan hemen (bu parçanın isteğinde)
  const { data: moved } = await db.rpc("catalog_import_step", { p_id: id, p_from: ["parsing"], p_to: "merging" });
  if (moved) {
    try { await merge(await getImp(id)); }
    catch (e) { console.error("merge", String(e)); await enqueue(imp.user_id, [{ importId: id, step: "merge" }], 3); } // kuyrukta yeniden denenir
  }
}

// ---------- Birleştir + fiyat + kayda böl ----------
async function margin(imp: any): Promise<number | null> {
  if (imp.margin != null) return Number(imp.margin);
  const { data } = await db.from("import_rules").select("rules").eq("user_id", imp.user_id).maybeSingle();
  const m = data?.rules?.margin;
  return m != null && m !== "" && Number.isFinite(Number(m)) ? Number(m) : null;
}
async function merge(imp: any) {
  const { data: rows } = await db.from("catalog_import_rows").select("*").eq("import_id", imp.id).neq("status", "error").order("idx").limit(5000);
  const pdf = (rows || []).filter((r: any) => r.source === "pdf");
  const link = (rows || []).filter((r: any) => r.source === "link");
  // Önceki birleştirmeden kalan bayrakları sıfırla (ikinci kaynak sonradan eklendiyse)
  await db.from("catalog_import_rows").update({ final: false, merged_from: null }).eq("import_id", imp.id).in("status", ["new", "ok", "missing", "unmatched", "created", "updated"]);
  const finals: any[] = [];
  if (pdf.length && link.length) {
    const m = matchRows(pdf, link);
    for (const p of pdf) {
      const hit = m.get(p.id);
      const l = hit?.link;
      const f: any = { id: p.id, final: true, merged_from: l?.id ?? null };
      if (l) {
        if ((l.images || []).length) f.images = [...l.images, ...(p.images || [])].slice(0, 12);
        if (l.description && String(l.description).length > String(p.description || "").length) f.description = l.description;
        f.specs = [...(l.specs || []), ...(p.specs || [])].slice(0, 80);
        if (!p.brand && l.brand) f.brand = l.brand;
        if (!p.barcode && l.barcode) f.barcode = l.barcode;
        if (!(p.variants || []).length && (l.variants || []).length) f.variants = (l.variants as any[]).map((v) => ({ ...v, price: null, stock: null }));
        f.url = l.url;
        if (l.product_id && !p.product_id) f.product_id = l.product_id; // önce yalnız linkle kaydedilmişse aynı ürün güncellenir
      }
      finals.push({ ...p, ...f });
    }
    const usedLinks = new Set(finals.map((f) => f.merged_from).filter(Boolean));
    const unmatched = link.filter((l: any) => !usedLinks.has(l.id)).map((l: any) => l.id);
    for (let i = 0; i < unmatched.length; i += 500) await db.from("catalog_import_rows").update({ status: "unmatched", final: false }).in("id", unmatched.slice(i, i + 500));
  } else finals.push(...(pdf.length ? pdf : link).map((r: any) => ({ ...r, final: true })));

  // Eksikler
  for (const f of finals) {
    const probs: string[] = [];
    if (!f.name || f.name.length < 3) probs.push("Ad okunamadı");
    if (!(Number(f.cost) > 0) && !(Number(f.list_price) > 0)) probs.push("Fiyat yok");
    if (!(f.images || []).length) probs.push("Görsel yok (arka planda aranıyor)");
    f.problems = probs;
    if (!["created", "updated"].includes(f.status)) f.status = probs.length ? "missing" : "ok";
  }
  // Satır başına güncelleme (geçici hata olursa yeniden dene; satır özetten düşmesin) + toplu "final" işareti
  const retry = async (q: () => PromiseLike<{ error: any }>) => {
    for (let k = 0; k < 3; k++) { const { error } = await q(); if (!error) return; await new Promise((r) => setTimeout(r, 400 * (k + 1))); }
    throw new Error("Satır güncellenemedi");
  };
  for (let i = 0; i < finals.length; i += 20) {
    await Promise.all(finals.slice(i, i + 20).map((f) => retry(() => db.from("catalog_import_rows").update({
      final: true, merged_from: f.merged_from ?? null, images: f.images || [], description: f.description ?? null, specs: f.specs ?? null, brand: f.brand ?? null,
      barcode: f.barcode ?? null, variants: f.variants ?? null, url: f.url ?? null, problems: f.problems, status: f.status, product_id: f.product_id ?? null,
    }).eq("id", f.id))));
  }
  const ids = finals.map((f) => f.id);
  for (let i = 0; i < ids.length; i += 500) await retry(() => db.from("catalog_import_rows").update({ final: true }).in("id", ids.slice(i, i + 500)));
  if (!finals.length) {
    await recount(imp.id, { status: "failed", error: imp.error || "Ürün bulunamadı", finished_at: new Date().toISOString() });
    await notify(imp.id);
    return;
  }
  const needMargin = pdf.length > 0 && imp.price_type !== "retail";
  const mg = await margin(imp);
  if (needMargin && mg == null && imp.source !== "panel") {
    await patchImp(imp.id, { status: "need_margin", found: finals.length });
    await askMargin(imp);
    return;
  }
  await patchImp(imp.id, { margin: mg ?? 30 });
  await startSave(imp.id, finals.map((f) => f.id));
}
async function startSave(id: string, rowIds: number[]) {
  const imp = await getImp(id);
  const chunks: number[][] = [];
  for (let i = 0; i < rowIds.length; i += SAVE_CHUNK) chunks.push(rowIds.slice(i, i + SAVE_CHUNK));
  await patchImp(id, { status: "saving", save_chunks: chunks.length, save_chunks_done: 0, found: rowIds.length });
  await enqueue(imp.user_id, chunks.map((ids) => ({ importId: id, step: "save", rowIds: ids })), 3);
}
async function save(imp: any, rowIds: number[]) {
  const { data: rows } = await db.from("catalog_import_rows").select("*").in("id", rowIds).order("idx");
  const list = rows || [];
  const retail = imp.price_type === "retail";
  const site = imp.distributed?.wholesalerSite || null;
  const items = list.map((r: any) => ({
    name: r.name, brand: r.brand || "", model_code: r.model_code || "", sku: r.sku || "", barcode: r.barcode || "",
    price: retail ? null : (Number(r.cost) > 0 ? Number(r.cost) : null),
    list_price: Number(r.list_price) > 0 ? Number(r.list_price) : null,
    sale_price: retail ? (Number(r.cost) > 0 ? Number(r.cost) : Number(r.list_price) > 0 ? Number(r.list_price) : null) : null,
    currency: r.currency || "TRY", stock: r.stock, images: r.images || [], specs: r.specs || [], description: r.description || "",
    variants: (r.variants || []).filter((v: any) => v?.attributes && Object.keys(v.attributes).length).map((v: any) => ({
      attributes: v.attributes, sku: v.sku || null, barcode: v.barcode || null, price: retail ? null : (Number(v.price) > 0 ? Number(v.price) : r.cost), stock: v.stock ?? null, image: v.image || null,
      supplier_variant_id: v.supplier_variant_id || null,
    })),
    url: r.url || "", source_platform: r.source === "link" && !r.merged_from ? (r.item?.source_platform || "web") : null, source_item_id: r.item?.source_item_id || null,
    existing_id: r.product_id || null,
    imgSrc: r.merged_from || r.source === "link" ? { kind: "link", url: r.url || imp.link_url } : { kind: "catalog_pdf", url: null },
  }));
  const res = await fn("product-ingest", imp.user_id, {
    items, via: "catalog-import:" + imp.source, publish: false, dedupe: true, margin: imp.margin, consent: true, imageTerms: true, sync: false,
    aeSource: "own", sourceUrl: imp.link_url || imp.pdf_name || "pdf", wholesalerSite: site,
  }, 140000);
  if (res?.ok) {
    const prods: any[] = res.products || [];
    for (let i = 0; i < list.length; i++) {
      const p = prods[i];
      if (!p) { await db.from("catalog_import_rows").update({ status: "error", error: "Kaydedilemedi" }).eq("id", list[i].id); continue; }
      await db.from("catalog_import_rows").update({ product_id: p.id, status: p.action === "updated" ? "updated" : "created", sale_price: p.sale_price ?? null }).eq("id", list[i].id);
    }
  } else {
    await db.from("catalog_import_rows").update({ status: "error", error: short(res?.error || "Kaydedilemedi", 200) }).in("id", rowIds);
  }
  const after = await db.rpc("catalog_import_bump", { p_id: imp.id, p_field: "save_chunks_done", p_by: 1 });
  const a = after.data as any;
  if (a && a.save_chunks_done >= a.save_chunks) {
    const { data: ok } = await db.rpc("catalog_import_step", { p_id: imp.id, p_from: ["saving"], p_to: "ready" });
    if (ok) { await recount(imp.id, { finished_at: new Date().toISOString() }); await notify(imp.id); }
  }
}
async function recount(id: string, extra: Record<string, unknown> = {}) {
  const { data: rs } = await db.from("catalog_import_rows").select("status, final, problems").eq("import_id", id).limit(5000);
  const fin = (rs || []).filter((r: any) => r.final);
  const c = (s: string) => fin.filter((r: any) => r.status === s).length;
  await patchImp(id, {
    ...extra, found: fin.length, created: c("created"), updated: c("updated"),
    failed: (rs || []).filter((r: any) => r.status === "error").length, missing: fin.filter((r: any) => (r.problems || []).length).length,
  });
}

// ---------- Yayın ----------
async function publishChunk(imp: any, ids: number[]) {
  const now = new Date().toISOString();
  const { data: ps } = await db.from("products").select("id, name, generated_title, generated_description, sale_price, cost_currency").in("id", ids).eq("user_id", imp.user_id).is("deleted_at", null);
  for (const p of ps || []) {
    let price = Number(p.sale_price) || 0;
    if (!(price > 0)) continue; // fiyatsız ürün yayınlanmaz
    if (p.cost_currency && p.cost_currency !== "TRY") {
      const { data: k } = await db.rpc("fx_rate", { p_from: p.cost_currency, p_to: "TRY", p_date: null });
      if (k) price = Math.round(price * Number(k) * 100) / 100;
    }
    const { data: ex } = await db.from("listings").select("id").eq("product_id", p.id).eq("marketplace_code", "own_store").maybeSingle();
    if (ex) await db.from("listings").update({ status: "published", price, published_at: now }).eq("id", ex.id);
    else {
      const li = await db.from("listings").insert({
        user_id: imp.user_id, product_id: p.id, source_product_id: p.id, marketplace_code: "own_store", language: "tr", currency: "TRY",
        title: p.generated_title || p.name, description: p.generated_description || "", keywords: [], category_key: null, price, commission_pct: 0, vat_payer: "seller",
        price_mode: "manual", status: "published", published_at: now,
      }).select("id").single();
      const { data: dv } = await db.from("product_variants").select("id").eq("product_id", p.id).eq("is_default", true).maybeSingle();
      if (li.data && dv) await db.from("listing_variants").insert({ listing_id: li.data.id, variant_id: dv.id, user_id: imp.user_id, price, status: "published" });
    }
    await db.from("products").update({ store_visible: true }).eq("id", p.id);
  }
  const after = await db.rpc("catalog_import_bump", { p_id: imp.id, p_field: "publish_chunks_done", p_by: 1 });
  const a = after.data as any;
  if (a && a.publish_chunks_done >= a.publish_chunks) {
    const { data: ok } = await db.rpc("catalog_import_step", { p_id: imp.id, p_from: ["publishing"], p_to: "published" });
    if (!ok) return;
    // Diğer kanallar: panelde seçilen ya da asistandaki Varsayılan kanallar (bağlı olanlar)
    const all = await productIds(imp.id, true);
    let dist: Record<string, unknown> = {};
    try {
      if (all.length && await featureEnabled(imp.user_id, "multi_channel")) {
        const ch = await connectedChannels(db, imp.user_id);
        let want: string[] = Array.isArray(imp.distributed?.channels) ? imp.distributed.channels : [];
        let missing: string[] = [];
        if (!want.length) {
          const { data: st } = await db.from("assistant_settings").select("default_channels").eq("user_id", imp.user_id).maybeSingle();
          const r = channelIdsFromDefaults(ch, (st?.default_channels || ["own_store"]).filter((c: string) => c !== "own_store"));
          want = r.ids; missing = r.missing;
        }
        dist = { sent: want.length ? await distributeProducts(db, imp.user_id, all, want) : {}, missing };
      }
    } catch (e) { dist = { error: short((e as Error).message, 200) }; }
    await patchImp(imp.id, { published_at: new Date().toISOString(), distributed: { ...(imp.distributed || {}), ...dist } });
    await notify(imp.id);
  }
}
async function productIds(id: string, priced = false): Promise<number[]> {
  const { data } = await db.from("catalog_import_rows").select("product_id, sale_price").eq("import_id", id).eq("final", true).not("product_id", "is", null).limit(5000);
  return [...new Set((data || []).filter((r: any) => !priced || Number(r.sale_price) > 0).map((r: any) => Number(r.product_id)))];
}
async function publish(userId: string, importId: string, channels?: string[]) {
  const imp = await getImp(importId);
  if (!imp || imp.user_id !== userId) return { ok: false, error: "Yükleme bulunamadı" };
  if (imp.status === "published") return { ok: true, already: true };
  if (imp.status !== "ready") return { ok: false, error: "Yükleme henüz hazır değil (" + imp.status + ")" };
  const ids = await productIds(importId);
  if (!ids.length) return { ok: false, error: "Yayınlanacak ürün yok" };
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += PUBLISH_CHUNK) chunks.push(ids.slice(i, i + PUBLISH_CHUNK));
  const { data: ok } = await db.rpc("catalog_import_step", { p_id: importId, p_from: ["ready"], p_to: "publishing" });
  if (!ok) return { ok: true, already: true };
  await patchImp(importId, { publish_chunks: chunks.length, publish_chunks_done: 0, notified_at: null,
    distributed: { ...(imp.distributed || {}), ...(Array.isArray(channels) && channels.length ? { channels: channels.map(String) } : {}) } });
  await enqueue(userId, chunks.map((c) => ({ importId, step: "publish", productIds: c })), 2);
  return { ok: true, products: ids.length };
}

// ---------- Bildirim (asistan) ----------
async function target(imp: any) {
  if (!imp.link_id) return null;
  const { data } = await db.from("assistant_links").select("*").eq("id", imp.link_id).maybeSingle();
  return data;
}
async function say(imp: any, rep: Reply) {
  const t = await target(imp);
  if (t) await sendReply(db, t, rep);
}
async function askMargin(imp: any) {
  await say(imp, {
    text: `📄 Ürünleri okudum. PDF'teki fiyatlar toptan (alış) fiyatı; satış fiyatını hesaplamam için kâr oranını bir kez söyler misin?\nÖrn. "%40" yaz ya da seç. (Ayarlar'a kaydederim, bir daha sormam.)`,
    buttons: [{ id: `cimp_m:${imp.id}:30`, title: "%30" }, { id: `cimp_m:${imp.id}:50`, title: "%50" }, { id: `cimp_m:${imp.id}:100`, title: "%100" }],
  });
  if (imp.link_id) {
    const { data: s } = await db.from("assistant_sessions").select("state").eq("link_id", imp.link_id).maybeSingle();
    await db.from("assistant_sessions").upsert({ link_id: imp.link_id, state: { ...(s?.state || {}), awaitImportMargin: imp.id }, updated_at: new Date().toISOString() });
  }
}
async function setMargin(userId: string, importId: string, m: number) {
  const imp = await getImp(importId);
  if (!imp || imp.user_id !== userId) return { ok: false, error: "Yükleme bulunamadı" };
  if (!(m >= 0 && m <= 1000)) return { ok: false, error: "Geçersiz oran" };
  const { data: r } = await db.from("import_rules").select("rules").eq("user_id", userId).maybeSingle();
  await db.from("import_rules").upsert({ user_id: userId, rules: { ...(r?.rules || {}), margin: m }, updated_at: new Date().toISOString() });
  await patchImp(importId, { margin: m });
  if (imp.status === "need_margin") {
    const { data: rows } = await db.from("catalog_import_rows").select("id").eq("import_id", importId).eq("final", true).limit(5000);
    await startSave(importId, (rows || []).map((x: any) => x.id));
    return { ok: true, saving: true };
  }
  return { ok: true };
}
async function notify(id: string) {
  const imp = await getImp(id);
  if (!imp || imp.notified_at) return;
  const { data: claimed } = await db.from("catalog_imports").update({ notified_at: new Date().toISOString() }).eq("id", id).is("notified_at", null).select("id");
  if (!claimed?.length || !imp.link_id) return;
  const panel = { title: "Panelde kontrol et", url: `${SITE}/toplu-yukleme.html?import=${id}` };
  const from = [imp.pdf_name ? "📄 " + short(imp.pdf_name, 40) : "", imp.link_url ? "🔗 " + short(hostOf(imp.link_url), 40) : ""].filter(Boolean).join(" + ");
  if (imp.status === "failed") return say(imp, { text: `${from}: ürün bulamadım. ${short(imp.error || "", 200)}\nFiyat listesi / katalog PDF'i ya da mağaza linki olduğundan emin misin?`, link: panel });
  if (imp.status === "published") {
    const d = imp.distributed || {};
    // Sandbox / test bağlantıları satıcıya gösterilmez; yalnız canlı kanallar yazılır
    const sent = Object.entries(d.sent || {}).filter(([k, v]: [string, any]) => !v?.test && !/sandbox|\btest\b/i.test(k)).map(([k, v]: [string, any]) => v?.listings != null ? `${k}: ${v.listings} ilan` : v?.queued != null ? `${k}: ${v.queued} paylaşım` : v?.error ? `${k}: ${short(v.error, 60)}` : "").filter(Boolean);
    const ids = await productIds(id, true);
    const all = await productIds(id);
    return say(imp, {
      text: `✅ ${ids.length} ürün Kendi Mağazam'da yayında.` + (sent.length ? `\n📤 Diğer kanallar: ${sent.join(" · ")}` : "") +
        ((d.missing || []).length ? `\nℹ️ ${(d.missing as string[]).join(", ")} bağlı değil; Hesaplarım'dan bağlayınca oraya da gönderirim.` : "") +
        (all.length > ids.length ? `\n⚠️ Fiyatı olmayan ${all.length - ids.length} ürün yayınlanmadı; panelden fiyat girebilirsin.` : ""),
      link: { title: "Ürünlerim", url: `${SITE}/dashboard.html` },
    });
  }
  // Hazır: özet + [Yayınla] [Panelde kontrol et]
  const { data: rs } = await db.from("catalog_import_rows").select("name, sale_price, currency, problems, status").eq("import_id", id).eq("final", true).order("idx").limit(5000);
  const list = rs || [];
  const miss = list.filter((r: any) => (r.problems || []).length);
  const cnt = (p: string) => miss.filter((r: any) => (r.problems || []).some((x: string) => x.startsWith(p))).length;
  const parts = [cnt("Görsel") ? `${cnt("Görsel")} görsel yok (arka planda aranıyor)` : "", cnt("Fiyat") ? `${cnt("Fiyat")} fiyat yok` : "", cnt("Ad") ? `${cnt("Ad")} ad okunamadı` : ""].filter(Boolean);
  const lines = list.slice(0, 10).map((r: any, i: number) => `${i + 1}. ${short(r.name, 50)} — ${money(r.sale_price, r.currency || "TRY")}`);
  const kar = imp.price_type === "retail" ? "Fiyatlar PDF'teki satış fiyatı." : `Kâr: alışın üstüne %${Number(imp.margin ?? 30)}.`;
  const errs = imp.failed ? `\n⚠️ ${imp.failed} satır / sayfa okunamadı (panelde görürsün).` : "";
  // Önce oturum durumu ("%45" ile fiyat düzenleme), sonra mesaj: satıcı hemen cevap verirse kaçmasın
  if (imp.link_id) {
    const ids = await productIds(id);
    const { data: s } = await db.from("assistant_sessions").select("state").eq("link_id", imp.link_id).maybeSingle();
    await db.from("assistant_sessions").upsert({ link_id: imp.link_id, state: { ...(s?.state || {}), lastImport: id, awaitPriceEdit: ids, awaitPublish: null }, updated_at: new Date().toISOString() });
  }
  await say(imp, {
    text: `${from}\n${list.length} ürün bulundu (${imp.created} yeni, ${imp.updated} güncellendi)` + (miss.length ? `, ${miss.length}'inde eksik bilgi var: ${parts.join(", ")}.` : ", hepsi tam.") +
      `\n${kar}\n\n${lines.join("\n")}${list.length > 10 ? `\n… ve ${list.length - 10} ürün daha` : ""}${errs}\n\nFarklı kâr için "%45" yazabilirsin.`,
    buttons: [{ id: `cimp_pub:${id}`, title: "Yayınla" }, { id: `cimp_panel:${id}`, title: "Panelde kontrol et" }],
    link: panel,
  });
}
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

// ---------- Başlat ----------
function safeUrl(raw: string): string | null {
  let s = String(raw || "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return null;
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(u.hostname) || u.hostname.endsWith(".internal")) return null;
    return u.href;
  } catch { return null; }
}
export async function start(userId: string, o: { source: string; linkId?: string | null; pdfPath?: string | null; pdfName?: string | null; url?: string | null; margin?: number | null; channels?: string[] }) {
  if (!(await featureEnabled(userId, "pdf_link_import"))) return { ok: false, error: FEATURE_OFF_MSG, feature: "pdf_link_import" };
  const url = o.url ? safeUrl(o.url) : null;
  if (o.url && !url) return { ok: false, error: "Geçerli bir web adresi yaz (ör. www.siten.com)." };
  if (!o.pdfPath && !url) return { ok: false, error: "PDF ya da link gerekli." };
  const { data: r1 } = await db.rpc("rate_hit", { p_key: "cimp:h:" + userId, p_limit: 30, p_window_seconds: 3600 });
  const { data: r2 } = await db.rpc("rate_hit", { p_key: "cimp:d:" + userId, p_limit: 150, p_window_seconds: 86400 });
  if (r1 === false || r2 === false) return { ok: false, error: "Çok sık yükleme yaptın; biraz sonra tekrar dene (saatte en fazla 30, günde 150).", limited: true };

  let pages = 0;
  if (o.pdfPath) {
    if (!String(o.pdfPath).startsWith(userId + "/")) return { ok: false, error: "Geçersiz dosya" };
    const { data: f, error } = await db.storage.from(BUCKET).download(o.pdfPath);
    if (error || !f) return { ok: false, error: "PDF bulunamadı" };
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (bytes.length > MAX_PDF_BYTES) return { ok: false, error: "PDF çok büyük (en fazla 20 MB)." };
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") return { ok: false, error: "Yalnız PDF dosyası kabul edilir." };
    try { pages = (await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })).getPageCount(); }
    catch { return { ok: false, error: "PDF açılamadı (bozuk ya da şifreli olabilir)." }; }
    if (pages > MAX_PAGES) return { ok: false, error: `PDF en fazla ${MAX_PAGES} sayfa olabilir (bu dosya ${pages} sayfa). Bölüp ayrı gönder.` };
  }

  // Asistanda 10 dk içinde gelen ikinci kaynak (PDF + link) aynı yüklemeye eklenir
  let imp: any = null;
  if (o.linkId && !(o.pdfPath && url)) { // ikisi birlikte geldiyse kendi başına tam bir yükleme
    const since = new Date(Date.now() - ATTACH_MINUTES * 60_000).toISOString();
    const { data: open } = await db.from("catalog_imports").select("*").eq("user_id", userId).eq("link_id", o.linkId)
      .in("status", ["parsing", "merging", "need_margin", "saving", "ready"]).gt("created_at", since).order("created_at", { ascending: false }).limit(1);
    const c = open?.[0];
    if (c && ((o.pdfPath && !c.pdf_path) || (url && !c.link_url))) imp = c;
  }
  let attached = false;
  if (imp) {
    attached = true;
    const patch: any = { status: "parsing", notified_at: null, finished_at: null };
    if (o.pdfPath) Object.assign(patch, { pdf_path: o.pdfPath, pdf_name: o.pdfName || "katalog.pdf", pdf_pages: pages, pdf_status: "running", pdf_chunks: Math.ceil(pages / PAGES_PER_CHUNK), pdf_chunks_done: 0 });
    if (url) Object.assign(patch, { link_url: url, link_status: "discover" });
    await patchImp(imp.id, patch);
  } else {
    const ins = await db.from("catalog_imports").insert({
      user_id: userId, source: o.source, link_id: o.linkId || null, status: "parsing", margin: o.margin ?? null, method: "free",
      pdf_path: o.pdfPath || null, pdf_name: o.pdfPath ? (o.pdfName || "katalog.pdf") : null, pdf_pages: pages || null,
      pdf_status: o.pdfPath ? "running" : "none", pdf_chunks: o.pdfPath ? Math.ceil(pages / PAGES_PER_CHUNK) : 0,
      link_url: url, link_status: url ? "discover" : "none", distributed: o.channels?.length ? { channels: o.channels } : null,
    }).select("*").single();
    if (ins.error) return { ok: false, error: ins.error.message };
    imp = ins.data;
  }
  const jobs: Record<string, unknown>[] = [];
  if (o.pdfPath) for (let p = 1; p <= pages; p += PAGES_PER_CHUNK) jobs.push({ importId: imp.id, step: "pdf", from: p, to: Math.min(pages, p + PAGES_PER_CHUNK - 1) });
  if (url) jobs.push({ importId: imp.id, step: "link", url });
  await enqueue(userId, jobs);
  return { ok: true, importId: imp.id, attached, pages, chunks: jobs.length };
}

// ---------- İş çalıştırıcı (sync-worker'dan) ----------
async function runJob(jobId: string) {
  const { data: job } = await db.from("sync_jobs").select("*").eq("id", jobId).maybeSingle();
  if (!job || job.job_type !== "catalog_import" || job.status !== "running") return;
  const p = job.payload || {};
  try {
    const imp = await getImp(String(p.importId || ""));
    if (!imp || imp.status === "cancelled") { await db.rpc("complete_sync_job", { p_job_id: jobId, p_result: { skipped: "no_import" } }); return; }
    if (p.step === "pdf") { await pdfChunk(imp, Number(p.from), Number(p.to)); await advance(imp.id); }
    else if (p.step === "link") { await linkDiscover(imp, String(p.url)); await advance(imp.id); }
    else if (p.step === "links") { await linkPages(imp, (p.links || []).map(String), Number(p.base) || 0); await advance(imp.id); }
    else if (p.step === "merge") await merge(imp);
    else if (p.step === "save") await save(imp, (p.rowIds || []).map(Number));
    else if (p.step === "publish") await publishChunk(imp, (p.productIds || []).map(Number));
    await db.rpc("complete_sync_job", { p_job_id: jobId, p_result: { ok: true, step: p.step } });
  } catch (e) {
    const msg = short((e as Error).message || e, 400);
    console.error("catalog-import job", p.step, msg);
    await db.rpc("fail_sync_job", { p_job_id: jobId, p_error: msg });
    // Son deneme de başarısızsa yüklemeyi takılı bırakma
    if (job.attempts >= job.max_attempts && p.importId) {
      if (p.step === "pdf") {
        await db.from("catalog_import_rows").insert({ import_id: p.importId, user_id: job.user_id, source: "pdf", page: p.from, idx: Number(p.from) * 1000 + 998, name: `Sayfa ${p.from}-${p.to}`, status: "error", error: "Okunamadı: " + short(msg, 150) });
        const after = await db.rpc("catalog_import_bump", { p_id: p.importId, p_field: "pdf_chunks_done", p_by: 1 });
        const a = after.data as any;
        if (a && a.pdf_chunks_done >= a.pdf_chunks) await db.from("catalog_imports").update({ pdf_status: "done" }).eq("id", p.importId).eq("pdf_status", "running");
        await advance(p.importId);
      } else if (p.step === "link" || p.step === "links") {
        if (p.step === "links") await db.rpc("catalog_import_bump", { p_id: p.importId, p_field: "link_chunks_done", p_by: 1 });
        await finishLink(p.importId, p.step === "link" ? "failed" : "done");
        await advance(p.importId);
      } else {
        await patchImp(p.importId, { status: "failed", error: short(msg, 300), finished_at: new Date().toISOString() });
        await notify(p.importId);
      }
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const b = await req.json().catch(() => ({}));
  try {
    if (CRON_SECRET && String(b?.cronSecret || "").trim() === CRON_SECRET.trim()) {
      if (b.action === "run" && b.jobId) { background(runJob(String(b.jobId))); return json({ ok: true, accepted: true }, 202); }
      const uid = String(b.userId || "");
      if (!/^[0-9a-f-]{36}$/i.test(uid)) return json({ error: "userId gerekli" }, 400);
      if (b.action === "start") return json(await start(uid, { source: b.source || "test", linkId: b.linkId || null, pdfPath: b.pdfPath || null, pdfName: b.pdfName || null, url: b.url || null, margin: b.margin ?? null }));
      if (b.action === "publish") return json(await publish(uid, String(b.importId), b.channels));
      if (b.action === "set_margin") return json(await setMargin(uid, String(b.importId), Number(b.margin)));
      if (b.action === "cancel") { await db.from("catalog_imports").update({ status: "cancelled" }).eq("id", String(b.importId)).eq("user_id", uid).not("status", "in", "(published,publishing)"); return json({ ok: true }); }
      return json({ error: "Geçersiz işlem" }, 400);
    }
    const token = String(b?.userAccessToken || "").trim();
    const { data } = token ? await db.auth.getUser(token) : { data: { user: null } };
    const userId = data?.user?.id;
    if (!userId) return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);
    if (b.action === "start") {
      const m = b.margin != null && b.margin !== "" && Number.isFinite(Number(b.margin)) ? Math.max(0, Math.min(1000, Number(b.margin))) : null;
      return json(await start(userId, { source: "panel", pdfPath: b.pdfPath || null, pdfName: clean(b.pdfName, 120) || null, url: b.url || null, margin: m, channels: Array.isArray(b.channels) ? b.channels : [] }));
    }
    if (b.action === "publish") return json(await publish(userId, String(b.importId), b.channels));
    if (b.action === "set_margin") return json(await setMargin(userId, String(b.importId), Number(b.margin)));
    if (b.action === "cancel") { await db.from("catalog_imports").update({ status: "cancelled" }).eq("id", String(b.importId)).eq("user_id", userId).not("status", "in", "(published,publishing)"); return json({ ok: true }); }
    return json({ error: "Geçersiz işlem" }, 400);
  } catch (e) {
    return json({ ok: false, error: short((e as Error).message) }, 500);
  }
});
