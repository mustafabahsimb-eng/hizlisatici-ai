const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  try {
    const { apiKey, apiSecret } = await req.json();
    if (!apiKey || !apiSecret) {
      return new Response(JSON.stringify({ error: 'API Key ve API Secret gerekli.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const url = 'https://api.n11.com/ms/product-query?page=0&size=1';

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'appKey': apiKey,
        'appSecret': apiSecret,
      },
    });

    if (response.status === 401 || response.status === 403) {
      return new Response(JSON.stringify({
        connected: false,
        error: 'API Key veya API Secret hatalı. N11 mağaza panelinden (Bilgilerim > API Hesapları) kontrol et.'
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const bodyText = await response.text().catch(() => '');

    if (!response.ok) {
      return new Response(JSON.stringify({
        connected: false,
        error: `N11'den beklenmeyen yanıt (${response.status}): ${bodyText.slice(0, 200)}`
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const lowerBody = bodyText.toLowerCase();
    const looksLikeFailure =
      lowerBody.includes('"status":"failure"') ||
      lowerBody.includes('"success":false') ||
      lowerBody.includes('unauthorized') ||
      lowerBody.includes('invalid') ||
      lowerBody.includes('yetkisiz') ||
      lowerBody.includes('geçersiz');

    if (looksLikeFailure) {
      return new Response(JSON.stringify({
        connected: false,
        error: 'API Key veya API Secret hatalı görünüyor. N11 mağaza panelinden (Bilgilerim > API Hesapları) kontrol et.'
      }), {
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