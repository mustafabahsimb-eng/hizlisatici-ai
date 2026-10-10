// =========================================================
// Seltigo - cj-alt-match (AliExpress ürününün CJ eşdeğerini arka planda bulur)
// Neden: AliExpress API ile ödeme (API Pay) her satıcıda açık değil (Türkiye desteklenmiyor).
// Eşdeğer bulunursa sipariş işçisi siparişi CJ'den verip CJ bakiyesinden öder.
// Yol: 1) CJ görselle arama (anında; ad benzerliği yeterliyse kabul)
//      2) olmazsa CJ sourcing talebi (CJ ekibi eşdeğeri bulur) -> zamanlanmış görev sonucu izler
// Durum: products.cj_alt_status = searching | sourcing | found | not_found | error
// Çağıranlar: zamanlanmış görev (CRON_SECRET), Ürün Ekle (satıcı oturumu, { productId }),
// sistem ({ cronSecret, productId, debug }).
// CJ hesabı: satıcının kendi hesabı, yoksa sitenin hesabı (ürün kodları CJ'de herkes için aynı).
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const CJ_API_KEY_SITE = Deno.env.get("CJ_API_KEY") ?? "";
const CJ = "https://developers.cjdropshipping.com/api2.0/v1";

const MIN_TITLE_SCORE = 0.3;        // görselle aramada ad benzerliği eşiği
const RECHECK_MINUTES = 60;         // sourcing sonucunu ne sıklıkla sor
const MAX_PRODUCTS = 15;
const TIME_BUDGET_MS = 45000;

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
const short = (v: unknown, n = 300) => String(v ?? "").slice(0, n);

