import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
const PEXELS_API_KEY = Deno.env.get('PEXELS_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function extractJson(text: string) {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
  cleaned = cleaned.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  try {
    return JSON.parse(cleaned);
  } catch (_e) {
    const startObj = cleaned.indexOf('{');
    const startArr = cleaned.indexOf('[');
    let s = startObj;
    let openChar = '{', closeChar = '}';
    if (startArr !== -1 && (startObj === -1 || startArr < startObj)) {
      s = startArr; openChar = '['; closeChar = ']';
    }
    if (s === -1) throw new Error('JSON bulunamadı');
    let depth = 0;
    for (let i = s; i < cleaned.length; i++) {
      if (cleaned[i] === openChar) depth++;
      else if (cleaned[i] === closeChar) {
        depth--;
        if (depth === 0) return JSON.parse(cleaned.slice(s, i + 1));
      }
    }
    throw new Error('JSON parse edilemedi');
  }
}

function slugify(text: string) {
  const trMap: Record<string, string> = { 'ç':'c','ğ':'g','ı':'i','ö':'o','ş':'s','ü':'u','Ç':'c','Ğ':'g','İ':'i','Ö':'o','Ş':'s','Ü':'u' };
  return text.split('').map(ch => trMap[ch] || ch).join('')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40) || 'magazam';
}

async function searchPexelsImage(query: string) {
  if (!PEXELS_API_KEY) return null;
  try {
    const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1`, {
      headers: { Authorization: PEXELS_API_KEY }
    });
    const data = await res.json();
    return data?.photos?.[0]?.src?.medium || null;
  } catch (_e) {
    return null;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json();
    const { mode, userAccessToken } = body;

    if (!userAccessToken) {
      return new Response(JSON.stringify({ error: 'Yetkilendirme gerekli' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { data: userData, error: userError } = await supabase.auth.getUser(userAccessToken);
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Kullanıcı doğrulanamadı' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const userId = userData.user.id;

    // ============ ADIM 1: ÜRÜN ÖNERİSİ ============
    if (mode === 'suggest') {
      const { hobby, budget } = body;
      if (!hobby) {
        return new Response(JSON.stringify({ error: 'Hobi/ilgi alanı gerekli' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const prompt = `Kullanıcının hobisi/ilgi alanı: "${hobby}". ${budget ? `Bütçesi: ${budget} TL.` : ''}
Bu hobiye uygun, Türkiye'de dropshipping ile satılabilecek 8 adet ürün öner. En fazla 2 web araması yap.
Her ürün için: name (Türkçe ürün adı), description (2-3 cümle satış odaklı açıklama), category, estimated_cost (tedarikçi maliyeti, TL, sayı), estimated_sale_price (önerilen satış fiyatı, TL, sayı), image_search_query (İngilizce, Pexels'te arama için kısa terim) alanlarını doldur.
Ayrıca store_name alanına bu hobiye özel, gerçek ve akılda kalıcı bir mağaza ismi öner (örn. "Balık Tutkusu", "Örgü Dünyası" gibi - açıklama cümlesi değil, gerçek bir isim).

SADECE şu JSON formatında cevap ver, başka hiçbir açıklama ekleme:
{
  "store_name": "...",
  "products": [
    { "name": "...", "description": "...", "category": "...", "estimated_cost": 0, "estimated_sale_price": 0, "image_search_query": "..." }
  ]
}`;

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 4096,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      const claudeData = await claudeRes.json();
      const textBlocks = (claudeData.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
      const parsed = extractJson(textBlocks);

      const productsWithImages = await Promise.all(
        (parsed.products || []).map(async (p: any) => {
          const image = await searchPexelsImage(p.image_search_query || p.name);
          return { ...p, image_url: image };
        })
      );

      return new Response(JSON.stringify({
        store_name: parsed.store_name,
        store_slug: slugify(parsed.store_name || hobby),
        products: productsWithImages,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ============ ADIM 2: MAĞAZAYI OLUŞTUR ============
    if (mode === 'create') {
      const { hobby, budget, store_name, store_slug, products } = body;
      if (!store_name || !store_slug || !Array.isArray(products) || products.length === 0) {
        return new Response(JSON.stringify({ error: 'Eksik bilgi' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      let finalSlug = store_slug;
      const { data: existing } = await supabase.from('store_settings').select('id').eq('store_slug', finalSlug).maybeSingle();
      if (existing) {
        finalSlug = `${store_slug}-${Math.floor(1000 + Math.random() * 9000)}`;
      }

      const { error: storeError } = await supabase.from('store_settings').upsert({
        user_id: userId,
        store_slug: finalSlug,
        store_name,
        hobby,
        budget: budget || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });

      if (storeError) {
        return new Response(JSON.stringify({ error: 'Mağaza oluşturulamadı: ' + storeError.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const rows = products.map((p: any) => ({
        user_id: userId,
        name: p.name,
        generated_title: p.name,
        generated_description: p.category ? `[${p.category}] ${p.description || ''}` : (p.description || ''),
        supplier_price: p.estimated_cost || null,
        sale_price: p.estimated_sale_price || null,
        image_url: p.image_url || null,
        platform: 'Diğer',
        store_visible: true,
      }));

      const { data: inserted, error: insertError } = await supabase.from('products').insert(rows).select('id');

      if (insertError) {
        return new Response(JSON.stringify({ error: 'Ürünler eklenemedi: ' + insertError.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({
        success: true,
        store_slug: finalSlug,
        product_count: inserted?.length || 0,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Geçersiz mode' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Beklenmeyen hata' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});