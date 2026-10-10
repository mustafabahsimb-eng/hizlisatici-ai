// =========================================================
// Seltigo - cj-order-worker (CJ otomatik sipariş + ödeme)
// Zamanlanmış görevle birkaç dakikada bir çalışır:
//   1) "beklemede" tedarikçi siparişlerini CJ'de ödemesiz oluşturur
//   2) Zarar kontrolü (HER ZAMAN): CJ toplamı (ürün + kargo) satıştan fazlaysa
//      ödemez, satıcının onayına bırakır ("onay_bekliyor")
//   3) Satıcı otomatik ödemeyi kapattıysa "odeme_bekliyor" (CJ panelinden ödenir)
//   4) Bakiye yetmezse "bakiye_bekliyor"; bakiye gelince kendiliğinden öder
//   5) Ödeyince "tedarikciye_verildi" (kargo takibini cj-tracking-sync yapar)
// Satıcı da çağırabilir: { action: "approve" | "cancel" | "retry", orderId }
// Güvenlik: zamanlanmış görev CRON_SECRET ile, satıcı oturum anahtarıyla.
// Sadece satıcının KENDİ CJ hesabı kullanılır.
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

async function processOrder(o: any, opts: { approved?: boolean } = {}): Promise<Outcome> {
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
      cost_usd: o.cost_usd,
      error_message: null,
    });
  }

  // 3) Zarar kontrolü (her zaman; satıcı onayladıysa atlanır)
  if (!opts.approved) {
    const currency = o.currency || "TRY";
    const rate = await usdTo(currency);
    const revenue = o.unit_price != null ? Number(o.unit_price) * (o.quantity || 1) : null;
    const costLocal = o.cost_usd != null && rate ? Math.round(Number(o.cost_usd) * rate * 100) / 100 : null;
    if (costLocal != null) await update(o.id, { cost_local: costLocal });

    let reason: string | null = null;
    let msg = "";
    if (o.cost_usd == null || rate == null) {
      reason = "maliyet_bilinmiyor";
      msg = "CJ maliyeti hesaplanamadı; kontrol edip onaylarsan ödenecek.";
    } else if (revenue == null) {
      reason = "fiyat_bilinmiyor";
      msg = `Satış fiyatı bilinmiyor; CJ maliyeti ${costLocal} ${currency}. Onaylarsan ödenecek.`;
    } else if (costLocal! > revenue) {
      reason = "zarar";
      msg = `Zararlı sipariş: CJ maliyeti (ürün + kargo) ${costLocal} ${currency}, satış ${revenue.toFixed(2)} ${currency}. Onaylarsan ödenecek.`;
    }
    if (reason) {
      await update(o.id, { status: "onay_bekliyor", hold_reason: reason, error_message: msg });
      return { id: o.id, status: "onay_bekliyor", note: reason };
    }
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
// Satıcı işlemleri
// ---------------------------------------------------------
async function sellerAction(userId: string, action: string, orderId: string) {
  const { data: o, error } = await db.from("orders").select("*").eq("id", orderId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!o) return json({ error: "Sipariş bulunamadı" }, 404);
  if (o.supplier !== "cj") return json({ error: "Bu sipariş CJ siparişi değil" }, 400);

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
    if (!["onay_bekliyor", "beklemede", "bakiye_bekliyor", "odeme_bekliyor", "hata"].includes(o.status)) {
      return json({ error: "Ödenmiş sipariş buradan iptal edilemez; CJ panelinden iptal et." }, 400);
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
      .eq("supplier", "cj")
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
