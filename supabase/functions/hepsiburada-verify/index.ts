const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  try {
    const { sellerId, apiKey, apiSecret } = await req.json();
    if (!sellerId || !apiKey || !apiSecret) {
      return new Response(JSON.stringify({ error: 'Mağaza ID, API Key ve API Secret gerekli.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const authHeader = 'Basic ' + btoa(`${apiKey}:${apiSecret}`);
    const cacheBuster = Date.now() + '-' + Math.random().toString(36).slice(2);
    const url = `https://oms-external.hepsiburada.com/packages/merchantid/${encodeURIComponent(sellerId)}?offset=0&limit=1&_ts=${cacheBuster}`;

    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        'Authorization': authHeader,
        'User-Agent': `${sellerId} - HizliSaticiAI`,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
      },
    });

    if (response.status === 401 || response.status === 403) {
      return new Response(JSON.stringify({
        connected: false,
        error: 'Mağaza ID, API Key veya API Secret hatalı. Hepsiburada Merchant panelinden (Hesabım > Entegrasyon Bilgileri > API Anahtarı) kontrol et.'
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      return new Response(JSON.stringify({
        connected: false,
        error: `Hepsiburada'dan beklenmeyen yanıt (${response.status}): ${bodyText.slice(0, 200)}`
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