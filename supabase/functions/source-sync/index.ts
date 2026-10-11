// =========================================================
// Seltigo - source-sync (linkten yüklenen ürünlerin fiyat/stoğunu kaynağından güncel tutar)
// Toplu Ürün Yükleme'de "Fiyat ve stoğu otomatik güncel tut" seçilen ürünler (products.source_sync)
// seçilen aralıkta (6 saat / günde bir) kaynak sayfadan yeniden okunur (product-import, sistem çağrısı):
//   - Kaynak fiyatı değişince maliyet güncellenir; satış fiyatı aynı oranda güncellenir (kâr oranı korunur),
//     kendi mağazadaki ilan fiyatı da. Böylece maliyet artışı zarara dönmez.
//   - Stok biterse ürün vitrinden gizlenir; stok gelince (yalnız bizim gizlediğimiz) geri açılır.
//   - Seçeneklerin (beden/renk) maliyet ve stoğu ayrı ayrı güncellenir.
//   - Kaynak sayfa kaldırıldıysa (404/410) ürün "tükendi" sayılır ve gizlenir.
// Çağıranlar: zamanlanmış görev (CRON_SECRET), sistem denemesi { cronSecret, productId }.
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";

import { featureEnabled, FEATURE_OFF_MSG } from "../_shared/features.ts";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const MAX_PRODUCTS = 25;
const TIME_BUDGET_MS = 110_000;
const MIN_CHANGE = 0.01; // %1'den küçük fiyat oynamaları yok sayılır
const LOW_STOCK = 5;

const db = createClient(SUPABASE_URL, SERVICE_KEY);
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const short = (v: unknown, n = 200) => String(v ?? "").slice(0, n);
// Boş / bilinmeyen değer 0 sayılmaz (Number(null) = 0 tuzağı)
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

