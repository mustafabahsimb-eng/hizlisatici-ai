// Supabase Edge Function: aliexpress-search
// AliExpress Dropshipping API (aliexpress.ds.text.search) ile urun arar.
// platform_tokens tablosundaki (site sahibinin demo hesabi) access_token'i kullanir,
// suresi dolmuşsa/dolmak uzereyse refresh_token ile otomatik yeniler.
// Imza mantigi, aliexpress-token-exchange'de dogrulanmis olan gercek/calisan
// acik kaynak kutuphanesinin (umpordez/ae-api) mantigiyla birebir aynidir:
// - /sync uzerinden yapilan business API cagrilarinda imza prefix'i BOS ("").
// - /auth/... cagrilarinda imza prefix'i tam pathname'in kendisi.
// - app_secret ASLA parametre olarak gonderilmez, sadece HMAC anahtari.
// - Tum istekler form (x-www-form-urlencoded) body ile POST edilir (GET query string DEGIL).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const APP_KEY = Deno.env.get("ALIEXPRESS_APP_KEY") || "";
const APP_SECRET = Deno.env.get("ALIEXPRESS_APP_SECRET") || "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const SYNC_URL = "https://api-sg.aliexpress.com/sync";
const REFRESH_URL = "https://api-sg.aliexpress.com/rest/auth/token/refresh";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

// pathname: /sync icin BOS string, /auth/... icin gercek pathname.
async function signParams(pathname: string, params: Record<string, string>): Promise<string> {
  const sortedKeys = Object.keys(params).sort();
  const joined = sortedKeys.map((k) => k + params[k]).join("");
  const base = pathname + joined;
  return await hmacSha256Hex(APP_SECRET, base);
}

async function translateToEnglish(keyword: string): Promise<{ text: string; debug: string | null }> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 30,
        messages: [
          {
            role: "user",
            content:
              `Bu bir e-ticaret ürün arama kelimesi: "${keyword}". ` +
              `Bunu AliExpress ürün aramasında kullanılacak, kısa ve öz İngilizce ürün adına çevir. ` +
              `SADECE İngilizce karşılığını yaz, başka hiçbir şey ekleme, tırnak işareti kullanma.`,
          },
        ],
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { text: keyword, debug: `HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}` };
    }
    const text = data?.content?.[0]?.text?.trim();
    if (!text) {
      return { text: keyword, debug: `Boş yanıt: ${JSON.stringify(data).slice(0, 300)}` };
    }
    return { text, debug: null };
  } catch (e) {
    return { text: keyword, debug: `Hata: ${String(e)}` };
  }
}

// Satıcının kendi AliExpress anahtarı (kasadan; süresi dolmak üzereyse yenilenir)
async function sellerToken(supabase: any, userId: string): Promise<string | null> {
  const { data: conn } = await supabase.from("supplier_connections")
    .select("id, status").eq("user_id", userId).eq("supplier", "aliexpress").maybeSingle();
  if (!conn || conn.status !== "connected") return null;
  const { data: cred } = await supabase.rpc("supplier_connection_get_credentials", { p_connection_id: conn.id });
  if (!cred?.access_token) return null;
  const exp = cred.expires_at ? new Date(cred.expires_at).getTime() : 0;
  if (!exp || exp > Date.now() + 10 * 60000 || !cred.refresh_token) return cred.access_token;
  const params: Record<string, string> = {
    app_key: APP_KEY, refresh_token: cred.refresh_token, sign_method: "sha256", timestamp: Date.now().toString(),
  };
  const sign = await signParams("/auth/token/refresh", params);
  const r = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, sign }).toString(),
  });
  const d = await r.json().catch(() => ({}));
  if (!d.access_token) {
    await supabase.from("supplier_connections").update({ status: "expired", last_error: String(d.message || d.code || "yenilenemedi").slice(0, 200), updated_at: new Date().toISOString() }).eq("id", conn.id);
    return null;
  }
  const expiresAt = new Date(Date.now() + (Number(d.expires_in) || 86400) * 1000).toISOString();
  await supabase.rpc("supplier_connection_set_credentials", {
    p_connection_id: conn.id,
    p_credentials: { ...cred, access_token: d.access_token, refresh_token: d.refresh_token || cred.refresh_token, expires_at: expiresAt },
  });
  await supabase.from("supplier_connections").update({ token_expires_at: expiresAt, updated_at: new Date().toISOString() }).eq("id", conn.id);
  return d.access_token;
}

