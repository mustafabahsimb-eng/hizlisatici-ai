import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const { code, codeVerifier } = body;
    if (!code || !codeVerifier) {
      return json({ error: 'code ve codeVerifier gerekli.' }, 400);
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // GÜVENLİK: kullanıcıyı gönderilen userId'ye göre değil, oturum anahtarına göre belirle.
    // Oturum anahtarı gövdede (userAccessToken) ya da Authorization başlığında gelebilir.
    const authHeader = req.headers.get('Authorization') || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const candidates = [body.userAccessToken, bearer].filter((t) => typeof t === 'string' && t.length > 20);

    let userId: string | null = null;
    for (const token of candidates) {
      const { data } = await supabaseAdmin.auth.getUser(token);
      if (data && data.user) { userId = data.user.id; break; }
    }
    if (!userId) {
      return json({ connected: false, error: 'Oturum doğrulanamadı. Lütfen tekrar giriş yapıp bağlanmayı dene.' }, 401);
    }
    if (body.userId && body.userId !== userId) {
      return json({ connected: false, error: 'Oturum ile kullanıcı eşleşmiyor.' }, 403);
    }

    const clientId = '1z497h37rk069va5r0xvxqw3';
    const redirectUri = 'https://mustafabahsimb-eng.github.io/hizlisatici-ai/etsy-callback.html';

    const tokenResponse = await fetch('https://api.etsy.com/v3/public/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code,
        code_verifier: codeVerifier,
      }).toString(),
    });

    const tokenData = await tokenResponse.json().catch(() => null);

    if (!tokenResponse.ok || !tokenData || !tokenData.access_token) {
      const msg = tokenData?.error_description || tokenData?.error || 'Etsy token alışverişi başarısız oldu.';
      return json({ connected: false, error: `Etsy: ${msg}` });
    }

    const expiresAt = new Date(Date.now() + (tokenData.expires_in ?? 3600) * 1000).toISOString();
    // Etsy anahtarı "<kullanıcı no>.<anahtar>" biçimindedir; kullanıcı no mağaza kimliği olarak saklanır
    const etsyUserId = String(tokenData.access_token).split('.')[0] || null;

    try {
      await saveConnection(supabaseAdmin, {
        userId,
        marketplaceCode: 'etsy',
        externalSellerId: etsyUserId,
        expiresAt,
        credentials: {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_at: expiresAt,
        },
      });
    } catch (e) {
      return json({ connected: false, error: `Veritabanı hatası: ${(e as Error).message}` });
    }

    return json({ connected: true });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});