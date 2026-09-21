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
      return new Response(JSON.stringify({ error: 'Mağaza adresi, Consumer Key ve Consumer Secret gerekli.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let storeUrl = sellerId.trim();
    if (!/^https?:\/\//i.test(storeUrl)) {
      storeUrl = 'https://' + storeUrl;
    }
    storeUrl = storeUrl.replace(/\/+$/, '');

    const cacheBuster = Date.now() + '-' + Math.random().toString(36).slice(2);
    const url = `${storeUrl}/wp-json/wc/v3/products?per_page=1&consumer_key=${encodeURIComponent(apiKey)}&consumer_secret=${encodeURIComponent(apiSecret)}&_ts=${cacheBuster}`;

    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
        },
      });
    } catch (fetchErr) {
      return new Response(JSON.stringify({
        connected: false,
        error: `Bu adrese ulaşılamadı: ${storeUrl}. Mağaza adresini kontrol et (örn: benimmagazam.com).`
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (response.status === 401 || response.status === 403) {
      return new Response(JSON.stringify({
        connected: false,
        error: 'Consumer Key veya Consumer Secret hatalı. WooCommerce panelinden (WooCommerce > Ayarlar > Gelişmiş > REST API) kontrol et.'
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (response.status === 404) {
      return new Response(JSON.stringify({
        connected: false,
        error: 'Bu adreste bir WooCommerce mağazası bulunamadı. Mağaza adresini kontrol et (örn: benimmagazam.com).'
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      return new Response(JSON.stringify({
        connected: false,
        error: `Mağazandan beklenmeyen yanıt (${response.status}): ${bodyText.slice(0, 200)}`
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ connected: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});