async function getStoredToken(
  supabase: any
): Promise<{ accessToken: string | null; refreshToken: string | null; expiresAt: string | null }> {
  const { data } = await supabase
    .from("platform_tokens")
    .select("access_token, refresh_token, expires_at")
    .eq("platform", "aliexpress")
    .maybeSingle();
  return {
    accessToken: data?.access_token || null,
    refreshToken: data?.refresh_token || null,
    expiresAt: data?.expires_at || null,
  };
}

async function refreshAccessToken(supabase: any, refreshToken: string): Promise<string | null> {
  const params: Record<string, string> = {
    app_key: APP_KEY,
    sign_method: "sha256",
    timestamp: Date.now().toString(),
    refresh_token: refreshToken,
  };
  const sign = await signParams("/auth/token/refresh", params);
  const body = new URLSearchParams({ ...params, sign });

  const res = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json();
  if (!data.access_token) return null;

  const expiresInSec = Number(data.expires_in) || 7 * 24 * 60 * 60;
  const expiresAtIso = new Date(Date.now() + expiresInSec * 1000).toISOString();

  await supabase.from("platform_tokens").upsert(
    {
      platform: "aliexpress",
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken,
      expires_at: expiresAtIso,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "platform" }
  );

  return data.access_token;
}

// AliExpress iş API'si çağrısı (/sync, imza öneki boş)
async function aeCall(method: string, accessToken: string, extra: Record<string, string>) {
  const params: Record<string, string> = {
    app_key: APP_KEY,
    sign_method: "sha256",
    timestamp: Date.now().toString(),
    access_token: accessToken,
    method,
    ...extra,
  };
  const sign = await signParams("", params);
  const res = await fetch(SYNC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, sign }).toString(),
  });
  return await res.json().catch(() => ({}));
}

// AliExpress yanıtlarındaki iç içe liste sarmalayıcılarını aç ({x: {y: [...]}} -> [...])
function list(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    for (const k of Object.keys(v)) if (Array.isArray(v[k])) return v[k];
  }
  return [];
}

