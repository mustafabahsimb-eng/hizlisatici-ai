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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const shop = String(body?.shop || '').trim().toLowerCase();
    const code = body?.code;

    if (!shop || !code) {
      return json({ error: 'shop ve code gerekli.' }, 400);
    }

    // GÜVENLİK: sadece gerçek Shopify mağaza adreslerine istek atılır
    // (aksi halde gizli anahtar başka bir siteye gönderilebilirdi)
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
      return json({ connected: false, error: 'Geçersiz Shopify mağaza adresi.' }, 400);
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

    const clientId = 'b2e6475e81c7a552aa581c3a93999a3d';
    const clientSecret = Deno.env.get('SHOPIFY_CLIENT_SECRET') ?? '';

    if (!clientSecret) {
      return json({ connected: false, error: 'SHOPIFY_CLIENT_SECRET tanımlı değil.' });
    }

    const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    const tokenData = await tokenResponse.json().catch(() => null);

    if (!tokenResponse.ok || !tokenData || !tokenData.access_token) {
      const msg = tokenData?.error_description || tokenData?.error || 'Shopify token alışverişi başarısız oldu.';
      return json({ connected: false, error: `Shopify: ${msg}` });
    }

    const { error: dbError } = await supabaseAdmin
      .from('platform_tokens')
      .upsert({
        user_id: userId,
        platform: 'shopify',
        access_token: tokenData.access_token,
        shop_domain: shop,
      }, { onConflict: 'user_id,platform' });

    if (dbError) {
      return json({ connected: false, error: `Veritabanı hatası: ${dbError.message}` });
    }

    return json({ connected: true });
  } catch (err) {
    return json({ error: (err && (err as Error).message) || 'Sunucu hatası' }, 500);
  }
});