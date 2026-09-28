// Supabase Edge Function: stock-price-monitor
// CJ Dropshipping ürünlerinin stok ve maliyetini tedarikçiden kontrol eder.
// - Stok bitince ürünün stok durumunu "tukendi" yapar, mağaza vitrininden gizler
//   (stok gelince, sadece bu fonksiyonun gizlediği ürünü tekrar açar).
// - Maliyet değişince notlar; auto_price açıksa satış fiyatını aynı oranda günceller.
// Çağrı şekilleri:
//   1) Kullanıcı: { userAccessToken }  -> sadece kendi ürünleri
//   2) Zamanlanmış görev: { cronSecret } -> herkesin ürünleri (CRON_SECRET tanımlıysa)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";
const CJ_API_KEY_DEFAULT = Deno.env.get("CJ_API_KEY") || "";

const AUTH_URL = "https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken";
const PRODUCT_QUERY_URL = "https://developers.cjdropshipping.com/api2.0/v1/product/query";
const STOCK_URL = "https://developers.cjdropshipping.com/api2.0/v1/product/stock/queryByVid";

const MAX_PRODUCTS = 25; // 150 sn süre sınırı ve CJ hız sınırı için
const LOW_STOCK = 5;

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).split("--")[0].trim());
  return isFinite(n) ? n : null;
}

// CJ stok cevabı farklı biçimlerde gelebildiği için toleranslı okuyoruz
function sumStock(d: any): number | null {
  const pick = (x: any) => toNum(x?.storageNum ?? x?.totalInventoryNum ?? x?.inventoryNum ?? x?.totalInventory);
  if (Array.isArray(d)) {
    let total = 0, found = false;
    for (const x of d) {
      const n = pick(x);
      if (n !== null) { total += n; found = true; }
    }
    return found ? total : null;
  }
  if (d && typeof d === "object") {
    if (Array.isArray(d.inventories)) return sumStock(d.inventories);
    return pick(d);
  }
  return null;
}

async function getCjToken(apiKey: string): Promise<string | null> {
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  const data = await res.json().catch(() => null);
  return data?.data?.accessToken || null;
}

async function queryProduct(pid: string, token: string): Promise<any> {
  const pRes = await fetch(`${PRODUCT_QUERY_URL}?pid=${encodeURIComponent(pid)}`, {
    headers: { "CJ-Access-Token": token },
  });
  return await pRes.json().catch(() => null);
}

