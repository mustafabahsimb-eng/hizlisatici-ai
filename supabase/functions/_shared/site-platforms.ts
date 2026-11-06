// =========================================================
// Seltigo - bilinen altyapıların RESMİ API okuyucuları (satıcının bağlı hesabıyla) + CSV ürün akışı
//   Shopify Admin REST (ürün + seçenek + stok, taslaklar dahil), WooCommerce REST v3 (stok miktarı, varyasyonlar),
//   Wix Stores v1 (products/query). Kimlik bilgileri store_connections (Vault) üzerinden gelir.
// Çıktı: product-ingest öğesi biçimi { name, description, sale_price, currency, images, variants, url, sku, barcode,
//   brand, stock, source_platform, source_item_id, category }
// Sayfalama: her çağrı bir sayfa okur, { items, next } döner (next: sonraki sayfa imleci; yoksa null)
// =========================================================
import { safeFetch } from "./site-guard.ts";

export type SiteItem = Record<string, any>;
export type Page = { items: SiteItem[]; next: string | null };
const strip = (h: string) => String(h || "").replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n").trim();
const num = (v: unknown) => { const n = Number(String(v ?? "").replace(",", ".")); return Number.isFinite(n) ? n : null; };

// ---------- Shopify Admin ----------
export async function shopifyAdminPage(creds: any, cursor: string | null): Promise<Page> {
  const shop = String(creds.shop_domain || creds.shop || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!shop || !creds.access_token) throw new Error("Shopify bağlantısı eksik");
  const url = cursor || `https://${shop}/admin/api/2024-10/products.json?limit=250&status=active`;
  const r = await safeFetch(url, { accept: "application/json", headers: { "X-Shopify-Access-Token": String(creds.access_token) }, maxBytes: 20_000_000, timeout: 30000 });
  if (r.status === 401 || r.status === 403) throw new Error("Shopify anahtarı geçersiz ya da izni yok (Hesaplarım'dan yeniden bağla)");
  if (r.status !== 200) throw new Error("Shopify API " + r.status);
  const d = JSON.parse(r.text);
  const link = r.headers.get("link") || "";
  const next = link.match(/<([^>]+)>;\s*rel="next"/)?.[1] || null;
  const shopCur = creds.currency || "TRY";
  const items = (d.products || []).map((p: any) => {
    const opts: string[] = (p.options || []).map((o: any) => o.name);
    const vars = (p.variants || []);
    const multi = vars.length > 1 || (vars[0] && vars[0].title !== "Default Title");
    const imgById = new Map((p.images || []).map((i: any) => [i.id, i.src]));
    const stock = vars.reduce((s: number, v: any) => s + (v.inventory_management ? Math.max(0, Number(v.inventory_quantity) || 0) : 0), 0);
    const tracked = vars.some((v: any) => v.inventory_management);
    return {
      name: p.title, description: strip(p.body_html), brand: p.vendor || "", category: p.product_type || "",
      sale_price: num(vars[0]?.price), list_price: num(vars[0]?.compare_at_price), currency: shopCur,
      images: (p.images || []).map((i: any) => i.src).slice(0, 12),
      sku: vars[0]?.sku || "", barcode: vars[0]?.barcode || "", stock: tracked ? stock : null,
      url: `https://${creds.public_domain || shop}/products/${p.handle}`, source_platform: "shopify", source_item_id: String(p.id),
      variants: multi ? vars.map((v: any) => ({
        supplier_variant_id: String(v.id), sku: v.sku || null, barcode: v.barcode || null, price: num(v.price),
        stock: v.inventory_management ? Math.max(0, Number(v.inventory_quantity) || 0) : null, image: imgById.get(v.image_id) || null,
        attributes: Object.fromEntries(opts.map((n, i) => [n, v[`option${i + 1}`]]).filter(([, x]) => x)),
      })) : [],
    };
  });
  return { items, next };
}

