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
    const body = await req.json();
    const { store_slug, product_id, customer_name, customer_phone, customer_address, quantity } = body;

    if (!store_slug || !product_id || !customer_name || !customer_phone || !customer_address) {
      return new Response(JSON.stringify({ error: "Eksik bilgi: ad, telefon ve adres zorunlu" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Mağazayı doğrula
    const { data: store, error: storeErr } = await supabase
      .from("store_settings")
      .select("*")
      .eq("store_slug", store_slug)
      .maybeSingle();

    if (storeErr) throw storeErr;
    if (!store) {
      return new Response(JSON.stringify({ error: "Mağaza bulunamadı" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Ürünü doğrula (bu mağazaya ait ve vitrinde görünür mü)
    const { data: product, error: productErr } = await supabase
      .from("products")
      .select("*")
      .eq("id", product_id)
      .eq("user_id", store.user_id)
      .eq("store_visible", true)
      .maybeSingle();

    if (productErr) throw productErr;
    if (!product) {
      return new Response(JSON.stringify({ error: "Ürün bulunamadı" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const qty = parseInt(quantity, 10) || 1;
    const addressWithQty = qty > 1 ? `${customer_address} (Adet: ${qty})` : customer_address;

    const { data: order, error: insertErr } = await supabase
      .from("store_orders")
      .insert({
        user_id: store.user_id,
        product_id: product_id,
        customer_name: customer_name,
        customer_phone: customer_phone,
        customer_address: addressWithQty,
        status: "pending",
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    return new Response(JSON.stringify({ success: true, order }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: err.message || "Sunucu hatası" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});