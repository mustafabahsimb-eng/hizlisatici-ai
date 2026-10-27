// =========================================================
// Seltigo - PDF katalog / fiyat listesi okuyucu (ÜCRETSİZ yol, yapay zekâsız)
// PDF'in yazı katmanını ve gömülü görsellerini konumlarıyla okur (pdf.js / unpdf):
//   - tablo düzeni (başlık satırı: Ürün / Kod / Barkod / Fiyat / Stok / Renk / Beden ...)
//   - kart düzeni (ürün adı + "Ürün kodu:" + fiyat bloğu; resimli kataloglar)
//   - satır düzeni (her satırda ad + fiyat)
// Görseller ürünle KONUMA göre eşleşir (aynı kart / aynı satır, en yakın blok).
// Okuyamadığı sayfaları (taranmış, karmaşık) "needAi" olarak bildirir; çağıran yapay zekâya gönderir.
// =========================================================
import { getDocumentProxy, getResolvedPDFJS } from "npm:unpdf@1.8.1";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";

export type Box = [number, number, number, number]; // x0, y0, x1, y1 (PDF birimi, y yukarı)
export type Cell = { x0: number; x1: number; text: string };
export type Line = { page: number; y: number; x0: number; x1: number; size: number; text: string; cells: Cell[] };
export type PdfImage = { id: string; page: number; box: Box; w: number; h: number; jpeg: Uint8Array | null; thumb: Uint8Array | null; full?: boolean };
export type Variant = { attributes: Record<string, string>; sku?: string; barcode?: string; price?: number | null; stock?: number | null };
export type PdfRow = {
  page: number; name: string; brand: string; model_code: string; sku: string; barcode: string; specs: { k: string; v: string }[];
  cost: number | null; list_price: number | null; currency: string | null; stock: number | null;
  variants: Variant[]; description: string; images: string[]; box: Box | null;
};
export type PageInfo = { page: number; width: number; height: number; lines: Line[]; images: PdfImage[]; textChars: number };
export type ParseResult = {
  rows: PdfRow[]; priceType: "wholesale" | "retail" | "unknown"; currency: string | null; brand: string; site: string;
  needAi: number[]; layout: string;
};

// ---------- PDF açma ----------
export async function openPdf(bytes: Uint8Array) {
  return await getDocumentProxy(new Uint8Array(bytes));
}

const mul = (m: number[], n: number[]) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

// pdf.js görsel verisi -> imagescript
function toImage(img: any): Image | null {
  const w = Number(img?.width), h = Number(img?.height);
  const data: Uint8Array | Uint8ClampedArray | undefined = img?.data;
  if (!w || !h || !data || w * h > 25_000_000) return null;
  const out = new Image(w, h);
  const bm = out.bitmap; // RGBA
  if (img.kind === 3 && data.length >= w * h * 4) bm.set(data.subarray(0, w * h * 4));
  else if (img.kind === 2 && data.length >= w * h * 3) {
    for (let i = 0, j = 0; i < w * h; i++, j += 3) { bm[i * 4] = data[j]; bm[i * 4 + 1] = data[j + 1]; bm[i * 4 + 2] = data[j + 2]; bm[i * 4 + 3] = 255; }
  } else if (img.kind === 1) {
    const rowBytes = (w + 7) >> 3;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
      const k = (y * w + x) * 4; bm[k] = bm[k + 1] = bm[k + 2] = v; bm[k + 3] = 255;
    }
  } else return null;
  // Saydam alanları beyaza (JPEG'de siyah görünmesin)
  for (let k = 0; k < bm.length; k += 4) {
    const a = bm[k + 3];
    if (a < 255) { const f = a / 255; bm[k] = bm[k] * f + 255 * (1 - f); bm[k + 1] = bm[k + 1] * f + 255 * (1 - f); bm[k + 2] = bm[k + 2] * f + 255 * (1 - f); bm[k + 3] = 255; }
  }
  return out;
}
async function encode(img: Image, max: number, q: number): Promise<Uint8Array> {
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const r = s < 1 ? img.clone().resize(Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s))) : img;
  return await r.encodeJPEG(q);
}

