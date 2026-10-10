// =========================================================
// Seltigo - cj-order-worker (tedarikçi otomatik sipariş + ödeme: CJ ve AliExpress)
// Zamanlanmış görevle birkaç dakikada bir çalışır:
//   CJ: sipariş ödemesiz oluşturulur -> zarar kontrolü -> bakiye kontrolü -> bakiyeden ödeme
//       ("bakiye_bekliyor": bakiye gelince kendiliğinden öder)
//   AliExpress: ürün + en ucuz kargo sorgulanır -> zarar kontrolü (sipariş AÇILMADAN)
//       -> sipariş + kayıtlı kartla ödeme ("odeme_bekliyor": kart reddedilirse)
//   Zarar kontrolü (HER ZAMAN, kapatılamaz): maliyet (ürün + kargo) > satış - komisyon ise
//   ödenmez, satıcının onayına düşer ("onay_bekliyor").
//   Satıcı otomatik ödemeyi kapattıysa "odeme_bekliyor" (tedarikçi panelinden ödenir).
//   Ödeyince "tedarikciye_verildi" (kargo takibini cj-tracking-sync yapar).
// Satıcı da çağırabilir: { action: "approve" | "cancel" | "retry", orderId }
// Güvenlik: zamanlanmış görev CRON_SECRET ile, satıcı oturum anahtarıyla.
// Sadece satıcının KENDİ tedarikçi hesabı kullanılır.
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

const CJ = "https://developers.cjdropshipping.com/api2.0/v1";
const MAX_ORDERS = 30;          // bir çalışmada en fazla kaç sipariş
const TIME_BUDGET_MS = 45000;   // Edge Function süresini aşmamak için
const MAX_ATTEMPTS = 6;         // bu kadar hatadan sonra "hata"ya düşer

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isCron(body: any, req: Request): boolean {
  if (!CRON_SECRET) return false;
  const s = CRON_SECRET.trim();
  if (String(body?.cronSecret || "").trim() === s) return true;
  return String(req.headers.get("x-cron-secret") || "").trim() === s;
}

const minutesFromNow = (m: number) => new Date(Date.now() + m * 60000).toISOString();

// ---------------------------------------------------------
// CJ yardımcıları
// ---------------------------------------------------------
const tokenCache = new Map<string, string | null>();

async function cjToken(apiKey: string): Promise<string | null> {
  if (tokenCache.has(apiKey)) return tokenCache.get(apiKey)!;
  let token: string | null = null;
  try {
    const r = await fetch(`${CJ}/authentication/getAccessToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });
    const d = await r.json();
    token = d?.data?.accessToken || null;
  } catch (_) { /* aşağıda null */ }
  tokenCache.set(apiKey, token);
  return token;
}

async function cj(token: string, path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(`${CJ}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "CJ-Access-Token": token, ...(init.headers || {}) },
  });
  return await r.json().catch(() => ({ result: false, message: `HTTP ${r.status}` }));
}

const isBalanceError = (msg: string) => /balance|insufficient|余额|bakiye/i.test(msg);

// USD -> para birimi (kur tablosu dolar bazlı)
const fxCache = new Map<string, number | null>();
async function usdTo(currency: string): Promise<number | null> {
  const cur = (currency || "TRY").toUpperCase();
  if (cur === "USD") return 1;
  if (fxCache.has(cur)) return fxCache.get(cur)!;
  const { data } = await db
    .from("exchange_rates")
    .select("rate")
    .eq("base_currency", "USD")
    .eq("quote_currency", cur)
    .order("rate_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const rate = data?.rate ? Number(data.rate) : null;
  fxCache.set(cur, rate);
  return rate;
}

// ---------------------------------------------------------
// Tek siparişi bir adım ilerlet
// ---------------------------------------------------------
type Outcome = { id: string; status: string; note?: string };

async function update(id: string, patch: Record<string, unknown>) {
  const { error } = await db.from("orders").update(patch).eq("id", id);
  if (error) throw error;
}

async function failOrRetry(o: any, message: string): Promise<Outcome> {
  const attempts = (o.attempts || 0) + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await update(o.id, { status: "hata", error_message: message, attempts, hold_reason: null });
    return { id: o.id, status: "hata", note: message };
  }
  // 5, 15, 45, 135... dakika sonra tekrar dene
  await update(o.id, { error_message: message, attempts, next_attempt_at: minutesFromNow(5 * Math.pow(3, attempts - 1)) });
  return { id: o.id, status: o.status, note: "tekrar denenecek: " + message };
}