// ---------------------------------------------------------
const tokenCache = new Map<string, string | null>();
// CJ giriş anahtarı: 180 gün geçerli, getAccessToken saniyede en fazla 1 çağrı kabul ediyor.
// Bu yüzden anahtar veritabanında (cj_tokens, sadece sunucu) saklanıp tüm fonksiyonlarca paylaşılır.
const cjTokenMemo = new Map<string, string>();
async function cjAccessToken(apiKey: string): Promise<string | null> {
  if (!apiKey) return null;
  if (cjTokenMemo.has(apiKey)) return cjTokenMemo.get(apiKey)!;
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey))))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const { data: row } = await admin.from("cj_tokens").select("access_token, expires_at").eq("key_hash", hash).maybeSingle();
  if (row?.access_token && new Date(row.expires_at).getTime() > Date.now() + 86400000) {
    cjTokenMemo.set(apiKey, row.access_token);
    return row.access_token;
  }
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch("https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey }),
      });
      const d = await r.json().catch(() => ({}));
      const t = d?.data?.accessToken;
      if (t) {
        const exp = new Date(d.data.accessTokenExpiryDate || "");
        await admin.from("cj_tokens").upsert({
          key_hash: hash, access_token: t,
          expires_at: (isNaN(exp.getTime()) ? new Date(Date.now() + 14 * 86400000) : exp).toISOString(),
          updated_at: new Date().toISOString(),
        });
        cjTokenMemo.set(apiKey, t);
        return t;
      }
    } catch (_) { /* tekrar dene */ }
    await new Promise((res) => setTimeout(res, 1100 * (i + 1))); // saniyede 1 çağrı sınırı
  }
  return null;
}
async function cjToken(apiKey: string): Promise<string | null> {
  return await cjAccessToken(apiKey);
}
async function cj(token: string, path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(`${CJ}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "CJ-Access-Token": token, ...(init.headers || {}) },
  });
  const d = await r.json().catch(() => ({ result: false, message: `HTTP ${r.status}` }));
  return { ...d, _http: r.status };
}

// Ad benzerliği (kelime örtüşmesi, 0..1)
const STOP = new Set(["for", "and", "with", "the", "a", "of", "to", "in", "new", "2024", "2025", "2026", "hot", "sale"]);
function words(s: string): Set<string> {
  return new Set(String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
}
function titleScore(a: string, b: string): number {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((w) => { if (B.has(w)) inter++; });
  return inter / Math.min(A.size, B.size);
}

// CJ ürününden seçenek (vid) ve maliyet (ürün + Türkiye'ye en ucuz kargo, USD)
async function pickVariantAndCost(token: string, pid: string, sku: string | null, country = "TR") {
  const pd = await cj(token, `/product/query?pid=${encodeURIComponent(pid)}`, { method: "GET" });
  const variants = pd?.data?.variants || [];
  if (!variants.length) return { error: "CJ ürününde seçenek yok" };
  const v = (sku && variants.find((x: any) => x.variantSku === sku)) ||
    [...variants].sort((a: any, b: any) => Number(a.variantSellPrice ?? 1e9) - Number(b.variantSellPrice ?? 1e9))[0];
  const fr = await cj(token, "/logistic/freightCalculate", {
    method: "POST",
    body: JSON.stringify({ startCountryCode: "CN", endCountryCode: country, products: [{ quantity: 1, vid: v.vid }] }),
  });
  const ship = (Array.isArray(fr?.data) ? fr.data : [])
    .map((x: any) => Number(x.totalPostageFee ?? x.logisticPrice))
    .filter((n: number) => Number.isFinite(n) && n >= 0)
    .sort((a: number, b: number) => a - b)[0];
  const price = Number(v.variantSellPrice ?? pd?.data?.sellPrice);
  return {
    vid: String(v.vid),
    label: v.variantNameEn || v.variantKey || null,
    cost: Number.isFinite(price) && ship != null ? Math.round((price + ship) * 100) / 100 : null,
    noShipping: ship == null,
    productName: pd?.data?.productNameEn || null,
  };
}

async function save(id: number, patch: Record<string, unknown>) {
  await db.from("products").update({ ...patch, cj_alt_checked_at: new Date().toISOString() }).eq("id", id);
}

async function processProduct(p: any, debug = false): Promise<any> {
  const trace: any = {};
  // CJ hesabı: satıcınınki, yoksa sitenin
  const { data: integ } = await db.from("user_integrations").select("api_key").eq("user_id", p.user_id).eq("platform", "cj").maybeSingle();
  const key = integ?.api_key || CJ_API_KEY_SITE;
  const token = key ? await cjToken(key) : null;
  if (!token) {
    await save(p.id, { cj_alt_status: "error", cj_alt_note: "CJ hesabına giriş yapılamadı" });
    return { id: p.id, status: "error" };
  }

  // Görsel
  let image = p.image_url as string | null;
  if (!image) {
    const { data: img } = await db.from("product_images").select("url").eq("product_id", p.id).order("position").limit(1).maybeSingle();
    image = img?.url || null;
  }

  // ---- 1) Sourcing talebi zaten açıksa: sonucu sor
  if (p.cj_alt_status === "sourcing" && p.cj_alt_sourcing_id) {
    const q = await cj(token, `/product/sourcing/queryList?sourceIds=${encodeURIComponent(p.cj_alt_sourcing_id)}`, { method: "GET" });
    if (debug) trace.sourcingQuery = JSON.stringify(q).slice(0, 1200);
    const s = Array.isArray(q?.data) ? q.data[0] : null;
    const st = Number(s?.sourceStatus);
    if (st === 3 && s?.cjProductId) {
      const v = await pickVariantAndCost(token, String(s.cjProductId), s.cjVariantSku || null);
      if ((v as any).error) {
        await save(p.id, { cj_alt_status: "not_found", cj_alt_note: (v as any).error });
        return { id: p.id, status: "not_found", ...trace };
      }
      await save(p.id, {
        cj_alt_status: "found", cj_alt_source: "sourcing", cj_alt_pid: String(s.cjProductId), cj_alt_vid: (v as any).vid,
        cj_alt_cost_usd: (v as any).cost,
        cj_alt_note: "CJ ekibi eşdeğerini buldu" + ((v as any).label ? ` (seçenek: ${(v as any).label})` : "") + ((v as any).noShipping ? "; Türkiye'ye kargo seçeneği yok" : ""),
      });
      return { id: p.id, status: "found", source: "sourcing", ...trace };
    }
    if (st === 5) {
      await save(p.id, { cj_alt_status: "not_found", cj_alt_note: "CJ bu ürünün eşdeğerini bulamadı" + (s?.failReasonStr ? `: ${short(s.failReasonStr, 150)}` : "") });
      return { id: p.id, status: "not_found", ...trace };
    }
    await save(p.id, { cj_alt_note: "CJ ekibi eşdeğerini arıyor" + (s?.sourceStatusStr ? ` (${short(s.sourceStatusStr, 60)})` : "") });
    return { id: p.id, status: "sourcing", ...trace };
  }

  // ---- 2) Görselle arama (anında)
  if (image) {
    const r = await cj(token, "/product/queryProductsByImage", { method: "POST", body: JSON.stringify({ imageUrl: image }) });
    if (debug) trace.imageSearch = JSON.stringify(r).slice(0, 1500);
    const raw = Array.isArray(r?.data) ? r.data : (r?.data?.list || r?.data?.content || r?.data?.productList || []);
    const cands = (Array.isArray(raw) ? raw : []).map((c: any) => ({
      pid: String(c.pid || c.productId || c.id || ""),
      name: c.productNameEn || c.nameEn || c.productName || "",
    })).filter((c: any) => c.pid);
    const best = cands
      .map((c: any) => ({ ...c, score: titleScore(p.name, c.name) }))
      .sort((a: any, b: any) => b.score - a.score)[0];
    if (debug) trace.best = best;
    if (best && best.score >= MIN_TITLE_SCORE) {
      const v = await pickVariantAndCost(token, best.pid, null);
      if (!(v as any).error && !(v as any).noShipping) {
        await save(p.id, {
          cj_alt_status: "found", cj_alt_source: "image", cj_alt_pid: best.pid, cj_alt_vid: (v as any).vid,
          cj_alt_cost_usd: (v as any).cost,
          cj_alt_note: `CJ'de görselle bulundu (benzerlik %${Math.round(best.score * 100)})` + ((v as any).label ? `, seçenek: ${(v as any).label}` : ""),
        });
        return { id: p.id, status: "found", source: "image", ...trace };
      }
    }
  }

  // ---- 3) Sourcing talebi aç (CJ ekibi bulur)
  if (!image) {
    await save(p.id, { cj_alt_status: "not_found", cj_alt_note: "Üründe görsel yok; CJ'de eşdeğeri aranamadı" });
    return { id: p.id, status: "not_found", ...trace };
  }
  const itemId = String(p.supplier_item_id || "").replace(/\D/g, "");
  const created = await cj(token, "/product/sourcing/create", {
    method: "POST",
    body: JSON.stringify({
      productName: short(p.name, 200),
      productImage: short(image, 200),
      productUrl: itemId ? `https://www.aliexpress.com/item/${itemId}.html` : undefined,
      thirdProductId: itemId || undefined,
      thirdVariantId: p.supplier_variant_id ? String(p.supplier_variant_id) : undefined,
      price: p.supplier_cost != null ? Number(p.supplier_cost) : undefined,
      remark: "Seltigo: equivalent of an AliExpress product for dropshipping",
    }),
  });
  if (debug) trace.sourcingCreate = JSON.stringify(created).slice(0, 800);
  const sid = created?.data?.cjSourcingId || created?.data?.sourceId || created?.data;
  if (!created?.result || !sid || typeof sid === "object") {
    await save(p.id, { cj_alt_status: "error", cj_alt_note: "CJ eşdeğer talebi açılamadı: " + short(created?.message, 150) });
    return { id: p.id, status: "error", ...trace };
  }
  await save(p.id, { cj_alt_status: "sourcing", cj_alt_sourcing_id: String(sid), cj_alt_note: "CJ ekibi eşdeğerini arıyor" });
  return { id: p.id, status: "sourcing", ...trace };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const body = await req.json().catch(() => ({}));
  const isCron = !!CRON_SECRET && String(body?.cronSecret || "").trim() === CRON_SECRET.trim();

  try {
    // Tek ürün: satıcı (kendi ürünü) ya da sistem
    if (body?.productId != null) {
      let q = db.from("products").select("*").eq("id", Number(body.productId)).eq("supplier", "aliexpress").is("deleted_at", null);
      if (!isCron) {
        const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
        const { data: u } = bearer.split(".").length === 3 ? await db.auth.getUser(bearer) : { data: { user: null } };
        if (!u?.user?.id) return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);
        q = q.eq("user_id", u.user.id);
      }
      const { data: p } = await q.maybeSingle();
      if (!p) return json({ error: "AliExpress ürünü bulunamadı" }, 404);
      if (!isCron && p.cj_alt_status === "found") return json({ ok: true, id: p.id, status: "found" });
      return json({ ok: true, ...(await processProduct(p, isCron && body?.debug === true)) });
    }

    if (!isCron) return json({ error: "unauthorized" }, 401);

    // Zamanlanmış: yeni AliExpress ürünleri + sonucu beklenen sourcing talepleri
    const started = Date.now();
    const recheckBefore = new Date(Date.now() - RECHECK_MINUTES * 60000).toISOString();
    const { data: list, error } = await db.from("products")
      .select("*")
      .eq("supplier", "aliexpress").is("deleted_at", null)
      .or(`cj_alt_status.is.null,and(cj_alt_status.in.(searching,sourcing),cj_alt_checked_at.lt.${recheckBefore})`)
      .order("created_at", { ascending: true })
      .limit(MAX_PRODUCTS);
    if (error) throw error;
    const results: any[] = [];
    for (const p of list || []) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      try { results.push(await processProduct(p)); } catch (e) { results.push({ id: p.id, error: short((e as Error).message) }); }
    }
    return json({ ok: true, processed: results.length, results });
  } catch (e) {
    return json({ ok: false, error: short((e as Error).message) }, 500);
  }
});