// Ürün fiyatı + varsayılan seçenek (SKU) + Türkiye'ye en ucuz kargo (USD)
async function quote(accessToken: string, productId: string, skuId: string | null, quantity: number, country: string, debug = false) {
  // Not: Türkiye için ürün bilgisi boş dönebiliyor ({has_whole_sale:false}); o durumda ülke zorunlu
  // olduğu için "US" ile sorulur (seçenek/fiyat). Kargo yine hedef ülke + seçenek numarasıyla hesaplanır.
  const productFor = async (shipTo: string | null) => {
    const r = await aeCall("aliexpress.ds.product.get", accessToken, {
      product_id: productId,
      ...(shipTo ? { ship_to_country: shipTo } : {}),
      target_currency: "USD",
      target_language: "en",
    });
    return { raw: r, result: r?.aliexpress_ds_product_get_response?.result };
  };
  let { raw: pd, result } = await productFor(country);
  if (result && !result.ae_item_sku_info_dtos) ({ raw: pd, result } = await productFor("US"));
  if (!result) return { error: "AliExpress ürün bilgisi alınamadı: " + JSON.stringify(pd).slice(0, 300) };
  const skus = list(result.ae_item_sku_info_dtos).map((s: any) => ({
    sku_id: String(s.sku_id || s.id || ""),
    sku_attr: s.sku_attr || list(s.ae_sku_property_dtos || s.aeop_s_k_u_propertys)
      .map((p: any) => `${p.sku_property_id}:${p.property_value_id_long || p.property_value_id}`).join(";") || null,
    price: parseFloat(s.offer_sale_price || s.sku_price) || null,
    stock: Number(s.sku_available_stock ?? s.s_k_u_available_stock ?? s.ipm_sku_stock ?? 0),
    label: list(s.ae_sku_property_dtos || s.aeop_s_k_u_propertys)
      .map((p: any) => p.property_value_definition_name || p.sku_property_value).filter(Boolean).join(" / ") || null,
  }));
  // Seçili SKU yoksa: stoğu olan en ucuz seçenek
  const sku = (skuId && skus.find((s) => s.sku_id === skuId))
    || skus.filter((s) => s.stock > 0 && s.price).sort((a, b) => a.price! - b.price!)[0]
    || skus[0] || null;

  let options: any[] = [];
  const fr = await aeCall("aliexpress.logistics.buyer.freight.calculate", accessToken, {
    param_aeop_freight_calculate_for_buyer_d_t_o: JSON.stringify({
      country_code: country,
      product_id: Number(productId),
      product_num: quantity,
      send_goods_country_code: "CN",
      ...(sku?.sku_id ? { sku_id: sku.sku_id } : {}),
      ...(sku?.price ? { price: String(sku.price), price_currency: "USD" } : {}),
    }),
  });
  const frRes = fr?.aliexpress_logistics_buyer_freight_calculate_response?.result;
  options = list(frRes?.aeop_freight_calculate_result_for_buyer_d_t_o_list)
    .map((o: any) => ({
      name: o.service_name,
      price: Number(o.freight?.amount ?? (o.freight?.cent != null ? o.freight.cent / 100 : NaN)),
      currency: o.freight?.currency_code || "USD",
      days: o.estimated_delivery_time || null,
    }))
    .filter((o: any) => o.name && String(o.name).toUpperCase() !== "VIRTUAL" && Number.isFinite(o.price) && o.price >= 0 && o.currency === "USD")
    .sort((a: any, b: any) => a.price - b.price);

  // Yedek: AliExpress'in yeni kargo servisi (aliexpress.ds.freight.query)
  let fr2: any = null;
  if (!options.length && sku?.sku_id) {
    fr2 = await aeCall("aliexpress.ds.freight.query", accessToken, {
      queryDeliveryReq: JSON.stringify({
        quantity, shipToCountry: country, productId: String(productId), selectedSkuId: sku.sku_id,
        language: "en_US", currency: "USD", locale: "en_US",
      }),
    });
    const r2 = fr2?.aliexpress_ds_freight_query_response?.result;
    options = list(r2?.delivery_options)
      .map((o: any) => ({
        name: o.code || o.company,
        price: o.free_shipping === true || o.free_shipping === "true" ? 0
          : Number(o.shipping_fee_cent != null ? Number(o.shipping_fee_cent) / 100 : String(o.shipping_fee_format || "").replace(/[^\d.]/g, "")),
        currency: o.shipping_fee_currency || "USD",
        days: o.delivery_date_desc || (o.max_delivery_days ? o.max_delivery_days + " gün" : null),
      }))
      .filter((o: any) => o.name && String(o.name).toUpperCase() !== "VIRTUAL" && Number.isFinite(o.price) && o.price >= 0 && o.currency === "USD")
      .sort((a: any, b: any) => a.price - b.price);
  }

  return {
    productId,
    ...(debug && fr2 ? { debugFreight2: JSON.stringify(fr2).slice(0, 1500) } : {}),
    // Teşhis: ürün yanıtının yapısı (ürün verisi gizli değil; anahtar içermez)
    ...(debug ? { debugProduct: JSON.stringify(result).slice(0, 3000), debugFreight: JSON.stringify(fr).slice(0, 1500) } : {}),
    sku,
    skus: skus.slice(0, 50),
    productUsd: sku?.price ?? null,
    shipping: options[0] || null,
    shippingError: options.length ? undefined : (frRes?.error_desc || "Bu ülkeye kargo seçeneği bulunamadı"),
  };
}

