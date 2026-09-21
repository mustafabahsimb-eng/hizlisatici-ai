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

async function pf(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`https://api.printify.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      "User-Agent": "HizliSaticiAI",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 || res.status === 403) throw new Error("TOKEN");
  if (res.status === 429) throw new Error("RATE");
  const text = await res.text();
  if (!res.ok) throw new Error(`Printify hatası (${res.status}): ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

// Printify ürününü arayüzün ihtiyacı olan alanlara sadeleştirir (fiyat/maliyet: cent cinsinden)
function summarize(p: any) {
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    blueprint_id: p.blueprint_id,
    print_provider_id: p.print_provider_id,
    variants: (p.variants || []).map((v: any) => ({
      id: v.id,
      title: v.title,
      cost: v.cost,
      price: v.price,
      is_enabled: v.is_enabled,
      is_available: v.is_available,
    })),
    images: (p.images || []).slice(0, 16).map((i: any) => ({
      src: i.src,
      position: i.position,
      variant_ids: i.variant_ids,
      is_default: i.is_default,
    })),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const { userAccessToken, action } = body;
    if (!userAccessToken || !action) return json({ ok: false, error: "Eksik bilgi" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: { user }, error: authError } = await supabase.auth.getUser(userAccessToken);
    if (authError || !user) return json({ ok: false, error: "Oturum doğrulanamadı" }, 401);

    const { data: conn } = await supabase
      .from("printify_connections")
      .select("api_token, shop_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!conn) return json({ ok: false, error: "Önce Printify hesabını bağlamalısın" }, 400);
    const token = conn.api_token;

    // 1) Tasarım görselini Printify'a yükle (imageUrl veya imageBase64)
    if (action === "upload_image") {
      const { fileName, imageUrl, imageBase64 } = body;
      if (!fileName || (!imageUrl && !imageBase64)) {
        return json({ ok: false, error: "Dosya adı veya görsel eksik" }, 400);
      }
      const payload: Record<string, string> = { file_name: fileName };
      if (imageUrl) payload.url = imageUrl;
      else payload.contents = String(imageBase64).replace(/^data:[^;]+;base64,/, "");
      const img = await pf("POST", "/v1/uploads/images.json", token, payload);
      return json({
        ok: true,
        image: {
          id: img.id,
          file_name: img.file_name,
          width: img.width,
          height: img.height,
          preview_url: img.preview_url,
        },
      });
    }

    // Aşağıdaki işlemler için bir Printify mağazası seçilmiş olmalı
    if (!conn.shop_id) {
      return json({ ok: false, error: "Önce bir Printify mağazası seçmelisin" }, 400);
    }
    const shopId = conn.shop_id;

    // 2) Taslak ürün oluştur (yayınlanmaz)
    if (action === "create_draft") {
      const { title, description, blueprintId, providerId, variantIds, placements, price } = body;
      if (!title || !blueprintId || !providerId) {
        return json({ ok: false, error: "Başlık, ürün türü veya sağlayıcı eksik" }, 400);
      }
      if (!Array.isArray(variantIds) || variantIds.length === 0) {
        return json({ ok: false, error: "En az bir renk/beden seçmelisin" }, 400);
      }
      if (!Array.isArray(placements) || placements.length === 0) {
        return json({ ok: false, error: "En az bir baskı alanına tasarım eklemelisin" }, 400);
      }
      const startPrice = Number(price) > 0 ? Math.round(Number(price)) : 2999;

      const productBody = {
        title,
        description: description || title,
        blueprint_id: Number(blueprintId),
        print_provider_id: Number(providerId),
        variants: variantIds.map((id: number) => ({ id: Number(id), price: startPrice, is_enabled: true })),
        print_areas: [
          {
            variant_ids: variantIds.map((id: number) => Number(id)),
            placeholders: placements.map((p: any) => ({
              position: p.position,
              images: [
                {
                  id: p.imageId,
                  x: p.x ?? 0.5,
                  y: p.y ?? 0.5,
                  scale: p.scale ?? 1,
                  angle: p.angle ?? 0,
                },
              ],
            })),
          },
        ],
      };
      const created = await pf("POST", `/v1/shops/${shopId}/products.json`, token, productBody);
      return json({ ok: true, product: summarize(created) });
    }

    // 3) Ürünü getir (gerçek maliyet ve mockup görselleri)
    if (action === "get_product") {
      if (!body.productId) return json({ ok: false, error: "Ürün seçilmedi" }, 400);
      const p = await pf("GET", `/v1/shops/${shopId}/products/${body.productId}.json`, token);
      return json({ ok: true, product: summarize(p) });
    }

    // 4) Fiyat (ve istenirse başlık/açıklama) güncelle
    if (action === "update_product") {
      const { productId, prices, defaultPrice, title, description, enabledVariantIds } = body;
      if (!productId) return json({ ok: false, error: "Ürün seçilmedi" }, 400);
      const current = await pf("GET", `/v1/shops/${shopId}/products/${productId}.json`, token);
      const variants = (current.variants || []).map((v: any) => {
        const custom = prices && prices[v.id] != null ? Number(prices[v.id]) : null;
        const fallback = defaultPrice != null ? Number(defaultPrice) : v.price;
        const enabled = Array.isArray(enabledVariantIds)
          ? enabledVariantIds.map(Number).includes(v.id)
          : v.is_enabled;
        return { id: v.id, price: Math.round(custom ?? fallback), is_enabled: enabled };
      });
      const update: Record<string, unknown> = { variants };
      if (title) update.title = title;
      if (description) update.description = description;
      const updated = await pf("PUT", `/v1/shops/${shopId}/products/${productId}.json`, token, update);
      return json({ ok: true, product: summarize(updated) });
    }

    // 5) Mağazadaki ürünleri listele
    if (action === "list_products") {
      const data = await pf("GET", `/v1/shops/${shopId}/products.json?limit=50`, token);
      const items = Array.isArray(data.data) ? data.data : [];
      return json({
        ok: true,
        products: items.map((p: any) => ({
          id: p.id,
          title: p.title,
          blueprint_id: p.blueprint_id,
          print_provider_id: p.print_provider_id,
          image: p.images && p.images.length ? p.images[0].src : null,
        })),
      });
    }

    // 6) Ürünü sil
    if (action === "delete_product") {
      if (!body.productId) return json({ ok: false, error: "Ürün seçilmedi" }, 400);
      await pf("DELETE", `/v1/shops/${shopId}/products/${body.productId}.json`, token);
      return json({ ok: true });
    }

    return json({ ok: false, error: "Bilinmeyen işlem" }, 400);
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    if (msg === "TOKEN") return json({ ok: false, error: "Printify token'ın geçersiz veya süresi dolmuş, yeniden bağla" });
    if (msg === "RATE") return json({ ok: false, error: "Printify istek limiti doldu, bir dakika sonra tekrar dene" });
    return json({ ok: false, error: msg }, 500);
  }
});