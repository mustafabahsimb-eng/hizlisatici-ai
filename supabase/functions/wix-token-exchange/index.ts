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
    const code = body?.code;

    if (!code) {
      return json({ error: 'code gerekli.' }, 400);
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // GÜVENLİK: kullanıcı, sayfanın gönderdiği numaradan değil, giriş anahtarından tespit edilir
    const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    const accessToken = String(body?.userAccessToken || bearer || '');
    const { data: authData } = accessToken
      ? await supabaseAdmin.auth.getUser(accessToken)
      : { data: { user: null } };
    const userId = authData?.user?.id;
    if (!userId) {
      return json({ connected: false, error: 'Oturum doğrulanamadı, lütfen tekrar giriş yap.' }, 401);
    }
    if (body?.userId && body.userId !== userId) {
      return json({ connected: false, error: 'Kullanıcı eşleşmiyor.' }, 403);
    }

    const clientId = 'b6cd9721-a09f-4257-b18a-c6d3654aa038';
    const clientSecret = Deno.env.get('WIX_CLIENT_SECRET') ?? '';

    if (!clientSecret) {
      return json({ connected: false, error: 'WIX_CLIENT_SECRET tanımlı değil.' });
    }

    const tokenResponse = await fetch('https://www.wix.com/oauth/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    const tokenData = await tokenResponse.json().catch(() => null);

    if (!tokenResponse.ok || !tokenData || !tokenData.access_token) {
      const msg = tokenData?.error_description || tokenData?.error || 'Wix token alışverişi başarısız oldu.';
      return json({ connected: false, error: `Wix: ${msg}` });
    }

    // Wix sitesinin kimliği (instanceId) dönüş adresinde gelir
    const instanceId = /^[0-9a-f-]{36}$/i.test(String(body?.instanceId || '')) ? String(body.instanceId) : null;
    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString()
      : null;

    try {
      await saveConnection(supabaseAdmin, {
        userId,
        marketplaceCode: 'wix',
        externalSellerId: instanceId,
        expiresAt,
        credentials: {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token || null,
          expires_at: expiresAt,
          instance_id: instanceId,
        },
      });
    } catch (e) {
      return json({ connected: false, error: `Veritabanı hatası: ${(e as Error).message}` });
    }

    return json({ connected: true });
  } catch (err) {
    return json({ error: (err && (err as Error).message) || 'Sunucu hatası' }, 500);
  }
});