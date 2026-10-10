// Supabase Edge Function: social-meta-connect
// "Facebook ile bağlan" penceresinden dönen kodu alır; satıcının Facebook sayfalarını
// ve bu sayfalara bağlı Instagram işletme hesaplarını Seltigo'ya otomatik bağlar.
// Ayrıca katalog işlemleri için uzun ömürlü kullanıcı anahtarını saklar
// ve satıcının WhatsApp Business numaralarını otomatik bulup bağlar.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const FB_APP_ID = "1650835089949068";
const FB_APP_SECRET = Deno.env.get("FACEBOOK_CLIENT_SECRET");
const GRAPH = "https://graph.facebook.com/v21.0";

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

async function graph(path: string, params: Record<string, string>) {
  const url = new URL(GRAPH + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString());
  const d = await r.json();
  if (d.error) throw new Error(d.error.message || "Facebook hatası");
  return d;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { userAccessToken, code, redirectUri } = await req.json().catch(() => ({}));
    if (!userAccessToken) return json({ error: "Oturum bilgisi gerekli" }, 400);
    if (!code || !redirectUri) return json({ error: "Facebook kodu eksik" }, 400);
    if (!FB_APP_SECRET) return json({ error: "FACEBOOK_CLIENT_SECRET eksik" }, 500);

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: "Bearer " + userAccessToken } },
    });
    const { data: userData, error: userErr } = await supabase.auth.getUser(userAccessToken);
    if (userErr || !userData?.user) return json({ error: "Oturum geçersiz" }, 401);
    const userId = userData.user.id;

    // 1) Kod -> kısa ömürlü anahtar -> uzun ömürlü anahtar
    const short = await graph("/oauth/access_token", {
      client_id: FB_APP_ID,
      client_secret: FB_APP_SECRET,
      redirect_uri: redirectUri,
      code,
    });
    const long = await graph("/oauth/access_token", {
      grant_type: "fb_exchange_token",
      client_id: FB_APP_ID,
      client_secret: FB_APP_SECRET,
      fb_exchange_token: short.access_token,
    });
    const userToken = long.access_token || short.access_token;

    // Katalog (WhatsApp / Instagram / Facebook mağazası) işlemleri için kullanıcı anahtarını sakla
    await supabase.from("meta_catalogs").upsert(
      { user_id: userId, user_token: userToken, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );

    // 2) Satıcının sayfaları + bağlı Instagram hesapları
    const pages = await graph("/me/accounts", {
      access_token: userToken,
      fields: "id,name,access_token,instagram_business_account{id,username,name,profile_picture_url}",
      limit: "100",
    });
    const list = pages.data || [];

    // 3) WhatsApp Business numaraları (sayfası olmayan, sadece WhatsApp'tan satan satıcı için de)
    const waRows: any[] = [];
    try {
      const biz = await graph("/me/businesses", { access_token: userToken, fields: "id,name", limit: "50" });
      for (const b of biz.data || []) {
        for (const edge of ["owned_whatsapp_business_accounts", "client_whatsapp_business_accounts"]) {
          let wabas: any = { data: [] };
          try { wabas = await graph(`/${b.id}/${edge}`, { access_token: userToken, fields: "id,name", limit: "50" }); } catch { /* izin yoksa geç */ }
          for (const w of wabas.data || []) {
            let phones: any = { data: [] };
            try {
              phones = await graph(`/${w.id}/phone_numbers`, {
                access_token: userToken, fields: "id,display_phone_number,verified_name", limit: "50",
              });
            } catch { /* geç */ }
            for (const ph of phones.data || []) {
              waRows.push({
                user_id: userId,
                platform: "whatsapp",
                account_id: String(ph.id),
                account_name: ph.display_phone_number ? `${ph.verified_name || w.name || ""} ${ph.display_phone_number}`.trim() : (w.name || "WhatsApp"),
                access_token: userToken,
                extra: { waba_id: String(w.id), business_id: String(b.id), phone: ph.display_phone_number || null },
                active: true,
                updated_at: new Date().toISOString(),
              });
            }
          }
        }
      }
    } catch { /* WhatsApp yoksa sorun değil */ }

    if (!list.length && !waRows.length) {
      return json({ error: "Facebook sayfası ya da WhatsApp Business hesabı bulunamadı. Bağlanırken hesaplarını seçtiğinden emin ol." }, 400);
    }

    const now = new Date().toISOString();
    const rows: any[] = [...waRows];
    for (const p of list) {
      rows.push({
        user_id: userId,
        platform: "facebook",
        account_id: String(p.id),
        account_name: p.name,
        access_token: p.access_token,
        extra: {},
        active: true,
        updated_at: now,
      });
      const ig = p.instagram_business_account;
      if (ig?.id) {
        rows.push({
          user_id: userId,
          platform: "instagram",
          account_id: String(ig.id),
          account_name: ig.username ? "@" + ig.username : (ig.name || p.name),
          access_token: p.access_token,
          extra: { page_id: String(p.id), username: ig.username || null, picture: ig.profile_picture_url || null },
          active: true,
          updated_at: now,
        });
      }
    }

    const { error } = await supabase
      .from("social_channels")
      .upsert(rows, { onConflict: "user_id,platform,account_id" });
    if (error) throw error;

    return json({
      ok: true,
      facebook: rows.filter((r) => r.platform === "facebook").map((r) => r.account_name),
      instagram: rows.filter((r) => r.platform === "instagram").map((r) => r.account_name),
      whatsapp: rows.filter((r) => r.platform === "whatsapp").map((r) => r.account_name),
    });
  } catch (err) {
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});