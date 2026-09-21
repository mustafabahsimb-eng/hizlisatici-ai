const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  try {
    const { sellerId, apiKey } = await req.json();
    if (!sellerId || !apiKey) {
      return new Response(JSON.stringify({ error: 'Satıcı ID ve API Key gerekli.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const url = 'https://apis.ciceksepeti.com/api/v1/Order/GetOrders';

    const response = await fetch(url, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'user-agent': `${sellerId}`,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
      },
      body: JSON.stringify({
        startDate: '2020-01-01',
        endDate: '2030-01-01',
        pageSize: 1,
        page: 0,
      }),
    });

    if (response.status === 401 || response.status === 403) {
      return new Response(JSON.stringify({
        connected: false,
        error: 'API Key hatalı. Çiçeksepeti satıcı panelinden (Hesap Yönetimi > Entegrasyon Bilgilerim) kontrol et.'
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (response.status === 429) {
      return new Response(JSON.stringify({
        connected: false,
        error: 'Çok hızlı denedin, Çiçeksepeti bu isteği geçici olarak sınırladı. 1 dakika bekleyip tekrar dene.'
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      return new Response(JSON.stringify({
        connected: false,
        error: `Çiçeksepeti'den beklenmeyen yanıt (${response.status}): ${bodyText.slice(0, 200)}`
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