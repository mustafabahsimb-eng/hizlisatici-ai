const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function extractJson(text: string) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('JSON bulunamadı: ' + text);
  return JSON.parse(match[0]);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  try {
    const { productName, productDescription, salePrice, currency, storeName, question } = await req.json();
    if (!question || !question.trim()) {
      return new Response(JSON.stringify({ error: 'Soru boş olamaz.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const systemPrompt = `Sen "${storeName || 'bu mağaza'}" adlı bir e-ticaret mağazasının müşteri hizmetleri asistanısın. Müşterilere SADECE sana verilen ürün bilgisine dayanarak, samimi ve yardımsever bir Türkçe ile cevap ver.

Ürün bilgisi:
- Ad: ${productName || 'bilinmiyor'}
- Açıklama: ${productDescription || 'yok'}
- Fiyat: ${salePrice ? currency + salePrice : 'belirtilmemiş'}

Kurallar:
- Sadece yukarıdaki bilgiye dayan, uydurma bilgi verme (özellikle kesin teslimat tarihi, iade süresi, garanti şartı gibi verilmeyen detayları asla uydurma).
- Elindeki bilgiyle cevaplayamayacağın bir soru gelirse (örn. spesifik iade politikası, kargo firması, stok durumu net değilse), dürüstçe "bu konuda net bilgim yok, satıcıyla doğrudan iletişime geçmeni öneririm" de.
- Cevabın 2-3 cümleyi geçmesin, doğal ve sıcak bir ton kullan.
- SADECE aşağıdaki JSON formatında cevap ver, başka hiçbir şey yazma: {"answer": "..."}
`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': Deno.env.get('ANTHROPIC_API_KEY') ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: question }],
      }),
    });

    const data = await response.json();
    if (data.error) {
      return new Response(JSON.stringify({ error: data.error.message || 'AI hatası' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const text = data.content?.[0]?.text || '';
    const parsed = extractJson(text);

    return new Response(JSON.stringify({ answer: parsed.answer }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});