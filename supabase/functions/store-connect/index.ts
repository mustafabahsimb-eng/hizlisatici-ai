import { createClient } from 'npm:@supabase/supabase-js@2';

// Pazaryeri kodu -> doğrulama fonksiyonu (sadece sunucu karar verir)
const VERIFY_FUNCTIONS: Record<string, string | null> = {
  trendyol_tr: 'trendyol-verify',
  hepsiburada_tr: 'hepsiburada-verify',
  n11_tr: 'n11-verify',
  ciceksepeti_tr: 'ciceksepeti-verify',
  pttavm_tr: 'rpttavm-verify',
  pazarama_tr: 'pazarama-verify',
  walmart_us: 'walmart-verify',
  woocommerce: 'woocommerce-verify',
  amazon_tr: null, // doğrulama henüz yok, "bekliyor" olarak kaydedilir
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');

    // 1) Kullanıcıyı doğrula
    if (!body.userAccessToken) {
      return json({ ok: false, error: 'not_authenticated' }, 401);
    }
    const { data: userData, error: userError } = await admin.auth.getUser(body.userAccessToken);
    if (userError || !userData?.user) {
      return json({ ok: false, error: 'not_authenticated' }, 401);
    }
    const userId = userData.user.id;

    // ============================================================
    // BAĞLA
    // ============================================================
    if (action === 'connect') {
      const marketplaceCode = String(body.marketplaceCode || '');
      const environment = body.environment === 'sandbox' ? 'sandbox' : 'live';
      const sellerId = String(body.sellerId || '').trim();
      const apiKey = String(body.apiKey || '').trim();
      const apiSecret = String(body.apiSecret || '').trim();
      const label = String(body.label || '').trim() || null;

      if (!(marketplaceCode in VERIFY_FUNCTIONS)) {
        return json({ ok: false, error: 'unsupported_marketplace' }, 400);
      }
      if (!sellerId || !apiKey || !apiSecret) {
        return json({ ok: false, error: 'missing_fields' }, 400);
      }

      // 2) Canlı ortamda pazaryerinin gerçek API'si ile doğrula
      const verifyFn = VERIFY_FUNCTIONS[marketplaceCode];
      let verified = false;
      if (environment === 'live' && verifyFn) {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/${verifyFn}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Doğrulama fonksiyonları sadece giriş yapmış kullanıcıyı kabul eder
            'Authorization': 'Bearer ' + body.userAccessToken,
            'apikey': ANON_KEY,
          },
          body: JSON.stringify({ sellerId, apiKey, apiSecret }),
        });
        const result = await res.json().catch(() => ({}));
        if (result.connected !== true) {
          return json({ ok: false, error: 'verify_failed', detail: result.error || null });
        }
        verified = true;
      }

      // 3) Pazaryeri adı (etiket boşsa)
      const { data: mk } = await admin
        .from('marketplaces')
        .select('name')
        .eq('code', marketplaceCode)
        .maybeSingle();

      // 4) Aynı bağlantı varsa güncelle, yoksa yeni aç
      const { data: existing } = await admin
        .from('store_connections')
        .select('id')
        .eq('user_id', userId)
        .eq('marketplace_code', marketplaceCode)
        .eq('environment', environment)
        .eq('external_seller_id', sellerId)
        .is('deleted_at', null)
        .maybeSingle();

      const fields = {
        label: label || mk?.name || marketplaceCode,
        status: verified ? 'connected' : 'pending',
        last_verified_at: verified ? new Date().toISOString() : null,
        last_error: null,
      };

      let connectionId: string;
      if (existing) {
        const { error } = await admin.from('store_connections').update(fields).eq('id', existing.id);
        if (error) throw error;
        connectionId = existing.id;
      } else {
        const { data: created, error } = await admin
          .from('store_connections')
          .insert({
            user_id: userId,
            marketplace_code: marketplaceCode,
            environment,
            external_seller_id: sellerId,
            ...fields,
          })
          .select('id')
          .single();
        if (error) throw error;
        connectionId = created.id;
      }

      // 5) Anahtarları şifreli kasaya koy
      const { error: vaultError } = await admin.rpc('store_connection_set_credentials', {
        p_connection_id: connectionId,
        p_credentials: { sellerId, apiKey, apiSecret },
      });
      if (vaultError) throw vaultError;

      return json({ ok: true, connectionId, status: fields.status, verified });
    }

    // ============================================================
    // KALDIR
    // ============================================================
    if (action === 'disconnect') {
      const connectionId = String(body.connectionId || '');
      if (!connectionId) {
        return json({ ok: false, error: 'missing_fields' }, 400);
      }
      // Sadece kendi bağlantısını silebilir; kasadaki anahtar tetikleyiciyle silinir
      const { error, count } = await admin
        .from('store_connections')
        .delete({ count: 'exact' })
        .eq('id', connectionId)
        .eq('user_id', userId);
      if (error) throw error;
      if (!count) return json({ ok: false, error: 'not_found' }, 404);
      return json({ ok: true });
    }

    return json({ ok: false, error: 'unknown_action' }, 400);
  } catch (e) {
    return json({ ok: false, error: 'server_error', detail: (e as Error).message }, 500);
  }
});