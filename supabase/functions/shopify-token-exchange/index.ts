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
    const { shop, code, userId } = await req.json();

    if (!shop || !code || !userId) {
      return new Response(JSON.stringify({ error: 'shop, code ve userId gerekli.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const clientId = 'b2e6475e81c7a552aa581c3a93999a3d';
    const clientSecret = Deno.env.get('SHOPIFY_CLIENT_SECRET') ?? '';

    if (!clientSecret) {
      return new Response(JSON.stringify({ connected: false, error: 'SHOPIFY_CLIENT_SECRET tanımlı değil.' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
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
      return new Response(JSON.stringify({ connected: false, error: `Shopify: ${msg}` }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { error: dbError } = await supabaseAdmin
      .from('platform_tokens')
      .upsert({
        user_id: userId,
        platform: 'shopify',
        access_token: tokenData.access_token,
        shop_domain: shop,
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