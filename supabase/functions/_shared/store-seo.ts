// =========================================================
// Seltigo mağaza SEO + kendi alan adı sunucusu (Cloudflare Worker) yardımcıları. store-checkout GET isteklerinde çalışır
// (proje fonksiyon sayısı sınırı: ayrı fonksiyon açılmadı). Adres: /functions/v1/store-checkout?action=...
//   ?action=sitemap&slug=|host=     -> XML site haritası (ana sayfa + her ürün sayfası, lastmod)
//   ?action=robots&host=            -> robots.txt (site haritası satırıyla)
//   ?action=resolve&host=[&path=]   -> { slug, redirect } : alan adının mağazası ve eski adres için 301 hedefi (taşıma haritası)
//   ?action=product&slug=&id=       -> tek ürün (ürün sayfası + schema.org Product JSON-LD)
// =========================================================

const SITE = "https://mustafabahsimb-eng.github.io/hizlisatici-ai";
let db: any;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (b: unknown, s = 200, cache = 60) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${cache}` } });
const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function storeBy(slug: string | null, host: string | null) {
  if (host) {
    const { data: d } = await db.from("store_domains").select("store_slug, user_id").ilike("hostname", host.toLowerCase()).eq("status", "active").maybeSingle();
    if (!d) return null;
    const { data } = await db.from("store_settings").select("*").eq("user_id", d.user_id).maybeSingle();
    return data ? { ...data, base: `https://${host.toLowerCase()}` } : null;
  }
  if (!slug) return null;
  const { data } = await db.from("store_settings").select("*").eq("store_slug", slug).maybeSingle();
  return data ? { ...data, base: data.custom_domain ? `https://${data.custom_domain}` : null } : null;
}
const productUrl = (st: any, id: number) => st.base ? `${st.base}/p/${id}` : `${SITE}/magaza.html?slug=${encodeURIComponent(st.store_slug)}&p=${id}`;
const homeUrl = (st: any) => st.base ? `${st.base}/` : `${SITE}/magaza.html?slug=${encodeURIComponent(st.store_slug)}`;

async function sellable(st: any, limit = 50000) {
  const { data } = await db.from("listings").select("product_id, updated_at, p:products!listings_product_id_fkey!inner(id, deleted_at, merged_into, store_visible, stock_status, updated_at)")
    .eq("user_id", st.user_id).eq("marketplace_code", "own_store").eq("status", "published").is("deleted_at", null)
    .is("p.deleted_at", null).is("p.merged_into", null).not("p.store_visible", "is", false).limit(limit);
  return (data || []).filter((l: any) => l.p && l.p.stock_status !== "tukendi");
}

export async function handleSeo(req: Request, client: any): Promise<Response> {
  db = client;
  const u = new URL(req.url);
  const action = u.searchParams.get("action") || "";
  const slug = u.searchParams.get("slug"), host = u.searchParams.get("host");
  try {
    if (action === "resolve") {
      const st = await storeBy(null, host);
      if (!st) return json({ ok: false }, 404, 30);
      const path = (u.searchParams.get("path") || "").replace(/\/+$/, "") || "/";
      let redirect: string | null = null;
      if (path !== "/") {
        const { data: r } = await db.from("store_redirects").select("id, to_url, hits").eq("user_id", st.user_id).eq("from_path", path.slice(0, 500)).maybeSingle();
        if (r) { redirect = r.to_url; db.from("store_redirects").update({ hits: (r.hits || 0) + 1 }).eq("id", r.id).then(() => null); }
      }
      return json({ ok: true, slug: st.store_slug, redirect }, 200, 30);
    }
    if (action === "sitemap") {
      const st = await storeBy(slug, host);
      if (!st) return new Response("not found", { status: 404, headers: cors });
      const list = await sellable(st);
      const urls = [`<url><loc>${xmlEsc(homeUrl(st))}</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
        ...list.map((l: any) => `<url><loc>${xmlEsc(productUrl(st, l.product_id))}</loc><lastmod>${new Date(l.p.updated_at || l.updated_at).toISOString().slice(0, 10)}</lastmod></url>`)];
      return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>`,
        { headers: { ...cors, "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
    }
    if (action === "robots") {
      const st = await storeBy(null, host);
      const sm = st ? `${st.base}/sitemap.xml` : "";
      return new Response(`User-agent: *\nAllow: /\nDisallow: /hesabim\nDisallow: /sepet\n${sm ? "Sitemap: " + sm + "\n" : ""}`, { headers: { ...cors, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
    }
    if (action === "product") {
      const st = await storeBy(slug, host);
      const id = Number(u.searchParams.get("id"));
      if (!st || !(id > 0)) return json({ ok: false, error: "Bulunamadı" }, 404);
      const { data: l } = await db.from("listings").select("id, product_id, price, currency, title, description").eq("user_id", st.user_id).eq("marketplace_code", "own_store")
        .eq("status", "published").is("deleted_at", null).eq("product_id", id).maybeSingle();
      const { data: p } = l ? await db.from("products").select("id, name, generated_title, generated_description, image_url, brand, gtin, model_code, stock_status, stock_qty, deleted_at, merged_into, store_visible, supplier_price, specs").eq("id", id).maybeSingle() : { data: null };
      if (!l || !p || p.deleted_at || p.merged_into || p.store_visible === false) return json({ ok: false, error: "Ürün satışta değil" }, 404);
      const [{ data: imgs }, { data: vars }] = await Promise.all([
        db.from("product_images").select("url").eq("product_id", id).is("deleted_at", null).order("position").limit(12),
        db.from("product_variants").select("id, attributes, cost, stock_qty, stock_status, image_url").eq("product_id", id).eq("is_default", false).eq("is_active", true).is("deleted_at", null),
      ]);
      const pc = Number(p.supplier_price);
      const price = Number(l.price);
      const images = [...new Set([p.image_url, ...(imgs || []).map((i: any) => i.url)].filter(Boolean))];
      const variants = (vars || []).filter((v: any) => v.attributes && Object.keys(v.attributes).length).map((v: any) => ({
        id: v.id, attributes: v.attributes, image_url: v.image_url, available: !(v.stock_status === "tukendi" || (v.stock_qty != null && Number(v.stock_qty) <= 0)),
        price: pc > 0 && Number(v.cost) > 0 ? Math.round(price * (Number(v.cost) / pc) * 100) / 100 : price,
      }));
      const inStock = p.stock_status !== "tukendi" && (p.stock_qty == null || p.stock_qty > 0);
      const title = l.title || p.generated_title || p.name;
      const ld = {
        "@context": "https://schema.org", "@type": "Product", name: title, description: String(l.description || p.generated_description || "").slice(0, 5000), image: images,
        sku: p.model_code || String(p.id), ...(p.gtin ? { gtin: p.gtin } : {}), ...(p.brand ? { brand: { "@type": "Brand", name: p.brand } } : {}),
        offers: { "@type": "Offer", url: productUrl(st, id), priceCurrency: l.currency || "TRY", price: price.toFixed(2), availability: inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock", seller: { "@type": "Organization", name: st.business_name || st.store_name } },
      };
      return json({ ok: true, product: { id, listing_id: l.id, title, description: l.description || p.generated_description || "", price, currency: l.currency || "TRY", images, variants, in_stock: inStock, brand: p.brand, specs: p.specs || [] }, url: productUrl(st, id), jsonld: ld });
    }
    return json({ ok: false, error: "Geçersiz işlem" }, 400);
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: "Sunucu hatası" }, 500);
  }
}