async function readSource(p: any) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/product-import`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
    body: JSON.stringify({ url: p.source_url, cronSecret: CRON_SECRET, userId: p.user_id, language: "tr" }),
  });
  return await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
}

function stockStatus(n: number | null, current: string | null): string | null {
  if (n === null) return current;
  return n <= 0 ? "tukendi" : n <= LOW_STOCK ? "az" : "stokta";
}

async function syncProduct(p: any) {
  const now = new Date().toISOString();
  const out: any = { id: p.id };
  const res = await readSource(p);

  // Kaynak sayfa kaldırılmış
  if (res?.httpStatus === 404 || res?.httpStatus === 410) {
    const upd: any = { source_checked_at: now, source_note: "Kaynak sayfa kaldırılmış; ürün tükendi sayıldı", stock_qty: 0, stock_status: "tukendi" };
    if (p.store_visible) upd.store_visible = false;
    await db.from("products").update(upd).eq("id", p.id);
    return { ...out, status: "removed" };
  }
  const it = res?.kind === "product" ? res.item : null;
  if (!it) {
    await db.from("products").update({ source_checked_at: now, source_note: "Kaynak okunamadı: " + short(res?.error || "ürün bilgisi yok", 150) }).eq("id", p.id);
    return { ...out, error: short(res?.error || "ürün yok") };
  }

  const notes: string[] = [];
  const upd: any = { source_checked_at: now };
  let ratio: number | null = null;

  // Fiyat (aynı para biriminde ise)
  const newCost = num(it.price);
  const oldCost = num(p.supplier_price);
  const sameCur = !it.currency || !p.cost_currency || String(it.currency).toUpperCase() === String(p.cost_currency).toUpperCase();
  if (newCost && newCost > 0 && sameCur) {
    if (oldCost && oldCost > 0 && Math.abs(newCost - oldCost) / oldCost >= MIN_CHANGE) {
      ratio = newCost / oldCost;
      upd.supplier_price = newCost;
      notes.push(`Kaynak fiyatı ${oldCost} → ${newCost}`);
      const sale = num(p.sale_price);
      if (sale && sale > 0) {
        upd.sale_price = round2(sale * ratio);
        notes.push(`Satış fiyatı ${sale} → ${upd.sale_price}`);
      }
    } else if (!oldCost) {
      upd.supplier_price = newCost;
    }
  } else if (newCost && !sameCur) {
    notes.push(`Kaynak para birimi değişti (${it.currency}); fiyat güncellenmedi`);
  }

  // Stok
  const vs: any[] = Array.isArray(it.variants) ? it.variants : [];
  let stock: number | null = num(it.stock);
  if (stock === null && vs.length && vs.every((v) => num(v.stock) !== null)) stock = vs.reduce((a, v) => a + Number(v.stock), 0);
  if (stock !== null) {
    upd.stock_qty = stock;
    const st = stockStatus(stock, p.stock_status);
    upd.stock_status = st;
    if (st === "tukendi" && p.stock_status !== "tukendi") {
      if (p.store_visible) upd.store_visible = false;
      notes.push("Stok bitti, vitrinden gizlendi");
    } else if (st !== "tukendi" && p.stock_status === "tukendi") {
      upd.store_visible = true; // yalnız stok bitince bizim gizlediğimiz ürün
      notes.push("Stok geldi, vitrine geri açıldı");
    }
  }
  upd.source_note = notes.join(" | ") || "Değişiklik yok";
  const { error } = await db.from("products").update(upd).eq("id", p.id);
  if (error) throw new Error("Kayıt hatası: " + error.message);

  // Kendi mağazadaki ilan fiyatı
  if (ratio) {
    const { data: ls } = await db.from("listings").select("id, price").eq("product_id", p.id).eq("marketplace_code", "own_store");
    for (const l of ls || []) {
      const np = round2(Number(l.price || 0) * ratio);
      if (np > 0) {
        await db.from("listings").update({ price: np }).eq("id", l.id);
        await db.from("listing_variants").update({ price: np }).eq("listing_id", l.id);
      }
    }
  }

  // Seçenekler
  if (vs.length) {
    const { data: mine } = await db.from("product_variants").select("id, supplier_variant_id, cost, stock_qty")
      .eq("product_id", p.id).eq("is_default", false).is("deleted_at", null);
    const byId = new Map<string, any>();
    vs.forEach((v) => { if (v?.supplier_variant_id) byId.set(String(v.supplier_variant_id), v); });
    for (const m of mine || []) {
      const v = byId.get(String(m.supplier_variant_id || ""));
      if (!v) continue;
      const vu: any = {};
      const c = num(v.price);
      if (c && c > 0 && sameCur && c !== Number(m.cost)) vu.cost = c;
      const s = num(v.stock);
      if (s !== null && s !== m.stock_qty) { vu.stock_qty = s; vu.stock_status = stockStatus(s, null); }
      if (Object.keys(vu).length) await db.from("product_variants").update(vu).eq("id", m.id);
    }
  }
  return { ...out, note: upd.source_note };
}

Deno.serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  if (!CRON_SECRET || String(body?.cronSecret || "").trim() !== CRON_SECRET.trim()) return json({ error: "unauthorized" }, 401);
  const started = Date.now();
  try {
    const cols = "id, user_id, source_url, supplier_price, sale_price, cost_currency, stock_qty, stock_status, store_visible, source_sync_hours, source_checked_at";
    let list: any[] = [];
    if (body?.productId != null) {
      const { data } = await db.from("products").select(cols).eq("id", Number(body.productId)).maybeSingle();
      if (data) list = [data];
    } else {
      // Zamanı gelenler: hiç bakılmamış ya da aralığı (6 / 24 saat) dolmuş
      const sixAgo = new Date(Date.now() - 6 * 3600_000).toISOString();
      const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
      const { data, error } = await db.from("products").select(cols)
        .eq("source_sync", true).is("deleted_at", null).not("source_url", "is", null)
        .or(`source_checked_at.is.null,and(source_sync_hours.eq.6,source_checked_at.lt.${sixAgo}),source_checked_at.lt.${dayAgo}`)
        .order("source_checked_at", { ascending: true, nullsFirst: true })
        .limit(MAX_PRODUCTS);
      if (error) throw error;
      list = data || [];
    }
    const results: any[] = [];
    for (const p of list) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      if (!(await featureEnabled(p.user_id, "source_sync"))) { results.push({ id: p.id, skipped: "paket" }); continue; }
      try { results.push(await syncProduct(p)); } catch (e) {
        results.push({ id: p.id, error: short((e as Error).message) });
        await db.from("products").update({ source_checked_at: new Date().toISOString(), source_note: "Kontrol hatası: " + short((e as Error).message, 150) }).eq("id", p.id);
      }
    }
    return json({ ok: true, processed: results.length, results, ms: Date.now() - started });
  } catch (e) {
    return json({ ok: false, error: short((e as Error).message) }, 500);
  }
});
