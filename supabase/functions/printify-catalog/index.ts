import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Türkçe arama kelimelerini Printify'ın İngilizce katalog terimlerine çevirir
const TR_TERMS: Record<string, string> = {
  "tişört": "t-shirt", "tisort": "t-shirt", "tshirt": "t-shirt", "t-shirt": "t-shirt",
  "kupa": "mug", "bardak": "mug", "fincan": "mug",
  "hoodie": "hoodie", "kapüşonlu": "hoodie", "kapusonlu": "hoodie",
  "sweatshirt": "sweatshirt", "sweat": "sweatshirt",
  "poster": "poster", "tablo": "canvas", "kanvas": "canvas",
  "çanta": "tote", "canta": "tote", "sırt çantası": "backpack",
  "telefon": "phone", "kılıf": "case", "kilif": "case",
  "şapka": "hat", "kep": "cap",
  "yastık": "pillow", "yastik": "pillow",
  "sticker": "sticker", "etiket": "sticker", "çıkartma": "sticker",
  "defter": "notebook", "not defteri": "notebook",
  "mousepad": "mouse pad", "takvim": "calendar",
  "atlet": "tank", "çocuk": "kids", "bebek": "baby", "kadın": "women", "erkek": "men",
  "battaniye": "blanket", "havlu": "towel", "çorap": "socks", "önlük": "apron",
  "şişe": "bottle", "yapboz": "puzzle", "puzzle": "puzzle", "magnet": "magnet",
  "kolye": "necklace", "bayrak": "flag", "perde": "curtain", "paspas": "mat",
};

function translateQuery(q: string): string[] {
  const lower = q.toLocaleLowerCase("tr").trim();
  if (!lower) return [];
  if (TR_TERMS[lower]) return [TR_TERMS[lower]];
  return lower
    .split(/\s+/)
    .map((w) => TR_TERMS[w] || w)
    .flatMap((w) => w.split(/\s+/));
}

// Blueprint listesi büyük olduğu için bellekte 30 dk önbellekte tutulur (katalog limiti dakikada 100 istek)
let blueprintsCache: { at: number; data: any[] } | null = null;
const CACHE_MS = 30 * 60 * 1000;

async function pf(path: string, token: string) {
  const res = await fetch(`https://api.printify.com${path}`, {
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      "User-Agent": "HizliSaticiAI",
    },
  });
  if (res.status === 401 || res.status === 403) throw new Error("TOKEN");
  if (res.status === 429) throw new Error("RATE");
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Printify hatası (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { userAccessToken, action, query, blueprintId, providerId } = await req.json();
    if (!userAccessToken || !action) return json({ ok: false, error: "Eksik bilgi" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: { user }, error: authError } = await supabase.auth.getUser(userAccessToken);
    if (authError || !user) return json({ ok: false, error: "Oturum doğrulanamadı" }, 401);

    const { data: conn } = await supabase
      .from("printify_connections")
      .select("api_token")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!conn) return json({ ok: false, error: "Önce Printify hesabını bağlamalısın" }, 400);
    const token = conn.api_token;

    // 1) Ürün türü ara
    if (action === "search") {
      if (!blueprintsCache || Date.now() - blueprintsCache.at > CACHE_MS) {
        const data = await pf("/v1/catalog/blueprints.json", token);
        blueprintsCache = { at: Date.now(), data: Array.isArray(data) ? data : [] };
      }
      const terms = translateQuery(query || "");
      let list = blueprintsCache.data;
      if (terms.length) {
        list = list.filter((b: any) => {
          const hay = `${b.title} ${b.brand} ${b.model}`.toLowerCase();
          return terms.every((t) => hay.includes(t));
        });
      }
      return json({
        ok: true,
        total: list.length,
        blueprints: list.slice(0, 30).map((b: any) => ({
          id: b.id,
          title: b.title,
          brand: b.brand,
          image: Array.isArray(b.images) && b.images.length ? b.images[0] : null,
        })),
      });
    }

    // 2) Bir ürün türünün baskı sağlayıcıları
    if (action === "providers") {
      if (!blueprintId) return json({ ok: false, error: "Ürün türü seçilmedi" }, 400);
      const data = await pf(`/v1/catalog/blueprints/${blueprintId}/print_providers.json`, token);
      return json({
        ok: true,
        providers: (Array.isArray(data) ? data : []).map((p: any) => ({
          id: p.id,
          title: p.title,
          decoration_methods: p.decoration_methods || [],
        })),
      });
    }

    // 3) Sağlayıcının varyantları (renk/beden), baskı alanları ve kargo bilgisi
    if (action === "variants") {
      if (!blueprintId || !providerId) {
        return json({ ok: false, error: "Ürün türü veya sağlayıcı seçilmedi" }, 400);
      }
      const base = `/v1/catalog/blueprints/${blueprintId}/print_providers/${providerId}`;
      const [variantsData, shippingData] = await Promise.all([
        pf(`${base}/variants.json?show_out_of_stock=0`, token),
        pf(`${base}/shipping.json`, token).catch(() => null),
      ]);

      const variants = (variantsData.variants || []).map((v: any) => ({
        id: v.id,
        title: v.title,
        options: v.options || {},
      }));
      const first = (variantsData.variants || [])[0];
      const placeholders = first && Array.isArray(first.placeholders)
        ? first.placeholders.map((p: any) => ({
            position: p.position,
            width: p.width,
            height: p.height,
            decoration_method: p.decoration_method || null,
          }))
        : [];

      const shipping = shippingData
        ? {
            handling_time: shippingData.handling_time || null,
            profiles: (shippingData.profiles || []).map((p: any) => ({
              countries: p.countries || [],
              variant_count: Array.isArray(p.variant_ids) ? p.variant_ids.length : 0,
              first_item: p.first_item || null,
              additional_items: p.additional_items || null,
            })),
          }
        : null;

      return json({
        ok: true,
        provider: { id: variantsData.id, title: variantsData.title },
        variants,
        placeholders,
        shipping,
      });
    }

    return json({ ok: false, error: "Bilinmeyen işlem" }, 400);
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    if (msg === "TOKEN") return json({ ok: false, error: "Printify token'ın geçersiz veya süresi dolmuş, yeniden bağla" });
    if (msg === "RATE") return json({ ok: false, error: "Printify istek limiti doldu, bir dakika sonra tekrar dene" });
    return json({ ok: false, error: msg }, 500);
  }
});