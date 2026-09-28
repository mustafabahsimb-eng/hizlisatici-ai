import { createClient } from 'npm:@supabase/supabase-js@2';

const CURRENCIES = ['TRY', 'USD', 'GBP', 'PLN', 'CAD', 'DKK'];
const SOURCE_NAME = 'ecb-frankfurter';
const SOURCES = [
  'https://api.frankfurter.dev/v1/latest?base=EUR&symbols=',
  'https://api.frankfurter.app/latest?from=EUR&to=',
];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function round8(v: number) {
  return Math.round(v * 1e8) / 1e8;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Son 1 saat içinde çekildiyse tekrar çekme
    const { data: last } = await supabase
      .from('exchange_rates')
      .select('fetched_at, rate_date')
      .eq('source', SOURCE_NAME)
      .order('fetched_at', { ascending: false })
      .limit(1);

    if (last && last.length > 0) {
      const ageMs = Date.now() - new Date(last[0].fetched_at).getTime();
      if (ageMs < 60 * 60 * 1000) {
        return json({
          ok: true,
          skipped: true,
          reason: 'Son 1 saat içinde zaten çekildi',
          rate_date: last[0].rate_date,
        });
      }
    }

    // Kurları çek (ana kaynak, olmazsa yedek)
    let data: { date: string; rates: Record<string, number> } | null = null;
    let lastError = '';
    for (const base of SOURCES) {
      try {
        const res = await fetch(base + CURRENCIES.join(','));
        if (!res.ok) {
          lastError = 'HTTP ' + res.status;
          continue;
        }
        const body = await res.json();
        if (body && body.rates && body.date) {
          data = body;
          break;
        }
        lastError = 'Beklenmeyen cevap';
      } catch (e) {
        lastError = String(e);
      }
    }
    if (!data) {
      throw new Error('Kur kaynağına ulaşılamadı: ' + lastError);
    }

    const rateDate = data.date;
    const eur = data.rates;
    const usdPerEur = Number(eur.USD);
    if (!usdPerEur || usdPerEur <= 0) {
      throw new Error('USD kuru alınamadı');
    }

    const fetchedAt = new Date().toISOString();
    const rows: Record<string, unknown>[] = [];

    // Euro bazlı: EUR -> X
    for (const c of CURRENCIES) {
      const v = Number(eur[c]);
      if (!v || v <= 0) continue;
      rows.push({
        base_currency: 'EUR',
        quote_currency: c,
        rate: round8(v),
        rate_date: rateDate,
        source: SOURCE_NAME,
        fetched_at: fetchedAt,
      });
    }

    // Dolar bazlı: USD -> X (çapraz kur hesapları için)
    for (const c of [...CURRENCIES, 'EUR']) {
      if (c === 'USD') continue;
      const perEur = c === 'EUR' ? 1 : Number(eur[c]);
      if (!perEur || perEur <= 0) continue;
      rows.push({
        base_currency: 'USD',
        quote_currency: c,
        rate: round8(perEur / usdPerEur),
        rate_date: rateDate,
        source: SOURCE_NAME,
        fetched_at: fetchedAt,
      });
    }

    const { error } = await supabase
      .from('exchange_rates')
      .upsert(rows, { onConflict: 'base_currency,quote_currency,rate_date' });
    if (error) throw error;

    return json({
      ok: true,
      rate_date: rateDate,
      count: rows.length,
      ornek: {
        EUR_TRY: round8(Number(eur.TRY)),
        USD_TRY: round8(Number(eur.TRY) / usdPerEur),
        EUR_PLN: round8(Number(eur.PLN)),
      },
    });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});