// Supabase Edge Function: social-catalog
// Satıcının ürünlerini Meta ürün kataloğuna (Commerce Manager) otomatik yükler.
// Bu katalog WhatsApp kataloğunda, Instagram Mağazası'nda ve Facebook Mağazası'nda kullanılır.
// İşlemler: status (durum + kataloglar), select (var olan kataloğu seç), create (yeni katalog aç),
//           sync (ürünleri gönder), remove (seçilenleri katalogdan kaldır), clear (kataloğu boşalt)
// Katalog seçilince/gönderilince satıcının WhatsApp numaralarına otomatik bağlanır (WhatsApp kataloğu + sepet).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const GRAPH = "https://graph.facebook.com/v21.0";
const SITE_URL = "https://mustafabahsimb-eng.github.io/hizlisatici-ai/";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function fb(path: string, params: Record<string, string>, method = "GET") {
  const body = new URLSearchParams(params);
  const url = GRAPH + path + (method === "GET" ? "?" + body.toString() : "");
  const r = await fetch(url, method === "GET" ? {} : { method: "POST", body });
  const d = await r.json().catch(() => ({}));
  if (d.error) throw new Error(d.error.error_user_msg || d.error.message || "Facebook hatası");
  return d;
}

function niceError(msg: string) {
  if (/expired|session has been invalidated|validating access token/i.test(msg)) return "Facebook bağlantısının süresi dolmuş. Sosyal medya sayfasından Facebook'u tekrar bağla.";
  if (/permission|not authorized|requires|catalog_management/i.test(msg)) return "Katalog izni yok. Sosyal medya sayfasından Facebook'u tekrar bağla ve tüm izinleri ver.";
  return msg;
}

function plain(s: string, max: number) {
  const t = String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trim() + "…" : t;
}

