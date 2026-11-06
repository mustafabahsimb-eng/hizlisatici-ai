// =========================================================
// Seltigo - store-checkout: mağaza sepeti ve ödeme (herkese açık; fiyat, kupon, kargo HER ZAMAN sunucuda)
//   POST { action: "quote", store_slug, items: [{ product_id, variant_id?, qty }], coupon?, shipping_option?, payment_method? }
//   POST { action: "place", ...quote, customer: { name, phone, email?, address, city, district, zip? }, accept_terms: true,
//          customer_token?, return_url?, ad_source? }
//        -> kapıda ödeme / havale: siparişler hemen açılır (ortak stok düşer);
//           kart (iyzico / PayTR): önce ödeme sayfası, siparişler ödeme onayından sonra açılır
//   POST { action: "status", checkout_id }  -> ödeme durumu + takip bağlantıları
// Sağlayıcı dönüşleri:
//   POST ?provider=iyzico&c=<checkout>  (iyzico ödeme formu dönüşü; token ile sunucudan doğrulanır, sonra mağazaya yönlenir)
//   POST ?provider=paytr                (PayTR bildirim adresi; HMAC doğrulanır, "OK" döner)
// GET ?action=sitemap|robots|resolve|product -> mağaza SEO ve kendi alan adı yardımcıları (_shared/store-seo.ts)
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { featureEnabled } from "../_shared/features.ts";
import { quote, storeMethods } from "../_shared/store-cart.ts";
import { iyzicoInit, iyzicoRetrieve, paytrInit, paytrVerify } from "../_shared/payments.ts";
import { sha256Hex } from "../_shared/site-guard.ts";
import { handleSeo } from "../_shared/store-seo.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SITE = "https://mustafabahsimb-eng.github.io/hizlisatici-ai";
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const clean = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

async function loadStore(slug: string) {
  const { data } = await db.from("store_settings").select("*").eq("store_slug", clean(slug, 100)).maybeSingle();
  return data;
}
async function methodsFor(store: any) {
  const { data: prov } = await db.from("store_payment_providers").select("provider, enabled").eq("user_id", store.user_id);
  return storeMethods(store, prov || [], await featureEnabled(store.user_id, "store_payments"));
}
async function creds(userId: string, provider: string) {
  const { data: p } = await db.from("store_payment_providers").select("*").eq("user_id", userId).eq("provider", provider).maybeSingle();
  if (!p?.secret_id || !p.enabled) return null;
  const { data } = await db.rpc("seltigo_secret_get", { p_id: p.secret_id });
  return data ? { ...data, environment: p.environment } : null;
}
async function customerFromToken(store: any, token: string) {
  if (!token) return null;
  const { data: s } = await db.from("store_customer_sessions").select("customer_id, expires_at").eq("token_hash", await sha256Hex(token)).maybeSingle();
  if (!s || new Date(s.expires_at).getTime() < Date.now()) return null;
  const { data: c } = await db.from("store_customers").select("id, user_id, email").eq("id", s.customer_id).maybeSingle();
  return c && c.user_id === store.user_id ? c : null;
}
function returnBase(store: any, raw: string) {
  try {
    const u = new URL(raw);
    if (u.href.startsWith(SITE + "/") || (store.custom_domain && u.hostname.toLowerCase() === String(store.custom_domain).toLowerCase())) return u.origin + u.pathname;
  } catch { /* yok */ }
  return `${SITE}/magaza.html`;
}

// Siparişler: her kalem bir store_orders satırı (mevcut sipariş akışları, takip, asistan aynen çalışır)
async function createOrders(c: any) {
  if (c.order_ids?.length) return c.order_ids;
  const ratio = c.subtotal > 0 ? Math.max(0, c.subtotal - c.discount) / c.subtotal : 1;
  const a = c.address || {};
  const rows = (c.items || []).map((l: any) => ({
    user_id: c.user_id, product_id: l.product_id, listing_id: l.listing_id, variant_id: l.variant_id, variant_label: l.variant_label,
    customer_name: c.name, customer_phone: c.phone, customer_address: a.text, customer_city: a.city || null, customer_district: a.district || null,
    customer_zip: a.zip || null, customer_country: "TR", quantity: l.qty, unit_price: Math.round(l.unit_price * ratio * 100) / 100, currency: c.currency,
    status: "pending", checkout_id: c.id, customer_id: c.customer_id, customer_email: c.email, payment_method: c.payment_method, payment_status: c.payment_status,
    ad_source: c.ad_source || null,
  }));
  const { data, error } = await db.from("store_orders").insert(rows).select("id, tracking_token");
  if (error) throw error;
  const ids = (data || []).map((x: any) => x.id);
  await db.from("store_checkouts").update({ order_ids: ids }).eq("id", c.id);
  return ids;
}