// Satıştan düşülecek komisyon oranı: ilanın komisyonu, yoksa ürünün komisyonu (kendi mağazada 0)
async function commissionPct(o: any): Promise<number> {
  if (o.store_order_id) {
    const { data: so } = await db.from("store_orders").select("listing_id").eq("id", o.store_order_id).maybeSingle();
    if (so?.listing_id) {
      const { data: l } = await db.from("listings").select("commission_pct").eq("id", so.listing_id).maybeSingle();
      if (l && l.commission_pct != null) return Number(l.commission_pct) || 0;
    }
    return 0;
  }
  const { data: p } = await db.from("products").select("commission_rate").eq("id", o.product_id).maybeSingle();
  return Number(p?.commission_rate) || 0;
}

// Zarar kontrolü (kapatılamaz): tedarikçi maliyeti (ürün + kargo) > satış - komisyon ise
// sipariş ödenmeden satıcının onayına düşer. Döner: bekletildiyse sonuç, değilse null.
async function lossHold(o: any, costUsd: number | null, supplierName: string): Promise<Outcome | null> {
  const currency = o.currency || "TRY";
  const rate = await usdTo(currency);
  const gross = o.unit_price != null ? Number(o.unit_price) * (o.quantity || 1) : null;
  const pct = await commissionPct(o);
  const net = gross != null ? Math.round(gross * (1 - pct / 100) * 100) / 100 : null;
  const costLocal = costUsd != null && rate ? Math.round(Number(costUsd) * rate * 100) / 100 : null;
  if (costLocal != null) await update(o.id, { cost_local: costLocal, cost_usd: costUsd });

  let reason: string | null = null;
  let msg = "";
  if (costUsd == null || rate == null) {
    reason = "maliyet_bilinmiyor";
    msg = `${supplierName} maliyeti hesaplanamadı; kontrol edip onaylarsan ödenecek.`;
  } else if (net == null) {
    reason = "fiyat_bilinmiyor";
    msg = `Satış fiyatı bilinmiyor; ${supplierName} maliyeti ${costLocal} ${currency}. Onaylarsan ödenecek.`;
  } else if (costLocal! > net) {
    reason = "zarar";
    msg = `Zararlı sipariş: ${supplierName} maliyeti (ürün + kargo) ${costLocal} ${currency}, satış ${gross!.toFixed(2)} ${currency}` +
      (pct > 0 ? ` (komisyon %${pct} sonrası ${net.toFixed(2)} ${currency})` : "") + ". Onaylarsan ödenecek.";
  }
  if (!reason) return null;
  await update(o.id, { status: "onay_bekliyor", hold_reason: reason, error_message: msg });
  return { id: o.id, status: "onay_bekliyor", note: reason };
}

async function processOrder(o: any, opts: { approved?: boolean } = {}): Promise<Outcome> {
  if (o.supplier === "aliexpress") return await processAe(o, opts);
  return await processCj(o, opts);
}