// ---------- WooCommerce REST v3 ----------
export async function wooRestPage(creds: any, cursor: string | null): Promise<Page> {
  const base = String(creds.sellerId || creds.url || creds.store_url || "").replace(/\/+$/, "");
  const ck = creds.apiKey || creds.consumer_key, cs = creds.apiSecret || creds.consumer_secret;
  if (!base || !ck || !cs) throw new Error("WooCommerce bağlantısı eksik");
  const page = cursor ? Number(cursor) : 1;
  const q = `consumer_key=${encodeURIComponent(ck)}&consumer_secret=${encodeURIComponent(cs)}`;
  const r = await safeFetch(`${base}/wp-json/wc/v3/products?per_page=50&page=${page}&status=publish&${q}`, { accept: "application/json", maxBytes: 20_000_000, timeout: 30000 });
  if (r.status === 401 || r.status === 403) throw new Error("WooCommerce anahtarı geçersiz (Hesaplarım'dan yeniden bağla)");
  if (r.status !== 200) throw new Error("WooCommerce API " + r.status);
  const list = JSON.parse(r.text) || [];
  const total = Number(r.headers.get("x-wp-totalpages") || 0);
  const items: SiteItem[] = [];
  for (const p of list) {
    let variants: any[] = [];
    if (p.type === "variable" && (p.variations || []).length) {
      const vr = await safeFetch(`${base}/wp-json/wc/v3/products/${p.id}/variations?per_page=100&${q}`, { accept: "application/json", maxBytes: 5_000_000 });
      if (vr.status === 200) variants = (JSON.parse(vr.text) || []).map((v: any) => ({
        supplier_variant_id: String(v.id), sku: v.sku || null, barcode: v.global_unique_id || null, price: num(v.price),
        stock: v.manage_stock ? Math.max(0, Number(v.stock_quantity) || 0) : (v.stock_status === "outofstock" ? 0 : null),
        image: v.image?.src || null, attributes: Object.fromEntries((v.attributes || []).map((a: any) => [a.name, a.option])),
      }));
    }
    items.push({
      name: p.name, description: strip(p.description || p.short_description), category: p.categories?.[0]?.name || "",
      sale_price: num(p.price), list_price: num(p.regular_price), currency: creds.currency || "TRY",
      images: (p.images || []).map((i: any) => i.src).slice(0, 12), sku: p.sku || "", barcode: p.global_unique_id || "",
      stock: p.manage_stock ? Math.max(0, Number(p.stock_quantity) || 0) : (p.stock_status === "outofstock" ? 0 : null),
      url: p.permalink, source_platform: "woocommerce", source_item_id: String(p.id), variants,
    });
  }
  return { items, next: list.length && (!total || page < total) ? String(page + 1) : null };
}

// ---------- Wix Stores ----------
export async function wixStoresPage(creds: any, cursor: string | null): Promise<Page> {
  if (!creds.access_token) throw new Error("Wix bağlantısı eksik");
  const offset = cursor ? Number(cursor) : 0;
  const r = await fetch("https://www.wixapis.com/stores-reader/v1/products/query", {
    method: "POST", headers: { Authorization: String(creds.access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ query: { paging: { limit: 100, offset } }, includeVariants: true }), signal: AbortSignal.timeout(30000),
  });
  if (r.status === 401 || r.status === 403) throw new Error("Wix anahtarının süresi doldu (Hesaplarım'dan yeniden bağla)");
  if (!r.ok) throw new Error("Wix API " + r.status);
  const d = await r.json();
  const list = d.products || [];
  const items = list.map((p: any) => ({
    name: p.name, description: strip(p.description), brand: p.brand || "",
    sale_price: num(p.priceData?.discountedPrice ?? p.priceData?.price), list_price: num(p.priceData?.price), currency: p.priceData?.currency || "TRY",
    images: (p.media?.items || []).map((m: any) => m.image?.url).filter(Boolean).slice(0, 12),
    sku: p.sku || "", stock: p.stock?.trackInventory ? Number(p.stock?.quantity) || 0 : (p.stock?.inStock === false ? 0 : null),
    url: p.productPageUrl ? `${String(creds.site_url || "").replace(/\/+$/, "")}${p.productPageUrl.base || ""}${p.productPageUrl.path || ""}` : "",
    source_platform: "wix", source_item_id: String(p.id),
    variants: (p.variants || []).length > 1 ? p.variants.map((v: any) => ({
      supplier_variant_id: String(v.id), sku: v.variant?.sku || null, price: num(v.variant?.priceData?.price),
      stock: v.stock?.trackQuantity ? Number(v.stock?.quantity) || 0 : (v.stock?.inStock === false ? 0 : null), attributes: v.choices || {},
    })) : [],
  }));
  return { items, next: list.length === 100 ? String(offset + 100) : null };
}

