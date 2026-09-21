// Supabase Edge Function: cj-search
// CJ Dropshipping API ile urun arar.
// Once kullanicinin kendi baglamis oldugu CJ API anahtari var mi diye bakar
// (user_integrations tablosu, RLS ile korunuyor). Varsa onu kullanir,
// yoksa sitenin paylasilan/demo CJ_API_KEY anahtarina duser.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CJ_API_KEY_DEFAULT = Deno.env.get("CJ_API_KEY") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const AUTH_URL = "https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken";
const SEARCH_URL = "https://developers.cjdropshipping.com/api2.0/v1/product/listV2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Kullanicinin kendi CJ API anahtarini user_integrations tablosundan getirir.
// userAccessToken kullanicinin oturum access_token'i - RLS sayesinde
// sadece kendi satirini gorebilir, baska kullanicilarin anahtarini asla gormez.
async function getUserCjApiKey(userAccessToken: string | undefined): Promise<string | null> {
  if (!userAccessToken) return null;
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: "Bearer " + userAccessToken } },
    });
    const { data, error } = await supabase
      .from("user_integrations")
      .select("api_key")
      .eq("platform", "cj")
      .maybeSingle();
    if (error) return null;
    return data?.api_key || null;
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { keyword, userAccessToken } = await req.json().catch(() => ({ keyword: "", userAccessToken: undefined }));
    if (!keyword) {
      return new Response(JSON.stringify({ error: "Arama kelimesi gerekli" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userApiKey = await getUserCjApiKey(userAccessToken);
    const CJ_API_KEY = userApiKey || CJ_API_KEY_DEFAULT;
    const usingOwnAccount = !!userApiKey;

    if (!CJ_API_KEY) {
      return new Response(JSON.stringify({ error: "CJ Dropshipping API anahtarı bulunamadı" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authRes = await fetch(AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: CJ_API_KEY }),
    });
    const authData = await authRes.json();
    const accessToken = authData?.data?.accessToken;

    if (!accessToken) {
      const prefix = usingOwnAccount ? "Kendi CJ hesabınla giriş başarısız: " : "CJ girişi başarısız: ";
      return new Response(
        JSON.stringify({ error: prefix + JSON.stringify(authData).slice(0, 400) }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const searchRes = await fetch(
      `${SEARCH_URL}?keyWord=${encodeURIComponent(keyword)}&page=1&size=40`,
      {
        method: "GET",
        headers: { "CJ-Access-Token": accessToken },
      }
    );
    const searchData = await searchRes.json();

    const rawList = searchData?.data?.content?.[0]?.productList || [];

    const products = (Array.isArray(rawList) ? rawList : []).map((p: any) => ({
      id: p.id,
      sku: p.sku,
      name: p.nameEn,
      image: p.bigImage,
      priceUsd: parseFloat(p.sellPrice) || 0,
    }));

    return new Response(
      JSON.stringify({
        products,
        searchedAs: keyword,
        usingOwnAccount,
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