async function processCj(o: any, opts: { approved?: boolean } = {}): Promise<Outcome> {
  // 1) Satıcının KENDİ CJ hesabı
  const { data: integ } = await db
    .from("user_integrations")
    .select("api_key")
    .eq("user_id", o.user_id)
    .eq("platform", "cj")
    .maybeSingle();
  if (!integ?.api_key) {
    await update(o.id, {
      hold_reason: "cj_hesap_yok",
      error_message: "CJ hesabın bağlı değil. Hesaplarım sayfasından CJ'yi bağlayınca sipariş kendiliğinden gönderilecek.",
      next_attempt_at: minutesFromNow(30),
    });
    return { id: o.id, status: o.status, note: "cj_hesap_yok" };
  }
  const token = await cjToken(integ.api_key);
  if (!token) return await failOrRetry(o, "CJ hesabına giriş yapılamadı (API anahtarını kontrol et).");

  // 2) CJ'de siparişi oluştur (ödemesiz) - daha önce oluşturulduysa atla
  if (!o.supplier_order_id) {
    const { data: product } = await db
      .from("products")
      .select("id, supplier_item_id, supplier_variant_id")
      .eq("id", o.product_id)
      .maybeSingle();
    if (!product?.supplier_item_id) return await failOrRetry(o, "Üründe CJ ürün numarası yok.");

    let vid = product.supplier_variant_id;
    if (!vid) {
      const pd = await cj(token, `/product/query?pid=${encodeURIComponent(product.supplier_item_id)}`, { method: "GET" });
      vid = pd?.data?.variants?.[0]?.vid || null;
      if (!vid) return await failOrRetry(o, "CJ'de bu ürünün seçeneği bulunamadı.");
      await db.from("products").update({ supplier_variant_id: vid }).eq("id", product.id);
    }

    const city = (o.customer_city || "").trim();
    const district = (o.customer_district || "").trim();
    if (!city) {
      await update(o.id, {
        status: "onay_bekliyor",
        hold_reason: "adres_eksik",
        error_message: "Siparişte il bilgisi yok. Adresi düzeltip onaylayınca gönderilecek.",
      });
      return { id: o.id, status: "onay_bekliyor", note: "adres_eksik" };
    }

    // Kargo: bu ülkeye gönderilebilen en ucuz CJ kargo seçeneği (ücreti zarar kontrolüne girer)
    const country = (o.customer_country || "TR").toUpperCase();
    const fr = await cj(token, "/logistic/freightCalculate", {
      method: "POST",
      body: JSON.stringify({
        startCountryCode: "CN",
        endCountryCode: country,
        zip: o.customer_zip || undefined,
        products: [{ quantity: o.quantity || 1, vid }],
      }),
    });
    const options = (Array.isArray(fr?.data) ? fr.data : [])
      .map((x: any) => ({ name: x.logisticName, price: Number(x.totalPostageFee ?? x.logisticPrice) }))
      .filter((x: any) => x.name && Number.isFinite(x.price) && x.price >= 0)
      .sort((a: any, b: any) => a.price - b.price);
    if (!options.length) {
      if (!fr?.result) return await failOrRetry(o, "CJ kargo ücreti alınamadı: " + String(fr?.message || "bilinmeyen hata").slice(0, 200));
      await update(o.id, {
        status: "onay_bekliyor",
        hold_reason: "kargo_yok",
        error_message: `CJ bu ürün için ${country === "TR" ? "Türkiye'ye" : country + " ülkesine"} kargo seçeneği sunmuyor. Siparişi iptal edebilir ya da tedarikçiyi değiştirebilirsin.`,
      });
      return { id: o.id, status: "onay_bekliyor", note: "kargo_yok" };
    }
    const shipping = options[0];

    const created = await cj(token, "/shopping/order/createOrderV2", {
      method: "POST",
      body: JSON.stringify({
        orderNumber: "SG-" + o.id,
        shippingCountryCode: (o.customer_country || "TR").toUpperCase(),
        shippingCountry: (o.customer_country || "TR").toUpperCase() === "TR" ? "Turkey" : (o.customer_country || "TR"),
        shippingProvince: city,
        shippingCity: district || city,
        shippingCounty: district || undefined,
        shippingZip: o.customer_zip || undefined,
        shippingCustomerName: o.customer_name || "Müşteri",
        shippingAddress: o.customer_address || "",
        shippingPhone: o.customer_phone || "",
        fromCountryCode: "CN",
        logisticName: shipping.name,
        payType: 3, // sadece oluştur; ödeme aşağıda kontrollerden sonra
        products: [{ vid, quantity: o.quantity || 1 }],
      }),
    });
    const cd = created?.data;
    if (!created?.result || !cd?.orderId) {
      return await failOrRetry(o, "CJ siparişi oluşturulamadı: " + String(created?.message || "bilinmeyen hata").slice(0, 200));
    }
    // Maliyet: CJ'nin sipariş toplamı ile (ürün + seçilen kargo) hangisi büyükse
    // (CJ toplamı kargoyu içermeyebiliyor; zarar kontrolü kargo dahil yapılmalı)
    const productUsd = Number(cd.productAmount ?? 0);
    const cjTotal = Number(cd.orderAmount ?? cd.actualPayment ?? 0);
    const costUsd = Math.max(
      Number.isFinite(cjTotal) ? cjTotal : 0,
      (Number.isFinite(productUsd) && productUsd > 0 ? productUsd : (Number.isFinite(cjTotal) ? cjTotal : 0)) + shipping.price,
    );
    o.supplier_order_id = String(cd.orderId);
    o.supplier_shipment_id = cd.shipmentOrderId ? String(cd.shipmentOrderId) : null;
    o.cost_usd = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : null;
    await update(o.id, {
      supplier_order_id: o.supplier_order_id,
      supplier_shipment_id: o.supplier_shipment_id,
      supplier_logistics: shipping.name,
      cost_usd: o.cost_usd,
      error_message: null,
    });
  }

  // 3) Zarar kontrolü (her zaman; satıcı onayladıysa atlanır)
  if (!opts.approved) {
    const held = await lossHold(o, o.cost_usd, "CJ");
    if (held) return held;
  }

  // 4) Otomatik ödeme kapalıysa satıcı CJ panelinden öder
  const { data: prof } = await db.from("user_profiles").select("cj_auto_pay").eq("user_id", o.user_id).maybeSingle();
  if (prof && prof.cj_auto_pay === false) {
    await update(o.id, {
      status: "odeme_bekliyor",
      hold_reason: "elle_odeme",
      error_message: null,
      attempts: 0,
    });
    return { id: o.id, status: "odeme_bekliyor" };
  }

  // 5) Bakiye kontrolü
  const bal = await cj(token, "/shopping/pay/getBalance", { method: "GET" });
  const balance = Number(bal?.data?.amount);
  if (bal?.result && Number.isFinite(balance) && o.cost_usd != null && balance < Number(o.cost_usd)) {
    await update(o.id, {
      status: "bakiye_bekliyor",
      hold_reason: "bakiye",
      error_message: `CJ bakiyen yetersiz (bakiye ${balance.toFixed(2)} USD, gereken ${Number(o.cost_usd).toFixed(2)} USD). Bakiye yükleyince sipariş kendiliğinden ödenecek.`,
      next_attempt_at: minutesFromNow(15),
    });
    return { id: o.id, status: "bakiye_bekliyor" };
  }

  // 6) Öde
  const pay = o.supplier_shipment_id
    ? await cj(token, "/shopping/pay/payBalanceV2", { method: "POST", body: JSON.stringify({ shipmentOrderId: o.supplier_shipment_id }) })
    : await cj(token, "/shopping/pay/payBalance", { method: "POST", body: JSON.stringify({ orderId: o.supplier_order_id }) });
  if (!pay?.result) {
    const m = String(pay?.message || "bilinmeyen hata");
    if (isBalanceError(m)) {
      await update(o.id, {
        status: "bakiye_bekliyor",
        hold_reason: "bakiye",
        error_message: "CJ bakiyen yetersiz. Bakiye yükleyince sipariş kendiliğinden ödenecek.",
        next_attempt_at: minutesFromNow(15),
      });
      return { id: o.id, status: "bakiye_bekliyor" };
    }
    return await failOrRetry(o, "CJ ödemesi yapılamadı: " + m.slice(0, 200));
  }

  await update(o.id, {
    status: "tedarikciye_verildi",
    hold_reason: null,
    error_message: null,
    attempts: 0,
    paid_at: new Date().toISOString(),
  });
  return { id: o.id, status: "tedarikciye_verildi" };
}

