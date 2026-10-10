// Supabase Edge Function: aliexpress-token-exchange
// Satıcının kendi AliExpress hesabını bağlar (OAuth). Sipariş satıcının hesabından verilir
// ve ödeme o hesaptaki kayıtlı kartla yapılır; bu yüzden her satıcı kendi hesabını bağlar.
//   action "authorize_url" -> AliExpress izin adresi (tek kullanımlık güvenlik kodu ile)
//   action "exchange"      -> { code, state } doğrula, anahtarları şifreli kasaya (Vault) yaz
//   action "disconnect"    -> bağlantıyı (ve kasadaki anahtarı) sil
// Bağlanan kullanıcı site sahibiyse sitenin ürün arama hesabı (platform_tokens) da yenilenir.
// Güvenlik: sadece giriş yapmış kullanıcı (sayfalar app.js ile oturum anahtarını gönderir).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const APP_KEY = Deno.env.get("ALIEXPRESS_APP_KEY") || "";
const APP_SECRET = Deno.env.get("ALIEXPRESS_APP_SECRET") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOKEN_URL = "https://api-sg.aliexpress.com/rest/auth/token/create";
const AUTHORIZE_URL = "https://api-sg.aliexpress.com/oauth/authorize";
const REDIRECT_URI = "https://mustafabahsimb-eng.github.io/hizlisatici-ai/aliexpress-callback.html";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

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

async function signParams(secret: string, pathname: string, params: Record<string, string>): Promise<string> {
  const sortedKeys = Object.keys(params).sort();
  const joined = sortedKeys.map((k) => k + params[k]).join("");
  const base = pathname + joined;
  return await hmacSha256Hex(secret, base);
}

// AliExpress süreleri bazen saniye, bazen milisaniye cinsinden zaman damgası olarak döner
function toIso(expiresIn: unknown, expireTime: unknown, fallbackSec: number): string {
  const t = Number(expireTime);
  if (Number.isFinite(t) && t > 1e12) return new Date(t).toISOString();
  const s = Number(expiresIn);
  return new Date(Date.now() + (Number.isFinite(s) && s > 0 ? s : fallbackSec) * 1000).toISOString();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    // Kullanıcı: Authorization başlığındaki oturum anahtarı
    const userToken = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const { data: u } = userToken && userToken.split(".").length === 3
      ? await admin.auth.getUser(userToken)
      : { data: { user: null } };
    const userId = u?.user?.id;
    if (!userId) return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const action = String(body?.action || "exchange");

    // ---------- İzin adresi ----------
    if (action === "authorize_url") {
      const state = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      await admin.from("oauth_states").delete().lt("created_at", new Date(Date.now() - 3600000).toISOString());
      const { error } = await admin.from("oauth_states").insert({ state, user_id: userId, provider: "aliexpress" });
      if (error) return json({ error: "Güvenlik kodu oluşturulamadı: " + error.message }, 500);
      const url = AUTHORIZE_URL + "?" + new URLSearchParams({
        response_type: "code",
        force_auth: "true",
        redirect_uri: REDIRECT_URI,
        client_id: APP_KEY,
        state,
      }).toString();
      return json({ url });
    }

    // ---------- Bağlantıyı kaldır ----------
    if (action === "disconnect") {
      const { error } = await admin.from("supplier_connections").delete().eq("user_id", userId).eq("supplier", "aliexpress");
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action !== "exchange") return json({ error: "Bilinmeyen işlem" }, 400);

    // ---------- Kodu anahtara çevir ----------
    const code = String(body?.code || "");
    const state = String(body?.state || "");
    if (!code || !state) return json({ error: "Eksik bilgi (code, state)" }, 400);

    const { data: st } = await admin.from("oauth_states").select("user_id, provider, created_at").eq("state", state).maybeSingle();
    if (!st || st.user_id !== userId || st.provider !== "aliexpress") {
      return json({ error: "Güvenlik kodu geçersiz. Hesaplarım sayfasından tekrar bağlanmayı dene." }, 403);
    }
    await admin.from("oauth_states").delete().eq("state", state);
    if (Date.now() - new Date(st.created_at).getTime() > 3600000) {
      return json({ error: "Bağlantı isteğinin süresi doldu. Tekrar bağlanmayı dene." }, 403);
    }

    const pathname = "/auth/token/create";
    const params: Record<string, string> = {
      app_key: APP_KEY,
      code,
      sign_method: "sha256",
      timestamp: Date.now().toString(),
    };
    const sign = await signParams(APP_SECRET, pathname, params);
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, sign }).toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.access_token) {
      return json({ error: "AliExpress anahtarı alınamadı: " + String(data.message || data.error_msg || data.code || "bilinmeyen hata").slice(0, 200) }, 502);
    }

    const expiresAt = toIso(data.expires_in, data.expire_time, 7 * 24 * 3600);
    const refreshExpiresAt = data.refresh_token ? toIso(data.refresh_expires_in, data.refresh_token_valid_time, 30 * 24 * 3600) : null;
    const accountName = String(data.user_nick || data.account || "").slice(0, 120) || null;

    // Satıcının bağlantısı (varsa güncelle)
    const { data: conn, error: cErr } = await admin.from("supplier_connections").upsert({
      user_id: userId,
      supplier: "aliexpress",
      account_name: accountName,
      external_account_id: data.user_id ? String(data.user_id) : null,
      token_expires_at: expiresAt,
      refresh_expires_at: refreshExpiresAt,
      status: "connected",
      last_error: null,
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,supplier" }).select("id").single();
    if (cErr) return json({ error: "Bağlantı kaydedilemedi: " + cErr.message }, 500);

    const { error: vErr } = await admin.rpc("supplier_connection_set_credentials", {
      p_connection_id: conn.id,
      p_credentials: {
        access_token: data.access_token,
        refresh_token: data.refresh_token || null,
        expires_at: expiresAt,
        refresh_expires_at: refreshExpiresAt,
      },
    });
    if (vErr) return json({ error: "Anahtarlar kaydedilemedi: " + vErr.message }, 500);

    // Site sahibi bağlandıysa sitenin ürün arama hesabını da yenile
    const userDb = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: { headers: { Authorization: "Bearer " + userToken } },
      auth: { persistSession: false },
    });
    const { data: isOwner } = await userDb.rpc("hs_is_owner");
    let platformUpdated = false;
    if (isOwner === true) {
      const { error: pErr } = await admin.from("platform_tokens").upsert({
        platform: "aliexpress",
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: expiresAt,
        refresh_expires_at: refreshExpiresAt,
        status: "ok",
        last_error: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "platform" });
      platformUpdated = !pErr;
    }

    return json({ success: true, account: accountName, platformUpdated });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