async function place(req: Request, b: any) {
  const store = await loadStore(b.store_slug);
  if (!store) return json({ ok: false, error: "Mağaza bulunamadı" }, 404);
  if (!(await featureEnabled(store.user_id, "store_checkout"))) return json({ ok: false, error: "Sepet bu mağazada kapalı" }, 403);
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  const { data: lim } = await db.rpc("rate_hit", { p_key: "checkout:" + (ip || "x") + ":" + store.user_id, p_limit: 20, p_window_seconds: 3600 });
  if (lim === false) return json({ ok: false, error: "Çok fazla deneme; biraz sonra tekrar dene." }, 429);
  const methods = await methodsFor(store);
  const q = await quote(db, store, b, { methods });
  if (!q.ok) return json({ ok: false, error: q.error }, 400);
  if (b.coupon && q.coupon_error) return json({ ok: false, error: q.coupon_error }, 400);
  const method = methods.includes(b.payment_method) ? b.payment_method : null;
  if (!method) return json({ ok: false, error: "Ödeme yöntemi seç" }, 400);
  const cu = b.customer || {};
  const name = clean(cu.name, 120), phone = clean(cu.phone, 30), email = clean(cu.email, 160).toLowerCase();
  const address = { text: clean(cu.address, 500), city: clean(cu.city, 60), district: clean(cu.district, 60), zip: clean(cu.zip, 12) };
  if (!name || phone.replace(/\D/g, "").length < 7 || !address.text || !address.city || !address.district) return json({ ok: false, error: "Ad, telefon, adres, il ve ilçe zorunlu" }, 400);
  if ((method === "iyzico" || method === "paytr") && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: false, error: "Kartla ödemede e-posta zorunlu" }, 400);
  if (b.accept_terms !== true) return json({ ok: false, error: "Ön bilgilendirme ve satış koşullarını onayla" }, 400);
  const customer = await customerFromToken(store, String(b.customer_token || ""));
  const src = b.ad_source && typeof b.ad_source === "object" ? Object.fromEntries(Object.entries(b.ad_source).map(([k, v]) => [k, clean(v, 300)]).filter(([, v]) => v)) : null;
  const card = method === "iyzico" || method === "paytr";
  const { data: c, error } = await db.from("store_checkouts").insert({
    user_id: store.user_id, store_slug: store.store_slug, customer_id: customer?.id || null, email: email || customer?.email || null, name, phone, address,
    items: q.lines, subtotal: q.subtotal, discount: q.discount, shipping: q.shipping, cod_fee: q.cod_fee, total: q.total, currency: q.currency,
    coupon_code: q.coupon?.code || null, shipping_option: q.shipping_option?.id || null, payment_method: method,
    payment_status: method === "cod" ? "cod" : method === "bank_transfer" ? "awaiting_transfer" : "pending",
  }).select("*").single();
  if (error) throw error;
  if (q.coupon) await db.rpc("store_coupon_use", { p_id: q.coupon.id });
  const back = returnBase(store, String(b.return_url || ""));
  if (!card) {
    await createOrders({ ...c, ad_source: src });
    return json({ ok: true, checkout_id: c.id, payment_status: c.payment_status, total: c.total, bank: method === "bank_transfer" ? { iban: store.checkout?.iban, name: store.checkout?.account_name || store.business_name || store.store_name } : null });
  }
  const cr = await creds(store.user_id, method);
  if (!cr) return json({ ok: false, error: "Kartla ödeme şu an kullanılamıyor" }, 400);
  await db.from("store_checkouts").update({ environment: cr.environment, address: { ...address, ad_source: src } }).eq("id", c.id);
  const target = `${back}?slug=${encodeURIComponent(store.store_slug)}&checkout=${c.id}`;
  const init = method === "iyzico"
    ? await iyzicoInit(cr, cr.environment, c, `${SUPABASE_URL}/functions/v1/store-checkout?provider=iyzico&c=${c.id}&r=${encodeURIComponent(target)}`, ip)
    : await paytrInit(cr, cr.environment, c, target + "&paid=1", target + "&paid=0", ip);
  await db.from("store_payment_events").insert({ checkout_id: c.id, provider: method, kind: "init", ok: init.ok, raw: init.ok ? init.raw : { error: init.error, raw: init.raw } });
  if (!init.ok) {
    await db.from("store_checkouts").update({ payment_status: "failed", error: init.error }).eq("id", c.id);
    return json({ ok: false, error: init.error }, 502);
  }
  await db.from("store_checkouts").update({ provider_ref: init.token }).eq("id", c.id);
  return json({ ok: true, checkout_id: c.id, payment_status: "pending", redirect_url: init.url, total: c.total, environment: cr.environment });
}

async function markPaid(c: any, provider: string, raw: unknown) {
  const { data: upd } = await db.from("store_checkouts").update({ payment_status: "paid", paid_at: new Date().toISOString(), error: null })
    .eq("id", c.id).eq("payment_status", "pending").select("*").maybeSingle();
  await db.from("store_payment_events").insert({ checkout_id: c.id, provider, kind: "paid", ok: true, raw });
  if (upd) await createOrders({ ...upd, ad_source: upd.address?.ad_source || null });
}