// Ürünün tüm bilgisi (linkten ürün yükleme): ad, açıklama, görseller, özellikler, seçenekler
async function detail(accessToken: string, productId: string, country: string) {
  const get = async (shipTo: string) => {
    const r = await aeCall("aliexpress.ds.product.get", accessToken, {
      product_id: productId, ship_to_country: shipTo, target_currency: "USD", target_language: "en",
    });
    return { raw: r, result: r?.aliexpress_ds_product_get_response?.result };
  };
  let { raw, result } = await get(country);
  if (!result || !result.ae_item_base_info_dto) ({ raw, result } = await get("US"));
  if (!result || !result.ae_item_base_info_dto) {
    return { error: "AliExpress ürün bilgisi alınamadı: " + JSON.stringify(raw?.error_response || raw).slice(0, 200) };
  }
  const base = result.ae_item_base_info_dto || {};
  const images = String(result.ae_multimedia_info_dto?.image_urls || "").split(";").map((x) => x.trim()).filter(Boolean);
  const specs = list(result.ae_item_properties?.ae_item_property || result.ae_item_properties)
    .map((p: any) => ({ k: String(p.attr_name || "").slice(0, 80), v: String(p.attr_value || "").slice(0, 200) }))
    .filter((p: any) => p.k && p.v);
  const variants = list(result.ae_item_sku_info_dtos).map((s: any) => {
    const props = list(s.ae_sku_property_dtos || s.aeop_s_k_u_propertys);
    const attributes: Record<string, string> = {};
    let image: string | null = null;
    props.forEach((p: any) => {
      const k = String(p.sku_property_name || "Seçenek");
      attributes[k] = String(p.property_value_definition_name || p.sku_property_value || "");
      if (p.sku_image && !image) image = String(p.sku_image);
    });
    return {
      supplier_variant_id: String(s.sku_id || s.id || ""),
      sku_attr: s.sku_attr || null,
      attributes,
      price: parseFloat(s.offer_sale_price || s.sku_price) || null,
      stock: Number(s.sku_available_stock ?? s.s_k_u_available_stock ?? s.ipm_sku_stock ?? 0),
      image,
    };
  }).filter((v: any) => v.supplier_variant_id);
  const prices = variants.map((v: any) => v.price).filter((n: any) => n > 0);
  return {
    item: {
      name: String(base.subject || "").slice(0, 300),
      description: String(base.detail || base.mobile_detail || ""),
      images: images.slice(0, 12),
      specs: specs.slice(0, 80),
      price: prices.length ? Math.min(...prices) : null,
      currency: "USD",
      stock: variants.reduce((a: number, v: any) => a + (v.stock || 0), 0),
      variants: variants.slice(0, 100),
      source_platform: "aliexpress",
      source_item_id: productId,
    },
  };
}