// Kataloğu satıcının WhatsApp hesaplarına bağla ve WhatsApp'ta kataloğu + sepeti aç
async function linkWhatsApp(supabase: any, userId: string, catalogId: string, token: string) {
  const { data: chans } = await supabase.from("social_channels").select("*")
    .eq("user_id", userId).eq("platform", "whatsapp").eq("active", true);
  const out: { phone: string; ok: boolean; error?: string; note?: string }[] = [];
  for (const ch of chans || []) {
    const waba = ch.extra?.waba_id;
    const tk = ch.access_token || token;
    const phone = ch.extra?.phone || ch.account_name || ch.account_id;
    let step = "katalog bağlama";
    try {
      if (waba) {
        // Zaten bağlı mı?
        let linked = false;
        try {
          const cur = await fb(`/${waba}/product_catalogs`, { fields: "id", access_token: tk });
          linked = (cur.data || []).some((c: any) => String(c.id) === String(catalogId));
        } catch { /* okuyamazsa bağlamayı dene */ }
        if (!linked) {
          try {
            await fb(`/${waba}/product_catalogs`, { catalog_id: catalogId, access_token: tk }, "POST");
          } catch (e) {
            if (!/already|exists|duplicate/i.test(String((e as Error)?.message || e))) throw e;
          }
        }
      }
      // Katalog WhatsApp hesabına bağlandı. Sohbette katalog + sepet düğmesini açmayı dene;
      // Meta test numaralarında ve uygulama onayı öncesinde buna izin vermeyebilir, bu bağlantıyı bozmaz.
      let note: string | undefined;
      try {
        await fb(`/${ch.account_id}/whatsapp_commerce_settings`, {
          is_catalog_visible: "true", is_cart_enabled: "true", access_token: tk,
        }, "POST");
      } catch (e) {
        note = String((e as Error)?.message || e);
      }
      out.push({ phone, ok: true, ...(note ? { note } : {}) } as any);
    } catch (e) {
      // Ham Meta mesajını da göster ki sorunu kesin görelim
      out.push({ phone, ok: false, error: `${step}: ${String((e as Error)?.message || e)}` });
    }
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const { userAccessToken, action } = body;
    if (!userAccessToken) return json({ error: "Oturum bilgisi gerekli" }, 400);

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: "Bearer " + userAccessToken } },
    });
    const { data: userData, error: userErr } = await supabase.auth.getUser(userAccessToken);
    if (userErr || !userData?.user) return json({ error: "Oturum geçersiz" }, 401);
    const userId = userData.user.id;

    const { data: row } = await supabase.from("meta_catalogs").select("*").eq("user_id", userId).maybeSingle();
    const token = row?.user_token;
    if (!token) return json({ connected: false });

    const save = async (fields: Record<string, unknown>) => {
      const { error } = await supabase.from("meta_catalogs")
        .update({ ...fields, updated_at: new Date().toISOString() }).eq("user_id", userId);
      if (error) throw error;
    };

    // ---------- Durum: işletmeler ve katalogları ----------
    if (!action || action === "status") {
      const biz = await fb("/me/businesses", { fields: "id,name", limit: "50", access_token: token });
      const businesses: any[] = [];
      for (const b of biz.data || []) {
        let catalogs: any[] = [];
        try {
          const c = await fb(`/${b.id}/owned_product_catalogs`, { fields: "id,name,product_count", limit: "50", access_token: token });
          catalogs = (c.data || []).map((x: any) => ({ id: x.id, name: x.name, count: x.product_count || 0 }));
        } catch { /* izin yoksa boş geç */ }
        businesses.push({ id: b.id, name: b.name, catalogs });
      }
      const { data: waCh } = await supabase.from("social_channels").select("account_name, extra")
        .eq("user_id", userId).eq("platform", "whatsapp").eq("active", true);
      return json({
        connected: true,
        whatsapp: (waCh || []).map((c: any) => c.extra?.phone || c.account_name),
        current: row?.catalog_id ? {
          business_id: row.business_id, business_name: row.business_name,
          catalog_id: row.catalog_id, catalog_name: row.catalog_name,
          item_count: row.item_count, last_sync_at: row.last_sync_at, last_error: row.last_error,
        } : null,
        businesses,
      });
    }

    // ---------- Var olan kataloğu seç ----------
    if (action === "select") {
      const { business_id, business_name, catalog_id, catalog_name } = body;
      if (!catalog_id) return json({ error: "Katalog seçilmedi" }, 400);
      await save({ business_id, business_name, catalog_id, catalog_name, last_error: null });
      const whatsapp = await linkWhatsApp(supabase, userId, String(catalog_id), token);
      return json({ ok: true, whatsapp });
    }

    // ---------- Yeni katalog aç ----------
    if (action === "create") {
      const { business_id, business_name } = body;
      if (!business_id) return json({ error: "İşletme seçilmedi" }, 400);
      const name = String(body.name || "Seltigo Katalog").slice(0, 100);
      const c = await fb(`/${business_id}/owned_product_catalogs`, { name, access_token: token }, "POST");
      await save({ business_id, business_name, catalog_id: String(c.id), catalog_name: name, last_error: null });
      const whatsapp = await linkWhatsApp(supabase, userId, String(c.id), token);
      return json({ ok: true, catalog_id: c.id, whatsapp });
    }

    // ---------- Ürünleri kataloğa gönder ----------
    if (action === "sync") {
      if (!row?.catalog_id) return json({ error: "Önce bir katalog seç" }, 400);
      const ids = (Array.isArray(body.productIds) ? body.productIds : []).map(String);
      // Satıcının "katalogda olmasın" dediği ürünler
      let excluded: string[] = Array.isArray(row.excluded_ids) ? row.excluded_ids.map(String) : [];
      if (ids.length) {
        // Elle seçip gönderdiyse: artık katalogda olsun
        excluded = excluded.filter((x) => !ids.includes(x));
      }

      let q = supabase.from("products").select("*").eq("user_id", userId)
        .is("deleted_at", null).is("merged_into", null);
      if (ids.length) q = q.in("id", ids);
      const { data: products, error: pErr } = await q.limit(1000);
      if (pErr) throw pErr;
      const list = (products || []).filter((p: any) => !excluded.includes(String(p.id)));
      if (!list.length) return json({ error: "Gönderilecek ürün yok" }, 400);

      const pIds = list.map((p: any) => p.id);
      const [listRes, imgRes, storeRes] = await Promise.all([
        supabase.from("listings").select("product_id, price, currency").in("product_id", pIds)
          .eq("marketplace_code", "own_store").is("deleted_at", null),
        supabase.from("product_images").select("product_id, url, position").in("product_id", pIds)
          .order("position", { ascending: true }),
        supabase.from("store_settings").select("*").eq("user_id", userId).limit(1),
      ]);
      const listing: Record<string, any> = {};
      (listRes.data || []).forEach((l: any) => { listing[String(l.product_id)] = l; });
      const gallery: Record<string, string[]> = {};
      (imgRes.data || []).forEach((r: any) => {
        const k = String(r.product_id);
        (gallery[k] = gallery[k] || []).push(r.url);
      });
      const store = storeRes.data?.[0];
      const storeUrl = store?.store_slug
        ? `${SITE_URL}magaza.html?slug=${encodeURIComponent(store.store_slug)}`
        : SITE_URL;
      const brandDefault = store?.store_name || row.business_name || "Seltigo";
      const isUrl = (u: any) => typeof u === "string" && /^https?:\/\//i.test(u);

      const requests: any[] = [];
      const skipped: { id: string; name: string; reason: string }[] = [];
      for (const p of list) {
        const name = String(p.generated_title || p.name || "").slice(0, 150);
        const imgs = Array.from(new Set([p.image_url, ...(gallery[String(p.id)] || [])].filter(isUrl)));
        const l = listing[String(p.id)];
        const price = l && Number(l.price) > 0 ? Number(l.price) : (Number(p.sale_price) > 0 ? Number(p.sale_price) : null);
        const cur = l && Number(l.price) > 0 ? (l.currency || "TRY") : (p.cost_currency || "TRY");
        if (!name) { skipped.push({ id: String(p.id), name, reason: "Ürün adı yok" }); continue; }
        if (!imgs.length) { skipped.push({ id: String(p.id), name, reason: "Görsel yok" }); continue; }
        if (price == null) { skipped.push({ id: String(p.id), name, reason: "Satış fiyatı yok" }); continue; }
        const outOfStock = p.stock_status === "tukendi" || (p.stock_qty != null && Number(p.stock_qty) <= 0);
        requests.push({
          method: "UPDATE",
          data: {
            id: `seltigo_${p.id}`,
            title: name,
            description: plain(p.generated_description || p.description || name, 5000) || name,
            availability: outOfStock ? "out of stock" : "in stock",
            condition: "new",
            price: `${price.toFixed(2)} ${cur}`,
            link: `${storeUrl}${storeUrl.includes("?") ? "&" : "?"}p=${p.id}`,
            image_link: imgs[0],
            additional_image_link: imgs.slice(1, 20),
            brand: String(p.brand || brandDefault).slice(0, 100),
          },
        });
      }

      // Meta'ya 200'erli paketler halinde gönder
      let sent = 0;
      const errors: string[] = [];
      for (let i = 0; i < requests.length; i += 200) {
        const chunk = requests.slice(i, i + 200);
        try {
          await fb(`/${row.catalog_id}/items_batch`, {
            item_type: "PRODUCT_ITEM",
            allow_upsert: "true",
            requests: JSON.stringify(chunk),
            access_token: token,
          }, "POST");
          sent += chunk.length;
        } catch (e) {
          errors.push(niceError(String((e as Error)?.message || e)));
        }
      }

      let count = row.item_count || 0;
      try {
        const c = await fb(`/${row.catalog_id}`, { fields: "product_count", access_token: token });
        if (c.product_count != null) count = c.product_count;
      } catch { /* sayı alınamazsa eskisi kalsın */ }

      await save({ item_count: count, last_sync_at: new Date().toISOString(), last_error: errors[0] || null, excluded_ids: excluded });
      // Her gönderimde WhatsApp bağlantısını da garantiye al (yeni numara eklendiyse otomatik bağlanır)
      const whatsapp = await linkWhatsApp(supabase, userId, String(row.catalog_id), token);
      return json({ ok: errors.length === 0, sent, skipped, errors, item_count: count, whatsapp });
    }

    // ---------- Seçilenleri katalogdan kaldır / kataloğu boşalt ----------
    if (action === "remove" || action === "clear") {
      if (!row?.catalog_id) return json({ error: "Önce bir katalog seç" }, 400);
      let retailerIds: string[] = [];
      let excluded: string[] = Array.isArray(row.excluded_ids) ? row.excluded_ids.map(String) : [];

      if (action === "remove") {
        const ids = (Array.isArray(body.productIds) ? body.productIds : []).map(String);
        if (!ids.length) return json({ error: "Ürün seçilmedi" }, 400);
        retailerIds = ids.map((id: string) => `seltigo_${id}`);
        // Bir dahaki "tümünü gönder"de geri gelmesinler
        excluded = Array.from(new Set([...excluded, ...ids]));
      } else {
        // Katalogdaki tüm ürünleri bul
        let next: string | null = `/${row.catalog_id}/products`;
        let params: Record<string, string> = { fields: "retailer_id", limit: "500", access_token: token };
        for (let guard = 0; next && guard < 20; guard++) {
          const d = await fb(next, params);
          (d.data || []).forEach((x: any) => { if (x.retailer_id) retailerIds.push(String(x.retailer_id)); });
          const after = d.paging?.cursors?.after;
          if (d.paging?.next && after) { params = { ...params, after }; } else { next = null; }
        }
      }

      let removed = 0;
      const errors: string[] = [];
      for (let i = 0; i < retailerIds.length; i += 200) {
        const chunk = retailerIds.slice(i, i + 200).map((rid) => ({ method: "DELETE", data: { id: rid } }));
        try {
          await fb(`/${row.catalog_id}/items_batch`, {
            item_type: "PRODUCT_ITEM",
            requests: JSON.stringify(chunk),
            access_token: token,
          }, "POST");
          removed += chunk.length;
        } catch (e) {
          errors.push(niceError(String((e as Error)?.message || e)));
        }
      }

      let count = row.item_count || 0;
      try {
        const c = await fb(`/${row.catalog_id}`, { fields: "product_count", access_token: token });
        if (c.product_count != null) count = c.product_count;
      } catch { /* sayı alınamazsa eskisi kalsın */ }
      if (action === "clear" && !errors.length) count = 0;

      await save({ item_count: count, excluded_ids: excluded, last_error: errors[0] || null });
      return json({ ok: errors.length === 0, removed, errors, item_count: count });
    }

    return json({ error: "Bilinmeyen işlem" }, 400);
  } catch (err) {
    return json({ error: niceError(String((err as Error)?.message || err)) }, 500);
  }
});