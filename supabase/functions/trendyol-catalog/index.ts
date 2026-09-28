// =========================================================
// HızlıSatıcı AI - trendyol-catalog
// Trendyol'un kategori ağacını, kategori özelliklerini ve markalarını
// çekip kendi tablolarımızda saklar (her üründe Trendyol'a tekrar sormamak için).
//
// action = "categories"  -> tüm kategori ağacını yeniler (sadece zamanlanmış görev / sunucu)
// action = "attributes"  -> { category_id } kategorinin özellikleri (7 gün önbellek)
// action = "brands"      -> { q } marka arar (önce kendi tablomuz, yoksa Trendyol)
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

// İsteğe bağlı: ileride Trendyol hesabı olunca eklenecek sırlar
const TY_SELLER = Deno.env.get("TRENDYOL_SELLER_ID") ?? "";
const TY_KEY = Deno.env.get("TRENDYOL_API_KEY") ?? "";
const TY_SECRET = Deno.env.get("TRENDYOL_API_SECRET") ?? "";

const TY_BASE = "https://apigw.trendyol.com/integration/product";
const ATTR_CACHE_DAYS = 7;

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errMsg(e) {
  if (!e) return "unknown_error";
  if (typeof e === "string") return e;
  return e.message || JSON.stringify(e);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------
// Trendyol'a istek
// ---------------------------------------------------------
function tyHeaders() {
  const h = {
    "Accept": "application/json",
    "User-Agent": (TY_SELLER || "HizliSatici") + " - SelfIntegration",
  };
  if (TY_KEY && TY_SECRET) h["Authorization"] = "Basic " + btoa(TY_KEY + ":" + TY_SECRET);
  return h;
}

async function tyGet(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(TY_BASE + path, { headers: tyHeaders() });
    if (res.status === 429) {           // hız sınırı: biraz bekle, tekrar dene
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      const t = await res.text();
      throw new Error("trendyol_" + res.status + ": " + t.slice(0, 300));
    }
    return await res.json();
  }
  throw new Error("trendyol_429: rate_limited");
}

// ---------------------------------------------------------
// 1) Kategori ağacı
// ---------------------------------------------------------
async function refreshCategories() {
  const started = Date.now();
  const data = await tyGet("/product-categories");
  const list = Array.isArray(data) ? data : (data.categories || []);
  const now = new Date().toISOString();
  const rows = [];

  const walk = (items, parentId, parentPath) => {
    for (const c of items || []) {
      if (!c || c.id == null) continue;
      const path = parentPath ? parentPath + " > " + c.name : c.name;
      const subs = c.subCategories || [];
      rows.push({
        id: c.id,
        parent_id: parentId,
        name: c.name,
        path,
        is_leaf: subs.length === 0,
        updated_at: now,
      });
      walk(subs, c.id, path);
    }
  };
  walk(list, null, "");

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("trendyol_categories").upsert(rows.slice(i, i + 500), { onConflict: "id" });
    if (error) throw error;
  }

  const result = { ok: true, categories: rows.length, leaf: rows.filter((r) => r.is_leaf).length, ms: Date.now() - started };
  console.log(JSON.stringify({ action: "categories", ...result }));
  return result;
}

// ---------------------------------------------------------
// 2) Kategori özellikleri
// ---------------------------------------------------------
async function getAttributes(categoryId, force) {
  const { data: cached, error: cErr } = await db
    .from("trendyol_category_attributes")
    .select("*")
    .eq("category_id", categoryId)
    .order("required", { ascending: false })
    .order("name");
  if (cErr) throw cErr;

  if (!force && cached && cached.length) {
    const age = Date.now() - new Date(cached[0].updated_at).getTime();
    if (age < ATTR_CACHE_DAYS * 86400000) return { source: "cache", attributes: cached };
  }

  const data = await tyGet("/product-categories/" + encodeURIComponent(categoryId) + "/attributes");
  const now = new Date().toISOString();
  const rows = (data.categoryAttributes || [])
    .filter((a) => a && a.attribute && a.attribute.id != null)
    .map((a) => ({
      category_id: categoryId,
      attribute_id: a.attribute.id,
      name: a.attribute.name,
      required: !!a.required,
      allow_custom: !!a.allowCustom,
      allow_multiple: !!a.allowMultipleAttributeValues,
      varianter: !!a.varianter,
      slicer: !!a.slicer,
      attribute_values: (a.attributeValues || []).map((v) => ({ id: v.id, name: v.name })),
      updated_at: now,
    }));

  await db.from("trendyol_category_attributes").delete().eq("category_id", categoryId);
  if (rows.length) {
    const { error } = await db.from("trendyol_category_attributes").insert(rows);
    if (error) throw error;
  }
  rows.sort((a, b) => (Number(b.required) - Number(a.required)) || String(a.name).localeCompare(String(b.name)));
  return { source: "trendyol", attributes: rows };
}