// ---------------------------------------------------------
// AliExpress (satıcının kendi hesabı; ödeme hesaptaki kayıtlı kartla)
// AliExpress'te ödenmemiş sipariş API ile silinemediği için zarar kontrolü
// sipariş AÇILMADAN önce, ürün + kargo fiyatı sorgulanarak yapılır.
// ---------------------------------------------------------
const AE_APP_KEY = Deno.env.get("ALIEXPRESS_APP_KEY") || "";
const AE_APP_SECRET = Deno.env.get("ALIEXPRESS_APP_SECRET") || "";
const AE_SYNC = "https://api-sg.aliexpress.com/sync";
const AE_REFRESH = "https://api-sg.aliexpress.com/rest/auth/token/refresh";

async function aeSign(pathname: string, params: Record<string, string>): Promise<string> {
  const base = pathname + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(AE_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function aeCall(method: string, accessToken: string, extra: Record<string, string>): Promise<any> {
  const params: Record<string, string> = {
    app_key: AE_APP_KEY, sign_method: "sha256", timestamp: Date.now().toString(),
    access_token: accessToken, method, ...extra,
  };
  const sign = await aeSign("", params);
  const r = await fetch(AE_SYNC, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, sign }).toString(),
  });
  return await r.json().catch(() => ({}));
}

// AliExpress yanıtlarındaki iç içe liste sarmalayıcılarını aç
function aeList(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") for (const k of Object.keys(v)) if (Array.isArray(v[k])) return v[k];
  return [];
}

function aeError(d: any): string {
  const e = d?.error_response || d;
  return String(e?.msg || e?.sub_msg || e?.message || e?.error_msg || JSON.stringify(d).slice(0, 200));
}