const hsHandler = (async (req: Request, userId: string | null = null) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const reqBody = await req.json().catch(() => ({}));
    const keyword = reqBody?.keyword || "";
    // action: "quote" -> fiyat, seçenek ve kargo (Ürün Ekle'de kargo dahil maliyet)
    const isQuote = reqBody?.action === "quote";
    const isDetail = reqBody?.action === "detail";
    if (!isQuote && !isDetail && !keyword) {
      return new Response(JSON.stringify({ error: "Arama kelimesi gerekli" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    // Satıcı kendi AliExpress hesabını bağladıysa onunla, yoksa sitenin hesabıyla
    const own = userId ? await sellerToken(supabase, userId) : null;
    let tok = own
      ? { accessToken: own, refreshToken: null, expiresAt: null }
      : await getStoredToken(supabase);

    if (!tok.accessToken) {
      return new Response(
        JSON.stringify({ error: "AliExpress hesabı henüz yetkilendirilmedi (access_token yok)" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (
      !own &&
      tok.expiresAt &&
      new Date(tok.expiresAt).getTime() < Date.now() + 5 * 60 * 1000 &&
      tok.refreshToken
    ) {
      const newToken = await refreshAccessToken(supabase, tok.refreshToken);
      if (newToken) tok.accessToken = newToken;
    }

    if (isDetail) {
      const productId = String(reqBody?.productId || "").replace(/\D/g, "");
      if (!productId) {
        return new Response(JSON.stringify({ error: "Ürün numarası gerekli" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const d = await detail(tok.accessToken as string, productId, String(reqBody?.country || "TR").toUpperCase().slice(0, 2));
      return new Response(JSON.stringify(d), {
        status: (d as any).error ? 502 : 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (isQuote) {
      const productId = String(reqBody?.productId || "").replace(/\D/g, "");
      if (!productId) {
        return new Response(JSON.stringify({ error: "Ürün numarası gerekli" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const q = await quote(tok.accessToken as string, productId, reqBody?.skuId ? String(reqBody.skuId) : null,
        Math.max(1, Math.min(99, parseInt(reqBody?.quantity, 10) || 1)), String(reqBody?.country || "TR").toUpperCase().slice(0, 2), reqBody?.debug === true);
      return new Response(JSON.stringify(q), {
        status: (q as any).error ? 502 : 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const hasNonAscii = /[^\x00-\x7F]/.test(keyword);
    let searchKeyword = keyword;
    let translateDebug: string | null = null;
    if (hasNonAscii) {
      const t = await translateToEnglish(keyword);
      searchKeyword = t.text;
      translateDebug = t.debug;
    }

    const params: Record<string, string> = {
      app_key: APP_KEY,
      sign_method: "sha256",
      timestamp: Date.now().toString(),
      access_token: tok.accessToken as string,
      method: "aliexpress.ds.text.search",
      keyWord: searchKeyword,
      pageIndex: "1",
      pageSize: "40",
      countryCode: String(reqBody?.country || "US").toUpperCase().slice(0, 2),
      currency: "USD",
      local: "en_US",
    };
    const sign = await signParams("", params);
    const body = new URLSearchParams({ ...params, sign });

    const searchRes = await fetch(SYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const searchData = await searchRes.json();

    if (searchData.error_response || searchData.code) {
      return new Response(
        JSON.stringify({ error: "AliExpress arama hatası: " + JSON.stringify(searchData).slice(0, 500) }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const rawList =
      searchData?.aliexpress_ds_text_search_response?.data?.products?.selection_search_product ||
      searchData?.data?.products ||
      [];

    // Gercek AliExpress DS API alan adlari (test sonucundan dogrulandi):
    // itemId, title, itemMainPic, targetSalePrice (USD - dogru!), salePrice (CNY - YANLIS, kullanma!)
    const products = (Array.isArray(rawList) ? rawList : []).map((p: any) => ({
      id: p.itemId || p.product_id || p.productId,
      name: p.title || p.product_title || p.subject,
      image: p.itemMainPic || p.product_main_image_url || p.image,
      priceUsd: parseFloat(p.targetSalePrice || p.target_sale_price) || 0,
    }));

    return new Response(
      JSON.stringify({
        products,
        searchedAs: searchKeyword,
        translateDebug,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});


// =========================================================
// GÜVENLİK: sadece giriş yapmış kullanıcılar bu fonksiyonu çalıştırabilir
// (sayfalar app.js sayesinde kullanıcının oturum anahtarını gönderir)
// =========================================================
async function hsIsLoggedIn(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token || token.split(".").length !== 3) return null;
  try {
    const r = await fetch((Deno.env.get("SUPABASE_URL") ?? "") + "/auth/v1/user", {
      headers: { Authorization: "Bearer " + token, apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? String(u.id) : null;
  } catch (_e) {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  // Sistem çağrısı (source-sync -> product-import -> burası): CRON_SECRET + satıcının kimliği
  let userId: string | null = null;
  if (req.method !== "OPTIONS") {
    const sys = await req.clone().json().catch(() => ({}));
    const cron = Deno.env.get("CRON_SECRET") ?? "";
    if (cron && typeof sys?.cronSecret === "string" && sys.cronSecret.trim() === cron.trim() && typeof sys?.userId === "string") {
      userId = sys.userId;
    } else {
      userId = await hsIsLoggedIn(req);
    }
  }
  if (req.method !== "OPTIONS" && !userId) {
    return new Response(JSON.stringify({ error: "Bu işlem için giriş yapmalısın. / Please log in." }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  return hsHandler(req, userId);
});