// ---------- CSV ürün akışı (Google Merchant TSV/CSV, Shopify / WooCommerce dışa aktarma) ----------
export function parseCsv(text: string): Record<string, string>[] {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const sep = [",", ";", "\t", "|"].map((s) => [s, firstLine.split(s).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = ""; if (row.some((x) => x.trim())) rows.push(row); row = [];
    } else cell += c;
  }
  row.push(cell); if (row.some((x) => x.trim())) rows.push(row);
  const head = (rows.shift() || []).map((h) => h.trim().toLowerCase().replace(/^g:/, ""));
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}
export function csvItems(rows: Record<string, string>[], origin: string): SiteItem[] {
  const pick = (r: Record<string, string>, ...keys: string[]) => { for (const k of keys) if (r[k]) return r[k]; return ""; };
  const priceOf = (s: string) => { const m = String(s).match(/[\d.,]+/); if (!m) return null; let v = m[0]; if (/,\d{1,2}$/.test(v)) v = v.replace(/\./g, "").replace(",", "."); else v = v.replace(/,/g, ""); return num(v); };
  const curOf = (s: string) => String(s).match(/\b(TRY|TL|USD|EUR|GBP)\b/i)?.[1]?.toUpperCase().replace("TL", "TRY") || null;
  // Shopify dışa aktarımı: aynı Handle'ın satırları = seçenekler
  const byKey = new Map<string, SiteItem>();
  for (const r of rows) {
    const key = pick(r, "handle", "item_group_id", "parent", "id", "sku", "title", "name");
    const title = pick(r, "title", "name", "ad", "urun_adi", "ürün adı", "product name");
    const price = priceOf(pick(r, "sale_price", "variant price", "price", "fiyat", "satis_fiyati", "regular price"));
    const stockS = pick(r, "quantity", "variant inventory qty", "stock", "stok", "stock quantity", "inventory");
    const avail = pick(r, "availability", "in stock?");
    const stock = stockS ? Math.max(0, Number(stockS) || 0) : /out|yok|0/i.test(avail) ? 0 : null;
    const img = pick(r, "image_link", "image src", "images", "image", "resim", "gorsel").split(/[,|]/)[0]?.trim();
    const extra = pick(r, "additional_image_link").split(/[,|]/).map((x) => x.trim()).filter(Boolean);
    const optName = pick(r, "option1 name"), optVal = pick(r, "option1 value");
    let it = byKey.get(key);
    if (!it) {
      if (!title && !byKey.size) continue;
      it = {
        name: title, description: pick(r, "description", "body (html)", "aciklama", "açıklama").replace(/<[^>]+>/g, " ").trim(),
        brand: pick(r, "brand", "vendor", "marka"), category: pick(r, "product_type", "type", "categories", "kategori", "google_product_category"),
        sale_price: price, currency: curOf(pick(r, "price", "sale_price")) || "TRY", images: [img, ...extra].filter((x) => /^https?:\/\//.test(x || "")).slice(0, 12),
        sku: pick(r, "sku", "variant sku", "mpn", "id", "stok_kodu"), barcode: pick(r, "gtin", "variant barcode", "barcode", "barkod", "ean"),
        stock, url: (() => { const l = pick(r, "link", "url"); try { return l ? new URL(l, origin).href : ""; } catch { return ""; } })(),
        source_platform: "feed", source_item_id: pick(r, "id", "handle", "sku"), variants: [],
      };
      byKey.set(key, it);
    } else if (img && !it.images.includes(img) && /^https?:\/\//.test(img)) it.images.push(img);
    if (optName && optVal && optVal !== "Default Title") {
      it.variants.push({ sku: pick(r, "variant sku") || null, barcode: pick(r, "variant barcode") || null, price, stock, attributes: { [optName]: optVal } });
    }
  }
  return [...byKey.values()].filter((i) => i.name);
}
