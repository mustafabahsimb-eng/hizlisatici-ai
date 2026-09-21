import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { code, userId } = await req.json();

    if (!code || !userId) {
      return new Response(JSON.stringify({ error: 'code ve userId gerekli.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const clientId = '1650835089949068';
    const clientSecret = Deno.env.get('FACEBOOK_CLIENT_SECRET') ?? '';
    const redirectUri = 'https://mustafabahsimb-eng.github.io/hizlisatici-ai/facebook-callback.html';

    if (!clientSecret) {
      return new Response(JSON.stringify({ connected: false, error: 'FACEBOOK_CLIENT_SECRET tanımlı değil.' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const tokenUrl = `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${clientSecret}&code=${code}`;

    const tokenResponse = await fetch(tokenUrl);
    const tokenData = await tokenResponse.json().catch(() => null);

    if (!tokenResponse.ok || !tokenData || !tokenData.access_token) {
      const msg = tokenData?.error?.message || 'Facebook token alışverişi başarısız oldu.';
      return new Response(JSON.stringify({ connected: false, error: `Facebook: ${msg}` }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const shortLivedToken = tokenData.access_token;

    const longLivedUrl = `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${clientId}&client_secret=${clientSecret}&fb_exchange_token=${shortLivedToken}`;

    const longLivedResponse = await fetch(longLivedUrl);
    const longLivedData = await longLivedResponse.json().catch(() => null);

    const finalToken = (longLivedResponse.ok && longLivedData?.access_token) ? longLivedData.access_token : shortLivedToken;

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { error: dbError } = await supabaseAdmin
      .from('platform_tokens')
      .upsert({
        user_id: userId,
        platform: 'facebook',
        access_token: finalToken,
      }, { onConflict: 'user_id,platform' });

    if (dbError) {
      return new Response(JSON.stringify({ connected: false, error: `Veritabanı hatası: ${dbError.message}` }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ connected: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});