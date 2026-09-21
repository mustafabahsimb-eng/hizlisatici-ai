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
    const { code, codeVerifier, userId } = await req.json();
    if (!code || !codeVerifier || !userId) {
      return new Response(JSON.stringify({ error: 'code, codeVerifier ve userId gerekli.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
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
      return new Response(JSON.stringify({ connected: false, error: `Etsy: ${msg}` }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const expiresAt = new Date(Date.now() + (tokenData.expires_in ?? 3600) * 1000).toISOString();

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { error: dbError } = await supabaseAdmin
      .from('platform_tokens')
      .upsert({
        user_id: userId,
        platform: 'etsy',
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: expiresAt,
      }, { onConflict: 'user_id,platform' });

    if (dbError) {
      return new Response(JSON.stringify({ connected: false, error: `Veritabanı hatası: ${dbError.message}` }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ connected: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});