// Satıcının AliExpress anahtarı (kasadan); süresi dolmak üzereyse yeniler
async function aeToken(userId: string): Promise<{ token: string | null; reason?: string }> {
  const { data: conn } = await db.from("supplier_connections")
    .select("id, status").eq("user_id", userId).eq("supplier", "aliexpress").maybeSingle();
  if (!conn || conn.status !== "connected") return { token: null, reason: conn ? "expired" : "none" };
  const { data: cred } = await db.rpc("supplier_connection_get_credentials", { p_connection_id: conn.id });
  if (!cred?.access_token) return { token: null, reason: "none" };
  const exp = cred.expires_at ? new Date(cred.expires_at).getTime() : 0;
  if (exp && exp > Date.now() + 10 * 60000) return { token: cred.access_token };

  // Yenile
  if (!cred.refresh_token) return { token: cred.access_token };
  const params: Record<string, string> = {
    app_key: AE_APP_KEY, refresh_token: cred.refresh_token, sign_method: "sha256", timestamp: Date.now().toString(),
  };
  const sign = await aeSign("/auth/token/refresh", params);
  const r = await fetch(AE_REFRESH, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, sign }).toString(),
  });
  const d = await r.json().catch(() => ({}));
  if (!d.access_token) {
    await db.from("supplier_connections").update({
      status: "expired", last_error: aeError(d), updated_at: new Date().toISOString(),
    }).eq("id", conn.id);
    return { token: null, reason: "expired" };
  }
  const expiresAt = new Date(Date.now() + (Number(d.expires_in) || 86400) * 1000).toISOString();
  await db.rpc("supplier_connection_set_credentials", {
    p_connection_id: conn.id,
    p_credentials: { ...cred, access_token: d.access_token, refresh_token: d.refresh_token || cred.refresh_token, expires_at: expiresAt },
  });
  await db.from("supplier_connections").update({ token_expires_at: expiresAt, updated_at: new Date().toISOString() }).eq("id", conn.id);
  return { token: d.access_token };
}