async function iyzicoReturn(req: Request, url: URL) {
  const id = url.searchParams.get("c") || "";
  const back = url.searchParams.get("r") || SITE + "/magaza.html";
  const form = await req.formData().catch(() => null);
  const token = String(form?.get("token") || "");
  const { data: c } = await db.from("store_checkouts").select("*").eq("id", id).maybeSingle();
  let ok = false;
  if (c && token && token === c.provider_ref) {
    const cr = await creds(c.user_id, "iyzico");
    if (cr) {
      const r = await iyzicoRetrieve(cr, cr.environment, token, c.id);
      // Tutar ve sepet kimliği de eşleşmeli
      ok = r.ok && r.basketId === c.id && Math.abs(r.paid - Number(c.total)) < 0.01;
      if (ok) await markPaid(c, "iyzico", r.raw);
      else {
        await db.from("store_payment_events").insert({ checkout_id: c.id, provider: "iyzico", kind: "failed", ok: false, raw: r.raw });
        await db.from("store_checkouts").update({ payment_status: "failed", error: "Ödeme onaylanmadı" }).eq("id", c.id).eq("payment_status", "pending");
      }
    }
  }
  // Dönüş yalnız Seltigo vitrinine ya da mağazanın doğrulanmış kendi alan adına
  let host = "";
  try { host = new URL(back).hostname; } catch { /* geçersiz */ }
  const { data: dom } = c && host ? await db.from("store_domains").select("id").eq("user_id", c.user_id).eq("status", "active").ilike("hostname", host).maybeSingle() : { data: null };
  const safeBack = back.startsWith(SITE + "/") || dom ? back : `${SITE}/magaza.html?checkout=${id}`;
  return new Response(null, { status: 303, headers: { Location: safeBack + (safeBack.includes("?") ? "&" : "?") + "paid=" + (ok ? "1" : "0") } });
}

async function paytrNotify(req: Request) {
  const form = await req.formData().catch(() => null);
  const p: Record<string, string> = {};
  form?.forEach((v, k) => { p[k] = String(v); });
  const oid = String(p.merchant_oid || "");
  const id = oid.length === 32 ? `${oid.slice(0, 8)}-${oid.slice(8, 12)}-${oid.slice(12, 16)}-${oid.slice(16, 20)}-${oid.slice(20)}` : "";
  const { data: c } = id ? await db.from("store_checkouts").select("*").eq("id", id).maybeSingle() : { data: null };
  if (!c) return new Response("OK"); // bilinmeyen sipariş: PayTR tekrar göndermesin
  const cr = await creds(c.user_id, "paytr");
  if (!cr || !(await paytrVerify(cr, p))) {
    await db.from("store_payment_events").insert({ checkout_id: c.id, provider: "paytr", kind: "bad_hash", ok: false, raw: { merchant_oid: oid, status: p.status } });
    return new Response("PAYTR notification failed: bad hash", { status: 400 });
  }
  // Taksit farkı tutarı artırabilir (ödenen >= sepet tutarı)
  if (p.status === "success" && Number(p.total_amount) / 100 >= Number(c.total) - 0.01) await markPaid(c, "paytr", { status: p.status, total_amount: p.total_amount });
  else {
    await db.from("store_payment_events").insert({ checkout_id: c.id, provider: "paytr", kind: "failed", ok: false, raw: { status: p.status, reason: p.failed_reason_msg } });
    await db.from("store_checkouts").update({ payment_status: "failed", error: short(p.failed_reason_msg) }).eq("id", c.id).eq("payment_status", "pending");
  }
  return new Response("OK");
}
const short = (v: unknown) => String(v ?? "").slice(0, 200);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  try {
    const provider = url.searchParams.get("provider");
    if (provider === "iyzico") return await iyzicoReturn(req, url);
    if (provider === "paytr") return await paytrNotify(req);
    if (req.method === "GET") return await handleSeo(req, db); // site haritası, robots, alan adı çözümleme, ürün sayfası
    const b = await req.json().catch(() => ({}));
    if (b.action === "quote") {
      const store = await loadStore(b.store_slug);
      if (!store) return json({ ok: false, error: "Mağaza bulunamadı" }, 404);
      return json(await quote(db, store, b, { methods: await methodsFor(store) }));
    }
    if (b.action === "place") return await place(req, b);
    if (b.action === "status") {
      const { data: c } = await db.from("store_checkouts").select("id, payment_status, payment_method, total, currency, order_ids, store_slug, error").eq("id", clean(b.checkout_id, 40)).maybeSingle();
      if (!c) return json({ ok: false, error: "Bulunamadı" }, 404);
      const { data: orders } = c.order_ids?.length ? await db.from("store_orders").select("tracking_token, variant_label, quantity").in("id", c.order_ids) : { data: [] };
      return json({ ok: true, checkout: { ...c, order_ids: undefined }, tracking: (orders || []).map((o: any) => `${SITE}/takip.html?t=${o.tracking_token}`) });
    }
    return json({ ok: false, error: "Geçersiz işlem" }, 400);
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: "Sunucu hatası" }, 500);
  }
});
