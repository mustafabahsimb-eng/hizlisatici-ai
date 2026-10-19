// =========================================================
// Seltigo - kisisel-api (Mustafa'nın kişisel ürün aracı için tek kullanıcılı uç)
// Kimlik: başlık "x-kisisel-anahtar" = secret KISISEL_API_KEY; işlemler yalnız secret KISISEL_USER_ID (ya da KISISEL_EMAIL
// ile bulunan) hesapta yapılır.
// İkisinden biri yoksa uç kapalıdır (503). Yayın: --no-verify-jwt (kendi anahtarıyla doğrular).
//   { action: "ping" }                                   -> açık mı, hesap bulundu mu
//   { action: "channels" }                               -> bağlı mağazalar (mp:<id>, ig:<id>, wa) + Printify bağlı mı
//   { action: "publish", product: { name, description, price_try, images[], tags[], source_url }, channels: [...] }
//        -> product-ingest ile ürün + Kendi Mağazam ilanı, sonra seçili mağazalara gönderim (distributeProducts)
//   { action: "ads_plan" }                               -> Seltigo Ads planı (hangi ürün, ne bütçe; para harcamaz)
//   { action: "ads_launch" }                             -> kampanya ONAY BEKLER durumda açılır (Meta'da duraklatılmış);
//        Seltigo reklam kuralı "doğrudan yayın" ise reddedilir (onaysız para harcanmaz)
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { connectedChannels, distributeProducts } from "../_shared/distribute.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const API_KEY = (Deno.env.get("KISISEL_API_KEY") ?? "").trim();
let USER_ID = (Deno.env.get("KISISEL_USER_ID") ?? "").trim();
const EMAIL = (Deno.env.get("KISISEL_EMAIL") ?? "").trim().toLowerCase();

const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const clean = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

function sameKey(a: string, b: string) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0 && x.length > 0;
}

async function call(fn: string, body: Record<string, unknown>) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON}`, apikey: ANON },
    body: JSON.stringify({ ...body, cronSecret: CRON_SECRET, userId: USER_ID }), signal: AbortSignal.timeout(120000),
  });
  return await r.json().catch(() => ({ ok: false, error: `${fn}: yanıt okunamadı (${r.status})` }));
}

async function publish(b: any) {
  const p = b.product || {};
  const name = clean(p.name, 300);
  const price = Number(p.price_try);
  if (!name) return { ok: false, error: "Ürün adı yok" };
  if (!(price > 0)) return { ok: false, error: "Fiyat yok" };
  const images = (Array.isArray(p.images) ? p.images : []).map(String).filter((u: string) => /^https:\/\//i.test(u)).slice(0, 12);
  const want: string[] = (Array.isArray(b.channels) ? b.channels : []).map(String);
  // Ürün Mustafa'nın kendi tasarımı: kullanım hakkı onayı aracın yayın düğmesiyle verilir
  const ing = await call("product-ingest", {
    items: [{ name, description: String(p.description || "").slice(0, 8000), price, currency: "TRY", images, url: p.source_url || null, source_platform: "kisisel-arac" }],
    via: "kisisel-arac", sourceUrl: p.source_url || "kisisel-arac", salePrice: price, sync: false, consent: true, imageTerms: true, publish: true,
  });
  if (!ing?.ok || !ing.products?.length) return { ok: false, error: ing?.error || "Ürün kaydedilemedi" };
  const pid = Number(ing.products[0].id);
  if (Array.isArray(p.tags) && p.tags.length) await db.from("listings").update({ keywords: p.tags.slice(0, 13).map((t: unknown) => clean(t, 20)) }).eq("product_id", pid).eq("user_id", USER_ID);
  const out = want.length ? await distributeProducts(db, USER_ID, [pid], want) : {};
  return { ok: true, productId: pid, results: out };
}

// Aracın gönderdiği ürünler (kontrol için): silinmiş mi, bekleyen Instagram paylaşımı var mı
async function sent(b: any) {
  const since = new Date(Date.now() - Math.min(Number(b.sinceMinutes) || 1440, 30 * 1440) * 60000).toISOString();
  const { data: ps, error } = await db.from("products").select("id, name, created_at, deleted_at")
    .eq("user_id", USER_ID).eq("source_platform", "kisisel-arac").gte("created_at", since);
  if (error) throw error;
  const pids = (ps || []).map((p: any) => Number(p.id));
  const { data: posts } = pids.length ? await db.from("social_posts").select("product_id, status").in("product_id", pids).eq("user_id", USER_ID) : { data: [] };
  const { data: lis } = pids.length ? await db.from("listings").select("product_id, marketplace_code, deleted_at").in("product_id", pids).eq("user_id", USER_ID) : { data: [] };
  let catalog: unknown = "katalog yok";
  const { data: mc } = await db.from("meta_catalogs").select("catalog_id, user_token").eq("user_id", USER_ID).maybeSingle();
  if (pids.length && mc?.catalog_id && mc?.user_token) {
    const filter = JSON.stringify({ retailer_id: { is_any: pids.map((id) => `seltigo_${id}`) } });
    const r = await fetch(`https://graph.facebook.com/v21.0/${mc.catalog_id}/products?fields=retailer_id&filter=${encodeURIComponent(filter)}&access_token=${encodeURIComponent(mc.user_token)}`);
    const d = await r.json().catch(() => ({}));
    catalog = r.ok ? (d.data || []).map((x: any) => x.retailer_id) : `hata ${r.status}`;
  }
  return { ok: true, products: ps || [], posts: posts || [], listings: lis || [], catalog };
}