async function processAe(o: any, opts: { approved?: boolean } = {}): Promise<Outcome> {
  // 1) Satıcının KENDİ AliExpress hesabı
  const t = await aeToken(o.user_id);
  if (!t.token) {
    await update(o.id, {
      hold_reason: "ae_hesap_yok",
      error_message: t.reason === "expired"
        ? "AliExpress bağlantının süresi doldu. Hesaplarım sayfasından yeniden bağlayınca sipariş kendiliğinden verilecek."
        : "AliExpress hesabın bağlı değil. Hesaplarım sayfasından bağlayınca sipariş kendiliğinden verilecek.",
      next_attempt_at: minutesFromNow(30),
    });
    return { id: o.id, status: o.status, note: "ae_hesap_yok" };
  }
  const token = t.token;

  // Daha önce verildiyse (ödeme bekliyor vb.) burada yapılacak bir şey yok; takip işi izler
  if (o.supplier_order_id) return { id: o.id, status: o.status, note: "zaten_verildi" };

  const { data: product } = await db.from("products")
    .select("id, supplier_item_id, supplier_variant_id, supplier_sku_attr").eq("id", o.product_id).maybeSingle();
  const productId = String(product?.supplier_item_id || "").replace(/\D/g, "");
  if (!productId) return await failOrRetry(o, "Üründe AliExpress ürün numarası yok.");

  const city = (o.customer_city || "").trim();
  if (!city) {
    await update(o.id, {
      status: "onay_bekliyor", hold_reason: "adres_eksik",
      error_message: "Siparişte il bilgisi yok. Adresi düzeltip onaylayınca verilecek.",
    });
    return { id: o.id, status: "onay_bekliyor", note: "adres_eksik" };
  }
  const country = (o.customer_country || "TR").toUpperCase();
  const qty = o.quantity || 1;

  // 2) Seçenek (SKU) ve güncel fiyat
  // Türkiye için ürün bilgisi boş dönebiliyor; o durumda seçenek/fiyat "US" ile alınır
  // (kargo yine hedef ülke + seçenek numarasıyla hesaplanır)
  let pd = await aeCall("aliexpress.ds.product.get", token, {
    product_id: productId, ship_to_country: country, target_currency: "USD", target_language: "en",
  });
  let pr = pd?.aliexpress_ds_product_get_response?.result;
  if (pr && !pr.ae_item_sku_info_dtos && country !== "US") {
    pd = await aeCall("aliexpress.ds.product.get", token, {
      product_id: productId, ship_to_country: "US", target_currency: "USD", target_language: "en",
    });
    pr = pd?.aliexpress_ds_product_get_response?.result;
  }
  if (!pr) return await failOrRetry(o, "AliExpress ürün bilgisi alınamadı: " + aeError(pd));
  const skus = aeList(pr.ae_item_sku_info_dtos).map((s: any) => ({
    sku_id: String(s.sku_id || s.id || ""),
    sku_attr: s.sku_attr || aeList(s.ae_sku_property_dtos || s.aeop_s_k_u_propertys)
      .map((p: any) => `${p.sku_property_id}:${p.property_value_id_long || p.property_value_id}`).join(";") || "",
    price: parseFloat(s.offer_sale_price || s.sku_price) || null,
    stock: Number(s.sku_available_stock ?? s.s_k_u_available_stock ?? s.ipm_sku_stock ?? 0),
  }));
  const sku = (product?.supplier_variant_id && skus.find((s) => s.sku_id === String(product.supplier_variant_id)))
    || (product?.supplier_sku_attr && skus.find((s) => s.sku_attr === product.supplier_sku_attr))
    || skus.filter((s) => s.stock > 0 && s.price).sort((a, b) => a.price! - b.price!)[0];
  if (!sku || !sku.price) return await failOrRetry(o, "AliExpress'te bu ürünün satılabilir seçeneği bulunamadı.");
  if (sku.stock <= 0) {
    await update(o.id, {
      status: "onay_bekliyor", hold_reason: "stok_yok",
      error_message: "AliExpress'te bu ürünün seçeneği tükenmiş. Siparişi iptal edebilir ya da tedarikçiyi değiştirebilirsin.",
    });
    return { id: o.id, status: "onay_bekliyor", note: "stok_yok" };
  }
  if (product && (product.supplier_variant_id !== sku.sku_id || product.supplier_sku_attr !== sku.sku_attr)) {
    await db.from("products").update({ supplier_variant_id: sku.sku_id, supplier_sku_attr: sku.sku_attr || null }).eq("id", product.id);
  }

  // 3) En ucuz kargo
  const fr = await aeCall("aliexpress.logistics.buyer.freight.calculate", token, {
    param_aeop_freight_calculate_for_buyer_d_t_o: JSON.stringify({
      country_code: country, product_id: Number(productId), product_num: qty, send_goods_country_code: "CN",
      sku_id: sku.sku_id, price: String(sku.price), price_currency: "USD",
    }),
  });
  const frRes = fr?.aliexpress_logistics_buyer_freight_calculate_response?.result;
  const usable = (x: any) => x.name && String(x.name).toUpperCase() !== "VIRTUAL" && Number.isFinite(x.price) && x.price >= 0 && x.cur === "USD";
  let options = aeList(frRes?.aeop_freight_calculate_result_for_buyer_d_t_o_list)
    .map((x: any) => ({ name: x.service_name, price: Number(x.freight?.amount ?? (x.freight?.cent != null ? x.freight.cent / 100 : NaN)), cur: x.freight?.currency_code || "USD" }))
    .filter(usable)
    .sort((a: any, b: any) => a.price - b.price);
  // Yedek: AliExpress'in yeni kargo servisi
  let notAllowed = false;
  if (!options.length) {
    const fr2 = await aeCall("aliexpress.ds.freight.query", token, {
      queryDeliveryReq: JSON.stringify({
        quantity: qty, shipToCountry: country, productId: String(productId), selectedSkuId: sku.sku_id,
        language: "en_US", currency: "USD", locale: "en_US",
      }),
    });
    const r2 = fr2?.aliexpress_ds_freight_query_response?.result;
    notAllowed = Number(r2?.code) === 602;
    options = aeList(r2?.delivery_options)
      .map((x: any) => ({
        name: x.code || x.company,
        price: x.free_shipping === true || x.free_shipping === "true" ? 0
          : Number(x.shipping_fee_cent != null ? Number(x.shipping_fee_cent) / 100 : String(x.shipping_fee_format || "").replace(/[^\d.]/g, "")),
        cur: x.shipping_fee_currency || "USD",
      }))
      .filter(usable)
      .sort((a: any, b: any) => a.price - b.price);
  }
  if (!options.length) {
    if (!frRes && !notAllowed) return await failOrRetry(o, "AliExpress kargo ücreti alınamadı: " + aeError(fr));
    await update(o.id, {
      status: "onay_bekliyor", hold_reason: "kargo_yok",
      error_message: `AliExpress bu ürün için ${country === "TR" ? "Türkiye'ye" : country + " ülkesine"} kargo seçeneği sunmuyor. Siparişi iptal edebilir ya da tedarikçiyi değiştirebilirsin.`,
    });
    return { id: o.id, status: "onay_bekliyor", note: "kargo_yok" };
  }
  const shipping = options[0];
  const costUsd = Math.round((sku.price * qty + shipping.price) * 100) / 100;
  await update(o.id, { cost_usd: costUsd, supplier_logistics: shipping.name });

  // 4) Zarar kontrolü (her zaman; satıcı onayladıysa atlanır) - sipariş açılmadan
  if (!opts.approved) {
    const held = await lossHold(o, costUsd, "AliExpress");
    if (held) return held;
  }

  // 5) Sipariş (otomatik ödeme ayarına göre kayıtlı kartla öde)
  const { data: prof } = await db.from("user_profiles").select("ae_auto_pay").eq("user_id", o.user_id).maybeSingle();
  const autoPay = !(prof && prof.ae_auto_pay === false);
  const phone = String(o.customer_phone || "").replace(/\D/g, "").replace(/^(90|0)/, "");
  const created = await aeCall("aliexpress.ds.order.create", token, {
    ds_extend_request: JSON.stringify({
      payment: { pay_currency: "USD", try_to_pay: autoPay ? "true" : "false" },
      trade_extra_param: { business_model: "retail" },
    }),
    param_place_order_request4_open_api_d_t_o: JSON.stringify({
      out_order_id: "SG-" + o.id,
      logistics_address: {
        full_name: o.customer_name || "Müşteri",
        contact_person: o.customer_name || "Müşteri",
        address: o.customer_address || "",
        city: (o.customer_district || city),
        province: city,
        country,
        zip: o.customer_zip || "",
        mobile_no: phone,
        phone_country: country === "TR" ? "+90" : "",
        locale: "tr_TR",
      },
      product_items: [{
        product_id: Number(productId),
        product_count: qty,
        sku_attr: sku.sku_attr || undefined,
        logistics_service_name: shipping.name,
        order_memo: "Seltigo SG-" + o.id,
      }],
    }),
  });
  const cr = created?.aliexpress_ds_order_create_response?.result || created?.aliexpress_trade_buy_placeorder_response?.result;
  const numbers = aeList(cr?.order_list).map(String);
  if (!cr?.is_success || !numbers.length) {
    return await failOrRetry(o, "AliExpress siparişi verilemedi: " + String(cr?.error_msg || cr?.error_code || aeError(created)).slice(0, 200));
  }
  const aeOrderId = numbers[0];
  await update(o.id, { supplier_order_id: aeOrderId, error_message: null, attempts: 0 });

  if (!autoPay) {
    await update(o.id, { status: "odeme_bekliyor", hold_reason: "elle_odeme" });
    return { id: o.id, status: "odeme_bekliyor" };
  }

  // 6) Ödeme oldu mu? (kart reddedilirse sipariş AliExpress'te ödeme bekler)
  const od = await aeCall("aliexpress.trade.ds.order.get", token, { order_id: aeOrderId, single_order_query: JSON.stringify({ order_id: Number(aeOrderId) }) });
  const ostatus = String(od?.aliexpress_trade_ds_order_get_response?.result?.order_status || "");
  if (ostatus === "PLACE_ORDER_SUCCESS" || ostatus === "") {
    await update(o.id, {
      status: "odeme_bekliyor", hold_reason: "odeme_alinamadi",
      error_message: "AliExpress siparişi verildi ama ödeme alınamadı. AliExpress hesabındaki kayıtlı kartı kontrol et; AliExpress'te ödeyince sipariş kendiliğinden takip edilir.",
    });
    return { id: o.id, status: "odeme_bekliyor", note: "odeme_alinamadi" };
  }
  await update(o.id, { status: "tedarikciye_verildi", hold_reason: null, error_message: null, paid_at: new Date().toISOString() });
  return { id: o.id, status: "tedarikciye_verildi" };
}

