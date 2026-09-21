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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { keyword } = await req.json().catch(() => ({ keyword: "" }));
    if (!keyword) {
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