// ---------------------------------------------------------
// 3) Marka arama
// ---------------------------------------------------------
async function searchBrands(q) {
  const term = String(q || "").trim();
  if (term.length < 2) return { source: "none", brands: [] };

  const safe = term.replace(/[\\%_]/g, (m) => "\\" + m);
  const { data: cached, error: cErr } = await db
    .from("trendyol_brands")
    .select("id, name")
    .ilike("name", "%" + safe + "%")
    .order("name")
    .limit(20);
  if (cErr) throw cErr;

  const exact = (cached || []).some((b) => String(b.name).toLowerCase() === term.toLowerCase());
  if (exact) return { source: "cache", brands: cached };

  let found = [];
  try {
    const data = await tyGet("/brands/by-name?name=" + encodeURIComponent(term));
    found = (Array.isArray(data) ? data : (data.brands || []))
      .filter((b) => b && b.id != null)
      .map((b) => ({ id: b.id, name: b.name }));
  } catch (e) {
    // Trendyol cevap vermezse elimizdekini döndür
    return { source: "cache", brands: cached || [], warning: errMsg(e) };
  }

  if (found.length) {
    const now = new Date().toISOString();
    await db.from("trendyol_brands").upsert(found.map((b) => ({ ...b, updated_at: now })), { onConflict: "id" });
  }

  const map = new Map();
  for (const b of [...found, ...(cached || [])]) map.set(String(b.id), b);
  return { source: "trendyol", brands: Array.from(map.values()).slice(0, 20) };
}

// ---------------------------------------------------------
// Giriş noktası
// ---------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  let body = {};
  try { body = (await req.clone().json()) || {}; } catch (_) { body = {}; }

  // Yetki: zamanlanmış görev şifresi / sunucu anahtarı ya da giriş yapmış kullanıcı
  const candidates = [];
  req.headers.forEach((value) => {
    if (!value) return;
    candidates.push(value.trim());
    if (value.startsWith("Bearer ")) candidates.push(value.slice(7).trim());
  });
  url.searchParams.forEach((value) => candidates.push(String(value).trim()));
  if (body && typeof body === "object") {
    Object.values(body).forEach((v) => { if (typeof v === "string") candidates.push(v.trim()); });
  }
  const isServer =
    (!!CRON_SECRET && candidates.includes(CRON_SECRET.trim())) ||
    (!!SERVICE_KEY && candidates.includes(SERVICE_KEY.trim()));

  let userId = null;
  if (!isServer) {
    const auth = req.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (token) {
      const { data } = await db.auth.getUser(token);
      if (data && data.user) userId = data.user.id;
    }
    if (!userId) return json({ ok: false, error: "unauthorized" }, 401);
  }

  const action = String(body.action || url.searchParams.get("action") || "categories");

  try {
    if (action === "categories") {
      if (!isServer) return json({ ok: false, error: "forbidden" }, 403);
      // Uzun sürebilir: hemen cevap ver, işi arka planda bitir
      const job = refreshCategories().catch((e) => console.error("categories_failed", errMsg(e)));
      // @ts-ignore EdgeRuntime Supabase'de hazır gelir
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(job);
        return json({ ok: true, started: true }, 202);
      }
      return json(await job);
    }

    if (action === "attributes") {
      const categoryId = Number(body.category_id || url.searchParams.get("category_id"));
      if (!categoryId) return json({ ok: false, error: "category_id_required" }, 400);
      const force = body.force === true && isServer;
      return json({ ok: true, category_id: categoryId, ...(await getAttributes(categoryId, force)) });
    }

    if (action === "brands") {
      const q = body.q || url.searchParams.get("q") || "";
      return json({ ok: true, ...(await searchBrands(q)) });
    }

    return json({ ok: false, error: "unknown_action" }, 400);
  } catch (e) {
    const msg = errMsg(e).slice(0, 500);
    console.error(action, msg);
    return json({ ok: false, error: msg }, 502);
  }
});