// ---------------------------------------------------------
// Satıcı işlemleri
// ---------------------------------------------------------
async function sellerAction(userId: string, action: string, orderId: string) {
  const { data: o, error } = await db.from("orders").select("*").eq("id", orderId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!o) return json({ error: "Sipariş bulunamadı" }, 404);
  if (o.supplier !== "cj" && o.supplier !== "aliexpress") return json({ error: "Bu siparişin tedarikçisi otomatik siparişi desteklemiyor" }, 400);

  if (action === "approve") {
    if (!["onay_bekliyor", "beklemede", "bakiye_bekliyor"].includes(o.status)) {
      return json({ error: "Bu sipariş onay beklemiyor" }, 400);
    }
    // Adres eksikti: önce yeniden oluşturulması gerekir, zarar kontrolü yine çalışır
    const approved = o.hold_reason !== "adres_eksik";
    const res = await processOrder({ ...o, attempts: 0 }, { approved });
    return json({ ok: true, ...res });
  }

  if (action === "retry") {
    if (!["hata", "beklemede", "bakiye_bekliyor"].includes(o.status)) return json({ error: "Bu sipariş tekrar denenemez" }, 400);
    await update(o.id, { status: "beklemede", attempts: 0, next_attempt_at: new Date().toISOString(), error_message: null });
    const res = await processOrder({ ...o, status: "beklemede", attempts: 0 });
    return json({ ok: true, ...res });
  }

  if (action === "cancel") {
    const supplierName = o.supplier === "aliexpress" ? "AliExpress" : "CJ";
    if (!["onay_bekliyor", "beklemede", "bakiye_bekliyor", "odeme_bekliyor", "hata"].includes(o.status)) {
      return json({ error: `Ödenmiş sipariş buradan iptal edilemez; ${supplierName} hesabından iptal et.` }, 400);
    }
    if (o.supplier === "aliexpress") {
      // AliExpress ödenmemiş siparişi API ile silmeye izin vermiyor; birkaç gün içinde kendiliğinden kapanır
      await update(o.id, {
        status: "iptal", hold_reason: null,
        error_message: o.supplier_order_id ? "AliExpress'teki ödenmemiş sipariş birkaç gün içinde kendiliğinden kapanır." : null,
      });
      return json({ ok: true, id: o.id, status: "iptal" });
    }
    if (o.supplier_order_id) {
      const { data: integ } = await db.from("user_integrations").select("api_key").eq("user_id", userId).eq("platform", "cj").maybeSingle();
      const token = integ?.api_key ? await cjToken(integ.api_key) : null;
      if (token) {
        const del = await cj(token, `/shopping/order/deleteOrder?orderId=${encodeURIComponent(o.supplier_order_id)}`, { method: "DELETE" });
        if (!del?.result) return json({ error: "CJ'de iptal edilemedi: " + String(del?.message || "").slice(0, 200) }, 400);
      }
    }
    await update(o.id, { status: "iptal", hold_reason: null, error_message: null });
    return json({ ok: true, id: o.id, status: "iptal" });
  }

  return json({ error: "Bilinmeyen işlem" }, 400);
}

