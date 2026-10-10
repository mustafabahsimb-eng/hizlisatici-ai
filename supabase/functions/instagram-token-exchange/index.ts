import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const REDIRECT_URI = "https://mustafabahsimb-eng.github.io/hizlisatici-ai/instagram-callback.html";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const APP_ID = Deno.env.get("INSTAGRAM_APP_ID");
    const APP_SECRET = Deno.env.get("INSTAGRAM_APP_SECRET");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    if (!APP_ID || !APP_SECRET) {
      return json({ error: "Instagram uygulama anahtarları tanımlı değil" }, 500);
    }

    const { code, state, userAccessToken } = await req.json();
    if (!code || !state || !userAccessToken) {
      return json({ error: "Eksik bilgi (code, state, userAccessToken)" }, 400);
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    // 1) Kullanıcıyı doğrula
    const { data: userData, error: userErr } = await supabase.auth.getUser(userAccessToken);
    if (userErr || !userData?.user) return json({ error: "Oturum doğrulanamadı" }, 401);
    const userId = userData.user.id;

    // 2) Tek kullanımlık güvenlik kodunu kontrol et ve sil
    const { data: stateRow } = await supabase
      .from("oauth_states")
      .select("state, user_id, provider, created_at")
      .eq("state", state)
      .maybeSingle();

    if (!stateRow || stateRow.user_id !== userId || stateRow.provider !== "instagram") {
      return json({ error: "Geçersiz güvenlik kodu, lütfen tekrar bağlanmayı deneyin" }, 400);
    }
    await supabase.from("oauth_states").delete().eq("state", state);

    if (Date.now() - new Date(stateRow.created_at).getTime() > 60 * 60 * 1000) {
      return json({ error: "Bağlantı süresi doldu, lütfen tekrar deneyin" }, 400);
    }

    // 3) Kodu kısa ömürlü token ile değiştir
    const cleanCode = String(code).replace(/#_$/, "");
    const form = new URLSearchParams({
      client_id: APP_ID,
      client_secret: APP_SECRET,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      code: cleanCode,
    });

    const shortRes = await fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const shortJson = await shortRes.json();
    const shortData = Array.isArray(shortJson?.data) ? shortJson.data[0] : shortJson;
    const shortToken = shortData?.access_token;

    if (!shortRes.ok || !shortToken) {
      return json({ error: "Instagram kodu kabul etmedi", detail: shortJson }, 400);
    }

    // 4) 60 günlük uzun ömürlü token al
    const longUrl = new URL("https://graph.instagram.com/access_token");
    longUrl.searchParams.set("grant_type", "ig_exchange_token");
    longUrl.searchParams.set("client_secret", APP_SECRET);
    longUrl.searchParams.set("access_token", shortToken);

    const longRes = await fetch(longUrl);
    const longJson = await longRes.json();
    const longToken = longJson?.access_token;
    const expiresIn = Number(longJson?.expires_in) || 60 * 24 * 60 * 60;

    if (!longRes.ok || !longToken) {
      return json({ error: "Uzun süreli token alınamadı", detail: longJson }, 400);
    }

    // 5) Hesap bilgilerini çek
    const meUrl = new URL("https://graph.instagram.com/me");
    meUrl.searchParams.set("fields", "user_id,username,account_type,profile_picture_url");
    meUrl.searchParams.set("access_token", longToken);

    const meRes = await fetch(meUrl);
    const me = await meRes.json();
    const accountId = String(me?.user_id ?? me?.id ?? shortData?.user_id ?? "");

    if (!meRes.ok || !accountId) {
      return json({ error: "Instagram hesap bilgisi alınamadı", detail: me }, 400);
    }

    // 6) Kanalı kaydet / güncelle
    const nowIso = new Date().toISOString();
    const { data: channel, error: upErr } = await supabase
      .from("social_channels")
      .upsert(
        {
          user_id: userId,
          platform: "instagram",
          account_id: accountId,
          account_name: me?.username ?? null,
          active: true,
          token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
          extra: {
            account_type: me?.account_type ?? null,
            profile_picture_url: me?.profile_picture_url ?? null,
            permissions: shortData?.permissions ?? null,
          },
          connected_at: nowIso,
          updated_at: nowIso,
        },
        { onConflict: "user_id,platform,account_id" },
      )
      .select("id, account_name")
      .single();

    if (upErr || !channel) {
      return json({ error: "Kanal kaydedilemedi", detail: upErr?.message }, 500);
    }

    // 7) Token'ı kasaya koy
    const { error: vaultErr } = await supabase.rpc("social_channel_set_token", {
      p_channel_id: channel.id,
      p_token: longToken,
    });
    if (vaultErr) {
      return json({ error: "Token güvenli kasaya kaydedilemedi", detail: vaultErr.message }, 500);
    }

    return json({ ok: true, channel_id: channel.id, account_name: channel.account_name });
  } catch (e) {
    return json({ error: "Beklenmeyen hata", detail: String(e) }, 500);
  }
});