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

const hsHandler = (async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { keyword, userAccessToken } = body;
    // action: "freight" -> ürünün seçilen ülkeye en ucuz kargo ücreti (Ürün Ekle'de kargo dahil maliyet)
    const isFreight = body?.action === "freight";
    if (!isFreight && !keyword) {
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

    if (isFreight) {
      const pid = String(body?.pid || "");
      let vid = String(body?.vid || "");
      const country = String(body?.country || "TR").toUpperCase().slice(0, 2);
      const quantity = Math.max(1, Math.min(99, parseInt(body?.quantity, 10) || 1));
      let productUsd: number | null = null;
      if (pid) {
        const pr = await fetch(`https://developers.cjdropshipping.com/api2.0/v1/product/query?pid=${encodeURIComponent(pid)}`, {
          headers: { "CJ-Access-Token": accessToken },
        });
        const pd = await pr.json().catch(() => ({}));
        const variants = pd?.data?.variants || [];
        const v = (vid && variants.find((x: any) => x.vid === vid)) || variants[0];
        if (v) {
          vid = vid || v.vid;
          productUsd = parseFloat(v.variantSellPrice ?? v.sellPrice) || null;
        }
      }
      if (!vid) {
        return new Response(JSON.stringify({ error: "CJ ürün seçeneği bulunamadı" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const fr = await fetch("https://developers.cjdropshipping.com/api2.0/v1/logistic/freightCalculate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CJ-Access-Token": accessToken },
        body: JSON.stringify({ startCountryCode: "CN", endCountryCode: country, products: [{ quantity, vid }] }),
      });
      const fd = await fr.json().catch(() => ({}));
      const options = (Array.isArray(fd?.data) ? fd.data : [])
        .map((x: any) => ({ name: x.logisticName, price: Number(x.totalPostageFee ?? x.logisticPrice), days: x.logisticAging || null }))
        .filter((x: any) => x.name && Number.isFinite(x.price) && x.price >= 0)
        .sort((a: any, b: any) => a.price - b.price);
      return new Response(JSON.stringify({
        vid,
        productUsd,
        shipping: options[0] || null,
        error: options.length ? undefined : (fd?.message ? "Kargo seçeneği yok: " + String(fd.message).slice(0, 160) : "Bu ülkeye kargo seçeneği yok"),
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