// Sayfaların yazı satırları ve görselleri
export async function readPages(pdf: any, from: number, to: number, withImages = true): Promise<PageInfo[]> {
  const { OPS } = await getResolvedPDFJS();
  const out: PageInfo[] = [];
  for (let p = from; p <= Math.min(to, pdf.numPages); p++) {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = (tc.items as any[]).filter((it) => typeof it.str === "string" && it.str.trim()).map((it) => {
      const t = it.transform as number[];
      const size = Math.max(4, Math.hypot(t[2], t[3]) || Math.abs(t[3]) || it.height || 10);
      return { x: t[4], y: t[5], w: Number(it.width) || it.str.length * size * 0.5, size, s: String(it.str) };
    });
    const lines = groupLines(items, p);
    const images: PdfImage[] = [];
    if (withImages) {
      const ops = await page.getOperatorList();
      let ctm = [1, 0, 0, 1, 0, 0];
      const stack: number[][] = [];
      let n = 0;
      for (let i = 0; i < ops.fnArray.length; i++) {
        const f = ops.fnArray[i], a = ops.argsArray[i];
        if (f === OPS.save) stack.push(ctm.slice());
        else if (f === OPS.restore) ctm = stack.pop() || ctm;
        else if (f === OPS.transform) ctm = mul(ctm, a);
        else if (f === OPS.paintImageXObject) {
          const xs = [ctm[4], ctm[4] + ctm[0], ctm[4] + ctm[2], ctm[4] + ctm[0] + ctm[2]];
          const ys = [ctm[5], ctm[5] + ctm[1], ctm[5] + ctm[3], ctm[5] + ctm[1] + ctm[3]];
          const box: Box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
          const bw = box[2] - box[0], bh = box[3] - box[1];
          if (bw < 28 || bh < 28) continue; // ikon / çizgi
          const full = bw * bh > vp.width * vp.height * 0.55;
          let raw: any = null;
          try {
            raw = await Promise.race([
              new Promise((res) => (String(a[0]).startsWith("g_") ? page.commonObjs : page.objs).get(a[0], res)),
              new Promise((res) => setTimeout(() => res(null), 8000)),
            ]);
          } catch { raw = null; }
          const im = raw ? toImage(raw) : null;
          if (!im || im.width < 40 || im.height < 40) continue;
          n++;
          images.push({
            id: `p${p}-${n}`, page: p, box, w: im.width, h: im.height, full,
            jpeg: await encode(im, full ? 2400 : 1200, 85), thumb: full ? null : await encode(im, 384, 75),
          });
        }
      }
    }
    out.push({ page: p, width: vp.width, height: vp.height, lines, images, textChars: items.reduce((a, it) => a + it.s.trim().length, 0) });
    page.cleanup?.();
  }
  return out;
}

function groupLines(items: { x: number; y: number; w: number; size: number; s: string }[], page: number): Line[] {
  const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: (typeof items)[] = [];
  for (const it of sorted) {
    const r = rows.find((row) => Math.abs(row[0].y - it.y) < Math.min(row[0].size, it.size) * 0.45);
    if (r) r.push(it); else rows.push([it]);
  }
  return rows.map((row) => {
    row.sort((a, b) => a.x - b.x);
    const cells: Cell[] = [];
    for (const it of row) {
      const last = cells[cells.length - 1];
      const gap = last ? it.x - last.x1 : Infinity;
      if (last && gap < it.size * 0.6) { last.text += (gap > it.size * 0.15 && !/\s$/.test(last.text) ? " " : "") + it.s; last.x1 = Math.max(last.x1, it.x + it.w); }
      else cells.push({ x0: it.x, x1: it.x + it.w, text: it.s });
    }
    cells.forEach((c) => (c.text = c.text.replace(/\s+/g, " ").trim()));
    const size = Math.max(...row.map((r) => r.size));
    return { page, y: row[0].y, x0: cells[0].x0, x1: Math.max(...cells.map((c) => c.x1)), size, text: cells.map((c) => c.text).join("  "), cells: cells.filter((c) => c.text) };
  }).filter((l) => l.cells.length).sort((a, b) => b.y - a.y || a.x0 - b.x0);
}

