const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function escapeXml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

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

    const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
  <s:Header>
    <o:Security xmlns:o="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" s:mustUnderstand="1">
      <o:UsernameToken>
        <o:Username>${escapeXml(apiKey)}</o:Username>
        <o:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-username-token-profile-1.0#PasswordText">${escapeXml(apiSecret)}</o:Password>
      </o:UsernameToken>
    </o:Security>
  </s:Header>
  <s:Body>
    <tem:KullaniciTedarikciBilgisiGetir/>
  </s:Body>
</s:Envelope>`;

    const response = await fetch('https://ws.pttavm.com:93/service.svc', {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'http://tempuri.org/IService/KullaniciTedarikciBilgisiGetir',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
      },
      body: soapBody,
    });

    const text = await response.text();

    // Kimlik doğrulama hatası genelde SOAP Fault olarak döner (HTTP durumu 400/500 olabilir)
    if (/<[^>]*Fault>/i.test(text) || response.status >= 400) {
      let faultMsg = 'Kullanıcı Adı veya Şifre hatalı.';
      const m = text.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i);
      if (m && m[1]) faultMsg = m[1].trim();
      return new Response(JSON.stringify({
        connected: false,
        error: `PTT AVM: ${faultMsg}. PTT AVM satıcı panelinden (Entegrasyon Ayarları) kullanıcı adı/şifreni kontrol et.`
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (!text.includes('KullaniciTedarikciBilgisiGetirResponse')) {
      return new Response(JSON.stringify({
        connected: false,
        error: `PTT AVM'den beklenmeyen yanıt alındı: ${text.slice(0, 300)}`
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ connected: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});