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

    const clientId = '1650835089949068';
    const clientSecret = Deno.env.get('FACEBOOK_CLIENT_SECRET') ?? '';
    const redirectUri = 'https://mustafabahsimb-eng.github.io/hizlisatici-ai/facebook-callback.html';

    if (!clientSecret) {
      return json({ connected: false, error: 'FACEBOOK_CLIENT_SECRET tanımlı değil.' });
    }

    const tokenUrl = `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${clientSecret}&code=${encodeURIComponent(code)}`;

    const tokenResponse = await fetch(tokenUrl);
    const tokenData = await tokenResponse.json().catch(() => null);

    if (!tokenResponse.ok || !tokenData || !tokenData.access_token) {
      const msg = tokenData?.error?.message || 'Facebook token alışverişi başarısız oldu.';
      return json({ connected: false, error: `Facebook: ${msg}` });
    }

    const shortLivedToken = tokenData.access_token;

    const longLivedUrl = `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${clientId}&client_secret=${clientSecret}&fb_exchange_token=${shortLivedToken}`;

    const longLivedResponse = await fetch(longLivedUrl);
    const longLivedData = await longLivedResponse.json().catch(() => null);

    const finalToken = (longLivedResponse.ok && longLivedData?.access_token) ? longLivedData.access_token : shortLivedToken;

    const { error: dbError } = await supabaseAdmin
      .from('platform_tokens')
      .upsert({
        user_id: userId,
        platform: 'facebook',
        access_token: finalToken,
      }, { onConflict: 'user_id,platform' });

    if (dbError) {
      return json({ connected: false, error: `Veritabanı hatası: ${dbError.message}` });
    }

    return json({ connected: true });
  } catch (err) {
    return json({ error: (err && (err as Error).message) || 'Sunucu hatası' }, 500);
  }
});