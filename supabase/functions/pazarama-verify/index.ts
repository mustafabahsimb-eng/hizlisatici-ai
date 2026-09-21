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

    const authHeader = 'Basic ' + btoa(`${apiKey}:${apiSecret}`);
    const url = 'https://isortagimgiris.pazarama.com/connect/token';

    const response = await fetch(url, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'merchantgatewayapi.fullaccess',
      }).toString(),
    });

    if (response.status === 400 || response.status === 401) {
      return new Response(JSON.stringify({
        connected: false,
        error: 'API Key veya API Secret hatalı. Pazarama satıcı panelinden (Hesap Bilgileri > Entegrasyon Bilgileri) kontrol et.'
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      return new Response(JSON.stringify({
        connected: false,
        error: `Pazarama'dan beklenmeyen yanıt (${response.status}): ${bodyText.slice(0, 200)}`
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const data = await response.json().catch(() => null);
    if (!data || !data.access_token) {
      return new Response(JSON.stringify({
        connected: false,
        error: 'Pazarama beklenmeyen bir yanıt verdi, access token alınamadı.'
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