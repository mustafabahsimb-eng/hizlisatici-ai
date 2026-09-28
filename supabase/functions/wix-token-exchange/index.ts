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

    const { error: dbError } = await supabaseAdmin
      .from('platform_tokens')
      .upsert({
        user_id: userId,
        platform: 'wix',
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token || null,
      }, { onConflict: 'user_id,platform' });

    if (dbError) {
      return json({ connected: false, error: `Veritabanı hatası: ${dbError.message}` });
    }

    return json({ connected: true });
  } catch (err) {
    return json({ error: (err && (err as Error).message) || 'Sunucu hatası' }, 500);
  }
});