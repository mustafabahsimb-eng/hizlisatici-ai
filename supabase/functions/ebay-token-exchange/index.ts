import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// eBay site kodu -> sistemdeki pazaryeri kodu
const EBAY_SITES: Record<string, string> = {
  EBAY_US: "ebay_us",
  EBAY_GB: "ebay_uk",
  EBAY_DE: "ebay_de",
  EBAY_IT: "ebay_it",
  EBAY_IE: "ebay_ie",
  EBAY_CA: "ebay_ca",
  EBAY_ENCA: "ebay_ca",
};

// Bağlantıyı store_connections'a yaz (aynısı varsa güncelle), anahtarları şifreli kasaya (Vault) koy
async function saveConnection(admin: any, c: {
  userId: string; marketplaceCode: string; externalSellerId: string | null;
  expiresAt: string | null; credentials: Record<string, unknown>;
}) {
  const { data: mk } = await admin.from('marketplaces').select('name').eq('code', c.marketplaceCode).maybeSingle();
  let q = admin.from('store_connections').select('id')
    .eq('user_id', c.userId).eq('marketplace_code', c.marketplaceCode)
    .eq('environment', 'live').is('deleted_at', null);
  q = c.externalSellerId ? q.eq('external_seller_id', c.externalSellerId) : q.is('external_seller_id', null);
  const { data: existing } = await q.maybeSingle();

  const fields = {
    label: mk?.name || c.marketplaceCode,
    status: 'connected',
    token_expires_at: c.expiresAt,
    last_verified_at: new Date().toISOString(),
    last_error: null,
  };
  let connectionId: string;
  if (existing) {
    const { error } = await admin.from('store_connections').update(fields).eq('id', existing.id);
    if (error) throw error;
    connectionId = existing.id;
  } else {
    const { data: created, error } = await admin.from('store_connections')
      .insert({ user_id: c.userId, marketplace_code: c.marketplaceCode, environment: 'live', external_seller_id: c.externalSellerId, ...fields })
      .select('id').single();
    if (error) throw error;
    connectionId = created.id;
  }
  const { error: vaultError } = await admin.rpc('store_connection_set_credentials', {
    p_connection_id: connectionId,
    p_credentials: c.credentials,
  });
  if (vaultError) throw vaultError;
  return connectionId;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { code } = await req.json();

    if (!code) {
      return new Response(JSON.stringify({ error: "Missing code" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await supabaseAuth.auth.getUser();

    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Invalid user session" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const ebayClientId = Deno.env.get("EBAY_CLIENT_ID")!;
    const ebayClientSecret = Deno.env.get("EBAY_CLIENT_SECRET")!;
    const ebayRuName = Deno.env.get("EBAY_RUNAME")!;

    const basicAuth = btoa(`${ebayClientId}:${ebayClientSecret}`);

    const tokenResponse = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        redirect_uri: ebayRuName,
      }).toString(),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      return new Response(JSON.stringify({ error: "eBay token exchange failed", details: tokenData }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { access_token, refresh_token, expires_in, refresh_token_expires_in } = tokenData;
    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

    // Hesabın kayıtlı olduğu eBay sitesi ve kullanıcı adı (izin verilmemişse ABD sitesi varsayılır)
    let marketplaceCode = "ebay_us";
    let ebayUser: string | null = null;
    try {
      const idRes = await fetch("https://apiz.ebay.com/commerce/identity/v1/user/", {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      if (idRes.ok) {
        const idData = await idRes.json();
        ebayUser = idData.username || idData.userId || null;
        const site = EBAY_SITES[String(idData.registrationMarketplaceId || "")];
        if (site) marketplaceCode = site;
      }
    } catch (_e) { /* varsayılanla devam */ }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    try {
      await saveConnection(supabaseAdmin, {
        userId: user.id,
        marketplaceCode,
        externalSellerId: ebayUser,
        expiresAt,
        credentials: {
          access_token,
          refresh_token,
          expires_at: expiresAt,
          refresh_token_expires_at: refresh_token_expires_in
            ? new Date(Date.now() + refresh_token_expires_in * 1000).toISOString()
            : null,
        },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Database error", details: (e as Error).message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});