async function checkProduct(p: any, token: string, db: any) {
  const out: any = { id: p.id, name: p.name };
  try {
    // 1) maliyet: ürünün varyantından (boş gelirse 2 sn sonra bir kez daha dene)
    let pData = await queryProduct(p.supplier_item_id, token);
    let variants = pData?.data?.variants || [];
    if (variants.length === 0) {
      await sleep(2000);
      pData = await queryProduct(p.supplier_item_id, token);
      variants = pData?.data?.variants || [];
    }
    if (variants.length === 0) {
      throw new Error("CJ'de varyant bulunamadı: " + JSON.stringify(pData).slice(0, 250));
    }
    const v = variants.find((x: any) => x.vid === p.supplier_variant_id) || variants[0];
    const vid = v.vid;
    const cost = toNum(v.variantSellPrice ?? v.sellPrice);

    await sleep(1100);

    // 2) stok
    let stock: number | null = null;
    try {
      const sRes = await fetch(`${STOCK_URL}?vid=${encodeURIComponent(vid)}`, {
        headers: { "CJ-Access-Token": token },
      });
      const sData = await sRes.json();
      stock = sumStock(sData?.data);
      if (stock === null) out.stockRaw = JSON.stringify(sData).slice(0, 300);
    } catch (e) {
      out.stockRaw = "stok hatası: " + String(e).slice(0, 200);
    }

    // 3) kararlar
    const update: any = { last_checked_at: new Date().toISOString() };
    const notes: string[] = [];

    if (cost !== null) update.supplier_cost = cost;

    if (stock !== null) {
      update.stock_qty = stock;
      const status = stock <= 0 ? "tukendi" : stock <= LOW_STOCK ? "az" : "stokta";
      update.stock_status = status;
      if (status === "tukendi") {
        update.store_visible = false; // vitrinden gizle
        notes.push("Stok bitti, vitrinden gizlendi");
      } else if (p.stock_status === "tukendi") {
        update.store_visible = true; // sadece bizim gizlediğimizi geri aç
        notes.push("Stok geldi, vitrine geri açıldı");
      } else if (status === "az") {
        notes.push("Stok azaldı: " + stock);
      }
    } else {
      notes.push("Stok okunamadı");
    }

    const oldCost = toNum(p.supplier_price);
    if (cost !== null && oldCost && oldCost > 0 && Math.abs(cost - oldCost) / oldCost >= 0.03) {
      const ratio = cost / oldCost;
      notes.push(`Maliyet ${oldCost} -> ${cost}`);
      if (p.auto_price && toNum(p.sale_price)) {
        const newSale = Math.round(toNum(p.sale_price)! * ratio * 100) / 100;
        update.sale_price = newSale;
        update.supplier_price = cost;
        notes.push(`Satış fiyatı otomatik ${p.sale_price} -> ${newSale}`);
      }
    }

    update.monitor_note = notes.join(" | ") || "Değişiklik yok";
    const { error } = await db.from("products").update(update).eq("id", p.id);
    if (error) throw new Error("Kayıt hatası: " + error.message);

    out.cost = cost;
    out.stock = stock;
    out.status = update.stock_status || p.stock_status;
    out.note = update.monitor_note;
  } catch (e) {
    out.error = String(e).slice(0, 400);
    await db.from("products").update({
      last_checked_at: new Date().toISOString(),
      monitor_note: "Kontrol hatası: " + String(e).slice(0, 150),
    }).eq("id", p.id);
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { userAccessToken, cronSecret } = await req.json().catch(() => ({}));

    let db: any;
    let products: any[] = [];
    const keyByUser: Record<string, string> = {};

    const cols = "id, user_id, name, supplier, supplier_item_id, supplier_variant_id, supplier_price, sale_price, auto_price, stock_status";

    if (cronSecret && CRON_SECRET && cronSecret === CRON_SECRET && SERVICE_KEY) {
      db = createClient(SUPABASE_URL, SERVICE_KEY);
      const { data } = await db.from("user_integrations").select("user_id, api_key").eq("platform", "cj");
      for (const r of data || []) if (r.api_key) keyByUser[r.user_id] = r.api_key;
    } else if (userAccessToken) {
      db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: "Bearer " + userAccessToken } },
      });
      const { data: u } = await db.auth.getUser(userAccessToken);
      if (!u?.user) return json({ error: "Oturum geçersiz" }, 401);
      const { data } = await db.from("user_integrations").select("api_key").eq("platform", "cj").maybeSingle();
      if (data?.api_key) keyByUser[u.user.id] = data.api_key;
    } else {
      return json({ error: "Yetki bilgisi gerekli" }, 401);
    }

    const { data: list, error: listErr } = await db
      .from("products")
      .select(cols)
      .eq("supplier", "cj")
      .not("supplier_item_id", "is", null)
      .order("last_checked_at", { ascending: true, nullsFirst: true })
      .limit(MAX_PRODUCTS);
    if (listErr) return json({ error: "Ürünler okunamadı: " + listErr.message }, 500);
    products = list || [];

    if (products.length === 0) {
      return json({ checked: 0, message: "Kontrol edilecek CJ ürünü yok" });
    }

    // Her kullanıcı için (ya da paylaşımlı anahtarla) bir kez CJ girişi yap
    const tokens: Record<string, string | null> = {};
    const results: any[] = [];
    for (const p of products) {
      const apiKey = keyByUser[p.user_id] || CJ_API_KEY_DEFAULT;
      if (!apiKey) { results.push({ id: p.id, name: p.name, error: "CJ anahtarı yok" }); continue; }
      if (!(apiKey in tokens)) tokens[apiKey] = await getCjToken(apiKey);
      const token = tokens[apiKey];
      if (!token) { results.push({ id: p.id, name: p.name, error: "CJ girişi başarısız" }); continue; }
      results.push(await checkProduct(p, token, db));
      await sleep(1100);
    }

    return json({ checked: results.length, results });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});