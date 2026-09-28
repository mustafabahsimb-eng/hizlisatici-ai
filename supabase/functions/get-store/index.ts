import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

// Vitrinde gösterilmeyecek ürünler: silinmiş, başka ürüne birleştirilmiş, stokta yok
function isSellable(p: any) {
  if (!p) return false;
  if (p.deleted_at) return false;
  if (p.merged_into) return false;
  if (p.stock_status === "out_of_stock") return false;
  return true;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const slug = url.searchParams.get("slug");
    if (!slug) return json({ error: "slug parametresi gerekli" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { data: store, error: storeErr } = await supabase
      .from("store_settings")
      .select("*")
      .eq("store_slug", slug)
      .maybeSingle();
    if (storeErr) throw storeErr;
    if (!store) return json({ error: "Mağaza bulunamadı" }, 404);

    let products: any[] = [];
    let source = "listings";

    try {
      // ===== YENİ YAPI: 1) Kendi Mağazam ilanları =====
      const { data: listings, error: listErr } = await supabase
        .from("listings")
        .select("*")
        .eq("user_id", store.user_id)
        .eq("marketplace_code", "own_store")
        .eq("status", "published")
        .order("created_at", { ascending: false });
      if (listErr) throw listErr;

      // ===== 2) Bu ilanların ürünleri (ayrı sorgu, belirsizlik yok) =====
      const ids = [...new Set((listings || []).map((l: any) => l.product_id).filter((x: any) => x != null))];
      const productMap: Record<string, any> = {};
      if (ids.length) {
        const { data: prods, error: prodErr } = await supabase
          .from("products")
          .select("*")
          .in("id", ids);
        if (prodErr) throw prodErr;
        (prods || []).forEach((p: any) => { productMap[String(p.id)] = p; });
      }

      products = (listings || [])
        .map((l: any) => ({ l, p: productMap[String(l.product_id)] }))
        .filter(({ p }) => isSellable(p))
        .map(({ l, p }) => ({
          ...p,
          // eski alan adları korunuyor (magaza.html ve create-store-order uyumlu kalsın)
          id: p.id,
          listing_id: l.id,
          generated_title: l.title || p.generated_title || p.name,
          generated_description: l.description || p.generated_description || "",
          sale_price: l.price ?? l.sale_price ?? p.sale_price,
          currency: l.currency || "TRY",
          language: l.language || l.content_language || p.content_language || "tr",
        }));
    } catch (listErr) {
      // ===== YEDEK: ilan tablosunda sorun olursa eski yöntem =====
      console.error("listings okunamadı, eski yönteme dönülüyor:", (listErr as Error).message);
      source = "legacy";
      const { data: legacy, error: prodErr } = await supabase
        .from("products")
        .select("*")
        .eq("user_id", store.user_id)
        .eq("store_visible", true)
        .order("created_at", { ascending: false });
      if (prodErr) throw prodErr;
      products = (legacy || []).filter(isSellable).map((p: any) => ({ ...p, currency: "TRY" }));
    }

    return json({ store, products, source });
  } catch (err) {
    console.error(err);
    return json({ error: (err as Error).message || "Sunucu hatası" }, 500);
  }
});