// ---------- Metin yardımcıları ----------
const low = (s: string) => s.toLocaleLowerCase("tr");
export function parsePrice(v: unknown): number | null {
  if (v == null) return null;
  let s = String(v).replace(/[^\d.,]/g, "");
  if (!s) return null;
  const lc = s.lastIndexOf(","), ld = s.lastIndexOf(".");
  if (lc > -1 && ld > -1) s = lc > ld ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (lc > -1) s = /,\d{1,2}$/.test(s) ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (ld > -1) { const parts = s.split("."); if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) s = s.replace(/\./g, ""); }
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}
export function currencyOf(s: string): string | null {
  const t = String(s || "").toUpperCase();
  if (/\bTRY\b|\bTL\b|₺/.test(t)) return "TRY";
  if (/\bUSD\b|\$/.test(t)) return "USD";
  if (/\bEUR\b|€|EURO/.test(t)) return "EUR";
  if (/\bGBP\b|£/.test(t)) return "GBP";
  return null;
}
const NUM = String.raw`\d{1,3}(?:[.\s]\d{3})+(?:,\d{1,2})?|\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const UNIT = String.raw`(?:ml|lt|l|cl|cm|mm|mt|m|kg|gr|g|w|v|mah|gb|tb|adet|ad|pcs|x|li|lı|lu|lü|"|inç|inch)\b`;
const PRICE_RE = new RegExp(String.raw`(?<![\w\-/.,])(?:(₺|\$|€|£)\s*)?(${NUM})(?:\s*(TL|TRY|₺|USD|\$|EUR|€|GBP|£)(?![a-zçğıöşü]))?(?![\w\-/%])(?!\s*${UNIT})`, "gi");
// Satırdaki fiyatlar: para birimi işaretli ya da kuruşlu sayı
export function pricesIn(text: string, loose = false): { value: number; cur: string | null; raw: string; index: number }[] {
  const out: { value: number; cur: string | null; raw: string; index: number }[] = [];
  for (const m of text.matchAll(PRICE_RE)) {
    const sym = m[1] || m[3] || "";
    const num = m[2];
    const decimals = /[.,]\d{1,2}$/.test(num) && !/^\d{1,3}[.,]\d{3}$/.test(num);
    if (!sym && !decimals && !loose) continue;
    const v = parsePrice(num);
    if (v != null) out.push({ value: v, cur: currencyOf(sym), raw: m[0], index: m.index ?? 0 });
  }
  return out;
}
function eanOk(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const d = code.split("").map(Number);
  const check = d.pop()!;
  const sum = d.reverse().reduce((a, x, i) => a + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}
const LABELS: [RegExp, string][] = [
  [/^(?:barkod|barcode|ean|gtin)\b/i, "barcode"],
  [/^(?:stok kodu|ürün kodu|urun kodu|model kodu|model no|model|kod|code|ref|referans|sku|art\.?\s*no|ürün no)\b/i, "code"],
  [/^(?:stok|stock|adet|miktar|qty|mevcut)\b/i, "stock"],
  [/^(?:marka|brand)\b/i, "brand"],
  [/^(?:renk|renkler|color|colors|colour)\b/i, "color"],
  [/^(?:beden|bedenler|numara|numaralar|size|sizes|ölçü)\b/i, "size"],
  [/^(?:bayi|net|alış|alis|toptan|dealer|wholesale|maliyet)\b/i, "cost"],
  [/^(?:psf|tavsiye|perakende|liste fiyat|satış fiyat|satis fiyat|retail|msrp|etiket)/i, "list"],
  [/^(?:fiyat|price|birim fiyat)\b/i, "price"],
];
function labelOf(text: string): { key: string; value: string } | null {
  const t = text.trim();
  for (const [re, key] of LABELS) {
    const m = t.match(re);
    if (m) {
      const rest = t.slice(m[0].length).replace(/^[^\p{L}\p{N}₺$€£]*?(?:fiyat[ıi]?|price)?\s*[:#.\-–]\s*/iu, "").replace(/^\s*[:#]\s*/, "").trim();
      if (/[:#]/.test(t.slice(m[0].length, m[0].length + 25)) || key === "cost" || key === "list" || key === "price") return { key, value: rest };
    }
  }
  return null;
}
const letters = (s: string) => (s.match(/\p{L}/gu) || []).length;
const CODE_TOKEN = /^(?=[A-Z0-9\-./]*\d)(?=[A-Z0-9\-./]*[A-Z])[A-Z0-9][A-Z0-9\-./]{2,24}$/;

// ---------- Başlık sütunları (tablo düzeni) ----------
const HEAD: [RegExp, string][] = [
  [/barkod|barcode|\bean\b|gtin/i, "barcode"],
  [/stok kodu|ürün kodu|urun kodu|model kodu|\bkod\b|\bkodu\b|\bcode\b|\bsku\b|\bref|\bmodel\b|art\.?\s*no/i, "code"],
  [/psf|tavsiye|perakende|liste|satış fiyat|satis fiyat|retail|msrp|etiket/i, "list"],
  [/bayi|net fiyat|\bnet\b|alış|alis|toptan|dealer|wholesale|maliyet/i, "cost"],
  [/fiyat|price|tutar|birim/i, "price"],
  [/stok|adet|miktar|stock|qty|quantity|mevcut/i, "stock"],
  [/marka|brand/i, "brand"],
  [/renk|colou?r/i, "color"],
  [/beden|\bsize\b|numara|ölçü/i, "size"],
  [/varyant|variant|seçenek|secenek/i, "variant"],
  [/para birimi|döviz|doviz|currency|\bpb\b/i, "currency"],
  [/ürün|urun|açıklama|aciklama|tanım|tanim|description|product|\bitem\b|\bname\b|\bad[ıi]\b|malzeme|cins/i, "name"],
];
function headerColumns(line: Line): { key: string; x0: number; x1: number }[] | null {
  if (line.cells.length < 2 || pricesIn(line.text).length) return null;
  const cols: { key: string; x0: number; x1: number }[] = [];
  let hits = 0;
  for (const c of line.cells) {
    if (c.text.length > 40) return null;
    const h = HEAD.find(([re]) => re.test(c.text));
    if (h) { hits++; cols.push({ key: cols.some((x) => x.key === h[1]) ? h[1] + "_" + cols.length : h[1], x0: c.x0, x1: c.x1 }); }
    else cols.push({ key: "x" + cols.length, x0: c.x0, x1: c.x1 });
  }
  const keys = cols.map((c) => c.key);
  const hasPrice = keys.some((k) => /^(price|cost|list)/.test(k));
  return hits >= 2 && hits >= cols.length * 0.6 && hasPrice && (keys.includes("name") || keys.includes("code")) ? cols : null;
}
// Hücre hangi sütunda: başlıkla en çok örtüşen; örtüşme yoksa sola / sağa / ortaya hizası en yakın olan
function cellColumn(cell: Cell, cols: { key: string; x0: number; x1: number }[]): number {
  let best = -1, bestOv = 0;
  cols.forEach((c, i) => { const ov = Math.min(cell.x1, c.x1) - Math.max(cell.x0, c.x0); if (ov > bestOv) { bestOv = ov; best = i; } });
  if (best >= 0) return best;
  let bd = Infinity;
  cols.forEach((c, i) => {
    const d = Math.min(Math.abs(cell.x0 - c.x0), Math.abs(cell.x1 - c.x1), Math.abs((cell.x0 + cell.x1) / 2 - (c.x0 + c.x1) / 2));
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}
// İki satıra bölünmüş başlık hücreleri ("Stok" / "Kodu") başlık satırına eklenir
function mergeHeader(h: Line, lines: Line[], used: Set<Line>): { key: string; x0: number; x1: number }[] | null {
  const near = lines.filter((l) => l !== h && Math.abs(l.y - h.y) <= h.size * 1.3 && !pricesIn(l.text).length && l.cells.every((c) => c.text.length <= 30));
  const cells = h.cells.map((c) => ({ ...c, y: h.y }));
  for (const l of near) {
    for (const c of l.cells) {
      const hit = cells.find((x) => Math.min(x.x1, c.x1) - Math.max(x.x0, c.x0) > 0);
      if (hit) { hit.text = hit.y >= l.y ? hit.text + " " + c.text : c.text + " " + hit.text; hit.x0 = Math.min(hit.x0, c.x0); hit.x1 = Math.max(hit.x1, c.x1); }
      else cells.push({ ...c, y: l.y });
    }
    used.add(l);
  }
  cells.sort((a, b) => a.x0 - b.x0);
  return headerColumns({ ...h, cells, text: cells.map((c) => c.text).join("  ") });
}
const emptyRow = (page: number): PdfRow => ({ page, name: "", brand: "", model_code: "", sku: "", barcode: "", specs: [], cost: null, list_price: null, currency: null, stock: null, variants: [], description: "", images: [], box: null });
const union = (a: Box | null, b: Box): Box => (a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b);
const lineBox = (l: Line): Box => [l.x0, l.y - l.size * 0.3, l.x1, l.y + l.size];

function tableRows(pages: PageInfo[]): { rows: PdfRow[]; used: Set<Line> } {
  const rows: PdfRow[] = [];
  const used = new Set<Line>();
  let cols: { key: string; x0: number; x1: number }[] | null = null;
  for (const pg of pages) {
    // 1) Başlık(lar) ve veri satırları
    const data: { line: Line; cols: { key: string; x0: number; x1: number }[] }[] = [];
    for (const line of pg.lines) {
      if (used.has(line)) continue;
      const h = headerColumns(line) && mergeHeader(line, pg.lines, used);
      if (h) { cols = h; used.add(line); continue; }
      if (cols) data.push({ line, cols });
    }
    if (!data.length) continue;
    // 2) Ana satır: fiyatlı ya da çok hücreli; parça satırlar (dikey ortalanmış hücrelerin taşan kısmı) en yakın ana satıra
    const isAnchor = (l: Line, c: { key: string; x0: number; x1: number }[]) => {
      const keys = new Set(l.cells.map((x) => c[cellColumn(x, c)]?.key));
      const priced = ["cost", "price", "list"].some((k) => keys.has(k)) && pricesIn(l.text, true).length > 0;
      return (priced && l.cells.length >= 2) || l.cells.length >= 3;
    };
    const anchors = data.filter((d) => isAnchor(d.line, d.cols));
    const groups = new Map<Line, Line[]>(anchors.map((a) => [a.line, [a.line]]));
    for (const d of data) {
      if (groups.has(d.line)) continue;
      let best: Line | null = null, bd = Infinity;
      for (const a of anchors) { const dy = Math.abs(a.line.y - d.line.y); if (dy < bd) { bd = dy; best = a.line; } }
      if (best && bd <= d.line.size * 1.5) groups.get(best)!.push(d.line);
    }
    for (const a of anchors) {
      const parts = groups.get(a.line)!.sort((x, y) => y.y - x.y);
      const vals: Record<string, string> = {};
      for (const l of parts) for (const c of l.cells) {
        const i = cellColumn(c, a.cols);
        if (i < 0) continue;
        const k = a.cols[i].key;
        vals[k] = vals[k] ? vals[k] + " " + c.text : c.text;
      }
      const name = (vals.name || "").trim();
      const priced = ["cost", "price", "list"].some((k) => vals[k] && parsePrice(vals[k]) != null);
      if (!priced || (!name && !vals.code)) continue;
      const r = emptyRow(pg.page);
      r.name = name || vals.code;
      r.model_code = (vals.code || "").slice(0, 80);
      const bc = (vals.barcode || "").replace(/\D/g, "");
      r.barcode = bc.length >= 8 ? bc : "";
      const cost = parsePrice(vals.cost), price = parsePrice(vals.price), list = parsePrice(vals.list);
      r.cost = cost ?? price ?? null;
      r.list_price = list ?? (cost != null && price != null && price !== cost ? price : null);
      r.currency = currencyOf(vals.currency || "") || currencyOf(parts.map((l) => l.text).join(" "));
      r.stock = vals.stock != null && /\d/.test(vals.stock) ? parseInt(vals.stock.replace(/\D/g, ""), 10) : null;
      r.brand = (vals.brand || "").slice(0, 80);
      const attrs: Record<string, string> = {};
      if (vals.color) attrs["Renk"] = vals.color;
      if (vals.size) attrs["Beden"] = vals.size;
      if (vals.variant) attrs["Seçenek"] = vals.variant;
      if (Object.keys(attrs).length) r.variants = [{ attributes: attrs, sku: r.model_code, barcode: r.barcode, price: r.cost ?? r.list_price, stock: r.stock }];
      for (const l of parts) { r.box = union(r.box, lineBox(l)); used.add(l); }
      rows.push(r);
    }
  }
  return { rows: groupVariants(rows), used };
}
// Aynı ürünün renk / beden satırlarını tek ürün altında topla
function groupVariants(rows: PdfRow[]): PdfRow[] {
  const out: PdfRow[] = [];
  const byKey = new Map<string, PdfRow>();
  for (const r of rows) {
    if (!r.variants.length) { out.push(r); continue; }
    const key = low(r.name) + "|" + low(r.brand);
    const g = byKey.get(key);
    if (!g) { byKey.set(key, r); out.push(r); continue; }
    g.variants.push(...r.variants);
    if (r.stock != null) g.stock = (g.stock || 0) + r.stock;
    if (r.cost != null && (g.cost == null || r.cost < g.cost)) g.cost = r.cost;
    g.box = r.box ? union(g.box, r.box) : g.box;
  }
  // Tek renk / beden: seçenek değil, özellik
  for (const g of out) if (g.variants.length === 1) {
    for (const [k, v] of Object.entries(g.variants[0].attributes)) if (v) g.specs.push({ k, v });
    g.variants = [];
  }
  return out;
}

// ---------- Kart / satır düzeni ----------
function blocks(lines: Line[]): Line[][] {
  const n = lines.length;
  const parent = lines.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const a = lines[i], b = lines[j];
    const dy = Math.abs(a.y - b.y);
    if (dy > Math.max(a.size, b.size) * 2.4) continue;
    const hov = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    if (hov > -Math.max(a.size, b.size) * 0.5 || Math.abs(a.x0 - b.x0) < Math.max(a.size, b.size) * 1.5) parent[find(j)] = find(i);
  }
  const g = new Map<number, Line[]>();
  lines.forEach((l, i) => { const r = find(i); if (!g.has(r)) g.set(r, []); g.get(r)!.push(l); });
  return [...g.values()].map((b) => b.sort((a, c) => c.y - a.y || a.x0 - c.x0));
}
function fromText(lines: Line[], page: number): PdfRow | null {
  const r = emptyRow(page);
  const extra: string[] = [];
  const meta: { size: number; y: number }[] = [];
  let sizes: string[] = [], colors: string[] = [];
  for (const l of lines) {
    const parts = l.text.split(/\s{2,}|\s[·|]\s/)
      .flatMap((x) => x.split(/\s+(?=(?:PSF|Bayi|Net|Liste|Perakende|Barkod|Stok|Model|Kod|Marka|Renk|Beden|Bedenler)\s*[:：])/i));
    for (const part of parts) {
      const t = part.trim();
      if (!t) continue;
      const lab = labelOf(t);
      if (lab) {
        if (lab.key === "barcode") { const d = lab.value.replace(/\D/g, ""); if (d.length >= 8) r.barcode = d; continue; }
        if (lab.key === "code") { r.model_code = lab.value.split(/\s/)[0].slice(0, 80); continue; }
        if (lab.key === "stock") { const d = lab.value.match(/\d+/); if (d) r.stock = Number(d[0]); continue; }
        if (lab.key === "brand") { r.brand = lab.value.slice(0, 80); continue; }
        if (lab.key === "size") { sizes = lab.value.split(/\s*[,/;]\s*|\s+-\s+/).filter(Boolean).slice(0, 30); continue; }
        if (lab.key === "color") { colors = lab.value.split(/\s*[,/;]\s*/).filter(Boolean).slice(0, 30); continue; }
        const p = pricesIn(lab.value, true)[0];
        if (p) {
          if (lab.key === "list") r.list_price = p.value; else r.cost = p.value;
          r.currency = r.currency || p.cur;
          continue;
        }
      }
      const ps = pricesIn(t);
      if (ps.length) {
        const rest = t.replace(ps[0].raw, " ").replace(/\s+/g, " ").trim();
        if (r.cost == null) r.cost = ps[0].value; else if (r.list_price == null && ps[0].value !== r.cost) r.list_price = ps[0].value;
        r.currency = r.currency || ps[0].cur;
        if (letters(rest) >= 3 && !/^(fiyat|price|kdv|\+?\s*kdv)/i.test(rest)) extra.push(rest);
        continue;
      }
      const digits = t.replace(/\s/g, "");
      if (/^\d{8,14}$/.test(digits) && eanOk(digits)) { r.barcode = digits; continue; }
      if (CODE_TOKEN.test(t) && !r.model_code) { r.model_code = t; continue; }
      if (letters(t) >= 2) { extra.push(t); meta[extra.length - 1] = { size: l.size, y: l.y }; }
    }
    r.box = union(r.box, lineBox(l));
  }
  if (!extra.length && !r.model_code) return null;
  // Ad: baştaki koddan arındırılmış ilk metin
  // Alt satıra kayan ad (aynı yazı boyu, hemen altında)
  while (extra.length > 1 && meta[0] && meta[1] && Math.abs(meta[0].size - meta[1].size) < 0.5 && meta[0].y - meta[1].y <= meta[0].size * 1.6 && extra[0].length < 70) {
    extra.splice(0, 2, extra[0] + " " + extra[1]);
    meta.splice(0, 2, meta[1]);
  }
  let name = extra.shift() || r.model_code;
  const lead = name.match(/^([A-Z0-9][A-Z0-9\-./]{2,24})\s+(.{3,})$/);
  if (lead && CODE_TOKEN.test(lead[1])) { if (!r.model_code) r.model_code = lead[1]; name = lead[2]; }
  r.name = name.slice(0, 300);
  r.description = extra.join(" ").slice(0, 2000);
  if (sizes.length || colors.length) {
    const cs = colors.length ? colors : [""], ss = sizes.length ? sizes : [""];
    for (const c of cs) for (const s of ss) {
      const a: Record<string, string> = {};
      if (c) a["Renk"] = c;
      if (s) a["Beden"] = s;
      r.variants.push({ attributes: a, price: r.cost ?? r.list_price });
    }
  }
  return r;
}
// Resimli katalog: her görsel bir kartın çapası; yazı satırı en yakın görsele (yanında / altında) bağlanır
function imageClusterRows(pg: PageInfo, lines: Line[]): PdfRow[] {
  const imgs = pg.images.filter((i) => !i.full);
  if (imgs.length < 2) return [];
  // Her hücre ayrı birim (yan yana kartlar aynı satırda olabilir)
  const units: Line[] = lines.flatMap((l) => l.cells.map((c) => ({ ...l, x0: c.x0, x1: c.x1, text: c.text, cells: [c] })))
    .filter((u) => !(u.x1 - u.x0 > pg.width * 0.45 && !pricesIn(u.text).length)); // başlık / dipnot
  let leftPenalty = 1, rightPenalty = 1; // yazı görselin sağında mı solunda mı (baskın yön dışındaki 3 kat uzak sayılır)
  const near = (u: Line, side: boolean) => {
    const lb = lineBox(u);
    let best: PdfImage | null = null, bd = Infinity;
    for (const im of imgs) {
      const vov = Math.min(lb[3], im.box[3]) - Math.max(lb[1], im.box[1]);
      const hov = Math.min(lb[2], im.box[2]) - Math.max(lb[0], im.box[0]);
      let d: number;
      if (side) {
        if (vov <= 0) continue;
        d = lb[0] >= im.box[2] - 2 ? (lb[0] - im.box[2]) * rightPenalty : lb[2] <= im.box[0] + 2 ? (im.box[0] - lb[2]) * leftPenalty : 0;
      }
      else { if (lb[3] > im.box[1] || (hov <= 0 && Math.abs(lb[0] - im.box[0]) > u.size * 2)) continue; d = im.box[1] - lb[3]; }
      if (d < bd) { bd = d; best = im; }
    }
    return best && bd <= pg.width * 0.22 ? { im: best, d: bd } : null;
  };
  // Düzen: yazı görselin yanında mı, altında mı (fiyatlı hücrelere göre)
  const priced = units.filter((u) => pricesIn(u.text, /[:：]/.test(u.text)).length);
  const side = priced.filter((u) => near(u, true)).length >= priced.filter((u) => near(u, false)).length;
  if (side) {
    let r = 0, l = 0;
    for (const u of priced) { const n = near(u, true); if (n) { if (u.x0 >= n.im.box[2] - 2) r++; else if (u.x1 <= n.im.box[0] + 2) l++; } }
    if (r > l) leftPenalty = 3; else if (l > r) rightPenalty = 3;
  }
  const groups = new Map<string, Line[]>();
  for (const u of units) {
    if (/^(TL|TRY|USD|EUR|GBP|₺|\$|€|£)$/i.test(u.text.trim())) continue;
    const n = near(u, side);
    if (!n) continue;
    if (!groups.has(n.im.id)) groups.set(n.im.id, []);
    groups.get(n.im.id)!.push(u);
  }
  const rows: PdfRow[] = [];
  for (const im of imgs) {
    const g = groups.get(im.id);
    if (!g?.length) continue;
    const r = fromText(g.sort((a, b) => b.y - a.y || a.x0 - b.x0), pg.page);
    if (r && (r.cost != null || r.list_price != null)) { r.images = [im.id]; r.box = union(r.box, im.box); rows.push(r); }
  }
  return rows.length >= Math.min(2, imgs.length) ? rows : [];
}
function cardRows(pg: PageInfo, skip: Set<Line>): PdfRow[] {
  // Sayfa genişliğinde, fiyatsız satırlar başlık / dipnottur
  const byImage = imageClusterRows(pg, pg.lines.filter((l) => !skip.has(l)));
  const lines = pg.lines.filter((l) => !skip.has(l) && !((l.x1 - l.x0) > pg.width * 0.55 && !pricesIn(l.text).length));
  if (byImage.length) return byImage;
  const rows: PdfRow[] = [];
  for (const b of blocks(lines)) {
    const priceLines = b.filter((l) => pricesIn(l.text).length || /^(fiyat|price|bayi|net|psf|liste)\b/i.test(l.text.trim()) && pricesIn(l.text, true).length);
    if (!priceLines.length) continue;
    const textPriceLines = priceLines.filter((l) => letters(l.text.replace(/fiyat|price|tl|try|usd|eur|kdv/gi, "")) >= 4);
    if (textPriceLines.length >= 2 && textPriceLines.length >= b.length * 0.6) {
      // Satır düzeni: her satır bir ürün
      for (const l of b) { const r = pricesIn(l.text).length ? fromText([l], pg.page) : null; if (r && r.cost != null) rows.push(r); }
      continue;
    }
    if (priceLines.length >= 2 && b.length >= priceLines.length * 2) {
      // Alt alta birden fazla kart aynı blokta: fiyat satırlarından böl
      let cur: Line[] = [];
      for (const l of b) {
        cur.push(l);
        if (priceLines.includes(l)) {
          const nxt = b[b.indexOf(l) + 1];
          const labeledNext = nxt && labelOf(nxt.text) && !priceLines.includes(nxt);
          if (!labeledNext || (nxt && /^(?:barkod|stok)/i.test(nxt.text.trim()) === false)) { const r = fromText(cur, pg.page); if (r) rows.push(r); cur = []; }
        }
      }
      if (cur.length && rows.length) { const last = rows[rows.length - 1]; const extra = fromText(cur, pg.page); if (extra) { if (!last.barcode) last.barcode = extra.barcode; if (last.stock == null) last.stock = extra.stock; } }
      continue;
    }
    const r = fromText(b, pg.page);
    if (r && (r.cost != null || r.list_price != null)) rows.push(r);
  }
  return rows;
}

// ---------- Görsel ↔ ürün (konum) ----------
function boxDist(a: Box, b: Box): number {
  const dx = Math.max(0, a[0] - b[2], b[0] - a[2]);
  const dy = Math.max(0, a[1] - b[3], b[1] - a[3]);
  return Math.hypot(dx, dy);
}
export function matchImagesByPosition(pg: PageInfo, rows: PdfRow[]) {
  const taken = new Set(rows.flatMap((r) => r.images));
  const imgs = pg.images.filter((i) => !i.full && !taken.has(i.id));
  const pr = rows.filter((r) => r.page === pg.page && r.box && !r.images.length);
  if (!imgs.length || !pr.length) return;
  const maxD = pg.width * 0.3;
  const pairs: { i: PdfImage; r: PdfRow; d: number }[] = [];
  for (const i of imgs) for (const r of pr) {
    const d = boxDist(i.box, r.box!);
    // Aynı yatay bant (kart / tablo satırı) öncelikli
    const vov = Math.min(i.box[3], r.box![3]) - Math.max(i.box[1], r.box![1]);
    if (d <= maxD) pairs.push({ i, r, d: d - (vov > 0 ? pg.width * 0.05 : 0) });
  }
  pairs.sort((a, b) => a.d - b.d);
  const usedI = new Set<string>();
  for (const p of pairs) if (!usedI.has(p.i.id) && !p.r.images.length) { p.r.images.push(p.i.id); usedI.add(p.i.id); }
  // Ek görseller: başka bir ürüne daha yakın değilse aynı ürüne (en fazla 4)
  for (const i of imgs) {
    if (usedI.has(i.id)) continue;
    const near = pairs.filter((p) => p.i.id === i.id);
    if (near.length && near[0].d <= pg.width * 0.12 && near[0].r.images.length < 4) { near[0].r.images.push(i.id); usedI.add(i.id); }
  }
}

// ---------- Ana çözümleme ----------
export function parseRows(pages: PageInfo[]): ParseResult {
  const all = pages.flatMap((p) => p.lines.map((l) => l.text)).join("\n");
  const lowAll = low(all);
  const wholesale = /\bbayi\b|toptan|net fiyat|alış fiyat|alis fiyat|dealer|wholesale|maliyet|bayi fiyat/.test(lowAll);
  const retail = /perakende|satış fiyat|satis fiyat|\bpsf\b|retail|tavsiye/.test(lowAll);
  const docCur = (() => {
    const m = all.match(/(?:fiyatlar[ıi]?|prices?|para birimi|currency)[^\n]{0,30}?\b(TL|TRY|USD|EUR|GBP|dolar|euro|avro)\b/i);
    if (!m) return null;
    const c = m[1].toUpperCase();
    return c === "DOLAR" ? "USD" : c === "EURO" || c === "AVRO" ? "EUR" : currencyOf(c);
  })();
  const brandM = all.match(/(?:^|\n)\s*(?:marka|brand)\s*[:：]\s*([^\n·|]{2,40})/i);
  const siteM = all.match(/(?:www\.|https?:\/\/)([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i);
  const site = siteM && !/(trendyol|hepsiburada|n11|amazon|instagram|facebook|whatsapp|aliexpress|youtube|google)\./i.test(siteM[1]) ? siteM[1].toLowerCase().replace(/^www\./, "") : "";

  const { rows: tRows, used } = tableRows(pages);
  const rows: PdfRow[] = [...tRows];
  const needAi: number[] = [];
  let layout = tRows.length ? "table" : "";
  for (const pg of pages) {
    const pageTable = tRows.filter((r) => r.page === pg.page).length;
    const cards = pageTable ? [] : cardRows(pg, used);
    if (cards.length) { rows.push(...cards); layout = layout ? (layout.includes("card") ? layout : layout + "+card") : "card"; }
    const got = pageTable + cards.length;
    const priceHits = pg.lines.reduce((a, l) => a + pricesIn(l.text).length, 0);
    const scan = pg.textChars < 30 && pg.images.length > 0;
    if (scan || (got === 0 && priceHits >= 2) || (got > 0 && priceHits >= got * 3 && got < 3)) needAi.push(pg.page);
  }
  for (const r of rows) {
    if (!r.currency) r.currency = docCur;
    if (!r.brand && brandM) r.brand = brandM[1].trim().slice(0, 80);
    r.name = r.name.replace(/\s+/g, " ").trim();
  }
  for (const pg of pages) if (!needAi.includes(pg.page)) matchImagesByPosition(pg, rows);
  return {
    rows: rows.filter((r) => r.name && letters(r.name) >= 2),
    priceType: wholesale ? "wholesale" : retail ? "retail" : "unknown",
    currency: docCur, brand: brandM ? brandM[1].trim() : "", site, needAi, layout: layout || "none",
  };
}
