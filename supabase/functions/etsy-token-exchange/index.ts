import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { ETSY_CLIENT_ID, ETSY_REDIRECT, etsyApiKey, etsyConfigured, etsyShop } from '../_shared/etsy.ts';
import { featureEnabled, FEATURE_OFF_MSG } from '../_shared/features.ts';

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
  userId: string; marketplaceCode: string; externalSellerId: string | null; label?: string;
  expiresAt: string | null; credentials: Record<string, unknown>;
}) {
  const { data: mk } = await admin.from('marketplaces').select('name').eq('code', c.marketplaceCode).maybeSingle();
  let q = admin.from('store_connections').select('id')
    .eq('user_id', c.userId).eq('marketplace_code', c.marketplaceCode)
    .eq('environment', 'live').is('deleted_at', null);
  q = c.externalSellerId ? q.eq('external_seller_id', c.externalSellerId) : q.is('external_seller_id', null);
  const { data: existing } = await q.maybeSingle();

  const fields = {
    label: c.label || mk?.name || c.marketplaceCode,
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
    // Hesaplarım sayfası Etsy onay adresini kurarken keystring'i buradan alır (herkese açık değer; tek kaynak: secret ETSY_KEYSTRING)
    if (body.action === 'config') return json({ clientId: ETSY_CLIENT_ID || null, configured: etsyConfigured(), redirectUri: ETSY_REDIRECT });
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

    // Son bağlanma denemesinin sonucu (gizli bilgi yok) -> app_cache 'etsy_connect:<user>' (teşhis için)
    const note = async (ok: boolean, error?: string) => {
      try { await supabaseAdmin.from('app_cache').upsert({ key: 'etsy_connect:' + userId, value: { ok, error: error || null, at: new Date().toISOString() }, updated_at: new Date().toISOString() }); } catch (_) { /* yok say */ }
    };
    const fail = async (error: string, status = 200) => { await note(false, error); return json({ connected: false, error }, status); };
    if (!(await featureEnabled(userId, 'etsy'))) return await fail(FEATURE_OFF_MSG, 403);
    if (!etsyConfigured()) return await fail('Etsy uygulama anahtarı (ETSY_KEYSTRING / ETSY_SHARED_SECRET) tanımlı değil.', 503);
    const clientId = ETSY_CLIENT_ID;
    const redirectUri = ETSY_REDIRECT;

    const tokenResponse = await fetch('https://api.etsy.com/v3/public/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-api-key': etsyApiKey() },
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
      return await fail(`Etsy: ${msg}`);
    }

    const expiresAt = new Date(Date.now() + (tokenData.expires_in ?? 3600) * 1000).toISOString();
    // Mağaza numarası ve adı (ilan gönderme / sipariş çekme mağaza numarasıyla çalışır)
    let shop: { userId: string; shopId: string | null; shopName: string | null; currency: string | null };
    try {
      shop = await etsyShop({ token: tokenData.access_token });
    } catch (e) {
      return await fail('Etsy mağaza bilgisi okunamadı: ' + (e as Error).message);
    }
    if (!shop.shopId) return await fail("Bu Etsy hesabında açık bir mağaza yok. Önce Etsy'de mağazanı aç.");

    try {
      await saveConnection(supabaseAdmin, {
        userId,
        marketplaceCode: 'etsy',
        externalSellerId: shop.shopId,
        label: shop.shopName ? 'Etsy · ' + shop.shopName : 'Etsy',
        expiresAt,
        credentials: {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_at: expiresAt,
          etsy_user_id: shop.userId,
          shop_id: shop.shopId,
          shop_name: shop.shopName,
          shop_currency: shop.currency,
        },
      });
    } catch (e) {
      return await fail(`Veritabanı hatası: ${(e as Error).message}`);
    }

    await note(true);
    // Mağazadaki mevcut ilanları hemen içe aktar (etsy-sync; arka planda, bağlanmayı bekletmez)
    const sync = fetch(Deno.env.get('SUPABASE_URL') + '/functions/v1/etsy-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cronSecret: Deno.env.get('CRON_SECRET') ?? '', userId }) }).catch(() => null);
    // @ts-ignore: Supabase Edge Runtime
    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(sync);
    return json({ connected: true, shopName: shop.shopName });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});