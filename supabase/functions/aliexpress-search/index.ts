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
async function quote(accessToken: string, productId: string, skuId: string | null, quantity: number, country: string) {
  const pd = await aeCall("aliexpress.ds.product.get", accessToken, {
    product_id: productId,
    ship_to_country: country,
    target_currency: "USD",
    target_language: "en",
  });
  const result = pd?.aliexpress_ds_product_get_response?.result;
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
    .filter((o: any) => o.name && Number.isFinite(o.price) && o.price >= 0 && o.currency === "USD")
    .sort((a: any, b: any) => a.price - b.price);

  return {
    productId,
    sku,
    skus: skus.slice(0, 50),
    productUsd: sku?.price ?? null,
    shipping: options[0] || null,
    shippingError: options.length ? undefined : (frRes?.error_desc || "Bu ülkeye kargo seçeneği bulunamadı"),
  };
}

const hsHandler = (async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const reqBody = await req.json().catch(() => ({}));
    const keyword = reqBody?.keyword || "";
    // action: "quote" -> fiyat, seçenek ve kargo (Ürün Ekle'de kargo dahil maliyet)
    const isQuote = reqBody?.action === "quote";
    if (!isQuote && !keyword) {
      return new Response(JSON.stringify({ error: "Arama kelimesi gerekli" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    let tok = await getStoredToken(supabase);

    if (!tok.accessToken) {
      return new Response(
        JSON.stringify({ error: "AliExpress hesabı henüz yetkilendirilmedi (access_token yok)" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (
      tok.expiresAt &&
      new Date(tok.expiresAt).getTime() < Date.now() + 5 * 60 * 1000 &&
      tok.refreshToken
    ) {
      const newToken = await refreshAccessToken(supabase, tok.refreshToken);
      if (newToken) tok.accessToken = newToken;
    }

    if (isQuote) {
      const productId = String(reqBody?.productId || "").replace(/\D/g, "");
      if (!productId) {
        return new Response(JSON.stringify({ error: "Ürün numarası gerekli" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const q = await quote(tok.accessToken as string, productId, reqBody?.skuId ? String(reqBody.skuId) : null,
        Math.max(1, Math.min(99, parseInt(reqBody?.quantity, 10) || 1)), String(reqBody?.country || "TR").toUpperCase().slice(0, 2));
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
      countryCode: "US",
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
async function hsIsLoggedIn(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token || token.split(".").length !== 3) return false;
  try {
    const r = await fetch((Deno.env.get("SUPABASE_URL") ?? "") + "/auth/v1/user", {
      headers: { Authorization: "Bearer " + token, apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" },
    });
    if (!r.ok) return false;
    const u = await r.json();
    return !!(u && u.id);
  } catch (_e) {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "OPTIONS" && !(await hsIsLoggedIn(req))) {
    return new Response(JSON.stringify({ error: "Bu işlem için giriş yapmalısın. / Please log in." }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  return hsHandler(req);
});