// ---------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const body = await req.json().catch(() => ({}));

  // Satıcı işlemi (sayfadan)
  if (!isCron(body, req)) {
    const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const token = String(body?.userAccessToken || bearer || "");
    const { data } = token ? await db.auth.getUser(token) : { data: { user: null } };
    const userId = data?.user?.id;
    if (!userId) return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);
    try {
      return await sellerAction(userId, String(body?.action || ""), String(body?.orderId || ""));
    } catch (e) {
      return json({ error: String((e as Error)?.message || e) }, 500);
    }
  }

  // Sistem işlemi (gizli anahtarla, tek sipariş): ör. test siparişlerini CJ'den silmek
  if (body?.action && body?.orderId) {
    try {
      const { data: o } = await db.from("orders").select("user_id").eq("id", String(body.orderId)).maybeSingle();
      if (!o) return json({ error: "Sipariş bulunamadı" }, 404);
      return await sellerAction(o.user_id, String(body.action), String(body.orderId));
    } catch (e) {
      return json({ error: String((e as Error)?.message || e) }, 500);
    }
  }

  // Zamanlanmış çalışma: sırası gelen siparişler
  const started = Date.now();
  const results: Outcome[] = [];
  try {
    const { data: orders, error } = await db
      .from("orders")
      .select("*")
      .in("supplier", ["cj", "aliexpress"])
      .in("status", ["beklemede", "bakiye_bekliyor"])
      .lte("next_attempt_at", new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(MAX_ORDERS);
    if (error) throw error;

    for (const o of orders || []) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      try {
        results.push(await processOrder(o));
      } catch (e) {
        results.push({ id: o.id, status: o.status, note: String((e as Error)?.message || e).slice(0, 200) });
      }
    }
    return json({ ok: true, processed: results.length, results, ms: Date.now() - started });
  } catch (err) {
    return json({ ok: false, error: String((err as Error)?.message || err), results }, 500);
  }
});
