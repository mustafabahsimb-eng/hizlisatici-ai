import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const slug = url.searchParams.get("slug");

    if (!slug) {
      return new Response(JSON.stringify({ error: "slug parametresi gerekli" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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

    if (!store) {
      return new Response(JSON.stringify({ error: "Mağaza bulunamadı" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: products, error: prodErr } = await supabase
      .from("products")
      .select("*")
      .eq("user_id", store.user_id)
      .eq("store_visible", true)
      .order("created_at", { ascending: false });

    if (prodErr) throw prodErr;

    return new Response(
      JSON.stringify({ store, products: products || [] }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ error: err.message || "Sunucu hatası" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});