// Geri çek: ürün + ilanlar silinir (deleted_at), bekleyen Instagram paylaşımı iptal, WhatsApp / Meta kataloğundan kaldırılır
async function withdraw(b: any) {
  let q = db.from("products").select("id, name").eq("user_id", USER_ID).eq("source_platform", "kisisel-arac");
  const ids = (Array.isArray(b.productIds) ? b.productIds : []).map(Number).filter((x: number) => x > 0);
  if (ids.length) q = q.in("id", ids);
  else q = q.gte("created_at", new Date(Date.now() - Math.min(Number(b.sinceMinutes) || 180, 7 * 1440) * 60000).toISOString());
  const { data: ps, error } = await q;
  if (error) throw error;
  const pids = (ps || []).map((p: any) => Number(p.id));
  if (!pids.length) return { ok: true, withdrawn: [] };
  const now = new Date().toISOString();
  const r1 = await db.from("social_posts").update({ status: "error", error: "İptal: kişisel araç geri çekti", updated_at: now })
    .in("product_id", pids).eq("user_id", USER_ID).in("status", ["pending", "error"]).select("id");
  const r2 = await db.from("listings").update({ deleted_at: now }).in("product_id", pids).eq("user_id", USER_ID).is("deleted_at", null).select("id");
  const r3 = await db.from("products").update({ deleted_at: now, store_visible: false }).in("id", pids).eq("user_id", USER_ID).select("id");
  let catalog = "katalog yok";
  const { data: mc } = await db.from("meta_catalogs").select("catalog_id, user_token, excluded_ids").eq("user_id", USER_ID).maybeSingle();
  if (mc?.catalog_id && mc?.user_token) {
    const form = new URLSearchParams({ item_type: "PRODUCT_ITEM", access_token: mc.user_token,
      requests: JSON.stringify(pids.map((id) => ({ method: "DELETE", data: { id: `seltigo_${id}` } }))) });
    const r = await fetch(`https://graph.facebook.com/v21.0/${mc.catalog_id}/items_batch`, { method: "POST", body: form });
    catalog = r.ok ? "kaldırıldı: " + (await r.text()).slice(0, 200) : `hata ${r.status}: ${(await r.text()).slice(0, 200)}`;
    const ex = Array.from(new Set([...(Array.isArray(mc.excluded_ids) ? mc.excluded_ids.map(String) : []), ...pids.map(String)]));
    await db.from("meta_catalogs").update({ excluded_ids: ex, updated_at: now }).eq("user_id", USER_ID);
  }
  return { ok: true, withdrawn: ps, posts: r1.data?.length ?? r1.error?.message, listings: r2.data?.length ?? r2.error?.message,
    products: r3.data?.length ?? r3.error?.message, catalog };
}

async function adsLaunch() {
  const { data: r } = await db.from("ad_rules").select("approval_mode").eq("user_id", USER_ID).maybeSingle();
  if (r?.approval_mode === "direct") return { ok: false, error: "Seltigo reklam kuralı 'doğrudan yayın'; kişisel araç onaysız reklam açmaz. Seltigo Reklam ayarında onay modunu aç." };
  return await call("ads", { action: "launch" });
}

async function resolveUser() {
  if (USER_ID || !EMAIL) return;
  for (let page = 1; page <= 20 && !USER_ID; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error || !data?.users?.length) break;
    USER_ID = data.users.find((u: any) => String(u.email || "").toLowerCase() === EMAIL)?.id || "";
    if (data.users.length < 1000) break;
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST" }, 405);
  if (API_KEY && sameKey(String(req.headers.get("x-kisisel-anahtar") || "").trim(), API_KEY)) await resolveUser();
  if (!API_KEY || !USER_ID || !CRON_SECRET) return json({ ok: false, error: "Kişisel uç kapalı (anahtar ayarlanmamış)" }, 503);
  if (!sameKey(String(req.headers.get("x-kisisel-anahtar") || "").trim(), API_KEY)) return json({ ok: false, error: "Yetkisiz" }, 401);
  const b = await req.json().catch(() => ({}));
  try {
    if (b.action === "ping") {
      const { data } = await db.auth.admin.getUserById(USER_ID);
      return json({ ok: !!data?.user, user: !!data?.user });
    }
    if (b.action === "channels") {
      const ch = await connectedChannels(db, USER_ID);
      const { data: pc } = await db.from("printify_connections").select("shop_id").eq("user_id", USER_ID).maybeSingle();
      return json({ ok: true, ...ch, printify: !!pc, printifyShop: pc?.shop_id || null });
    }
    if (b.action === "publish") return json(await publish(b));
    if (b.action === "sent") return json(await sent(b));
    if (b.action === "withdraw") return json(await withdraw(b));
    if (b.action === "ads_plan") return json(await call("ads", { action: "plan" }));
    if (b.action === "ads_launch") return json(await adsLaunch());
    return json({ ok: false, error: "Bilinmeyen işlem" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message).slice(0, 300) }, 500);
  }
});
