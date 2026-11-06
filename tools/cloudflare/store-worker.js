/**
 * Seltigo mağaza sunucusu — Cloudflare Worker (Cloudflare for SaaS "fallback origin" arkasında)
 * Satıcının alan adı (www.markam.com) CNAME ile STORE_EDGE_HOST'a bağlanır; Cloudflare SSL'i otomatik verir.
 *  - Alan adı -> mağaza: store-checkout?action=resolve&host= (60 sn önbellek)
 *  - Taşıma: eski adres store_redirects'te varsa 301 (Google sıralaması korunur)
 *  - /sitemap.xml, /robots.txt: mağazaya özel
 *  - /, /p/<id>: vitrin (magaza.html) GitHub Pages'ten; mağaza adı + SEO etiketleri (başlık, açıklama, OpenGraph,
 *    canonical, ürün sayfasında schema.org Product) SUNUCUDA eklenir -> arama motorları JavaScript'siz görür
 *  - Diğer dosyalar (app.js, magaza-pro.js, görseller): GitHub Pages'ten aynen
 * Ortam değişkenleri (wrangler.toml [vars]): SUPABASE_URL, SUPABASE_KEY (sb_publishable_), PAGES_ORIGIN
 */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function cached(req, ttl, make) {
  const cache = caches.default;
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await make();
  if (res.ok) {
    const r = new Response(res.body, res);
    r.headers.set('Cache-Control', `public, max-age=${ttl}`);
    await cache.put(req, r.clone());
    return r;
  }
  return res;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const api = (q) => `${env.SUPABASE_URL}/functions/v1/store-checkout?${q}`;
    const H = { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}` };
    const path = url.pathname;

    if (path === '/sitemap.xml') return cached(new Request(url.toString()), 3600, () => fetch(api(`action=sitemap&host=${host}`), { headers: H }));
    if (path === '/robots.txt') return cached(new Request(url.toString()), 3600, () => fetch(api(`action=robots&host=${host}`), { headers: H }));

    // Statik dosyalar: vitrinin kendi dosyaları
    if (/\.(js|css|png|jpe?g|svg|webp|ico|json|txt|woff2?)$/i.test(path) && !path.startsWith('/p/')) {
      return fetch(`${env.PAGES_ORIGIN}${path}`, { cf: { cacheTtl: 300 } });
    }

    const resolveUrl = api(`action=resolve&host=${encodeURIComponent(host)}&path=${encodeURIComponent(path + url.search)}`);
    const rr = await cached(new Request(resolveUrl), 60, () => fetch(resolveUrl, { headers: H }));
    const r = await rr.json().catch(() => null);
    if (!r || !r.ok) return new Response('Bu alan adına bağlı bir Seltigo mağazası bulunamadı.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    if (r.redirect) return Response.redirect(new URL(r.redirect, url.origin).toString(), 301);

    // Vitrin + sunucu tarafı SEO
    const page = await fetch(`${env.PAGES_ORIGIN}/magaza.html`, { cf: { cacheTtl: 120 } });
    let head = `<base href="${esc(env.PAGES_ORIGIN)}/"><script>window.SELTIGO_STORE=${JSON.stringify(r.slug)};</script>`;
    const pid = (path.match(/^\/p\/(\d+)/) || [])[1];
    if (pid) {
      const p = await fetch(api(`action=product&host=${host}&id=${pid}`), { headers: H }).then((x) => x.json()).catch(() => null);
      if (p && p.ok) {
        const d = String(p.product.description || '').replace(/<[^>]*>/g, '').slice(0, 160);
        head += `<title>${esc(p.product.title)}</title><meta name="description" content="${esc(d)}"><link rel="canonical" href="${esc(p.url)}">`
          + `<meta property="og:type" content="product"><meta property="og:title" content="${esc(p.product.title)}"><meta property="og:description" content="${esc(d)}">`
          + `<meta property="og:url" content="${esc(p.url)}"><meta property="og:image" content="${esc(p.product.images[0] || '')}">`
          + `<script type="application/ld+json">${JSON.stringify(p.jsonld).replace(/</g, '\\u003c')}</script>`;
      } else return new Response('Ürün bulunamadı', { status: 404 });
    } else {
      const s = await fetch(`${env.SUPABASE_URL}/functions/v1/get-store?slug=${encodeURIComponent(r.slug)}&limit=1`, { headers: H }).then((x) => x.json()).catch(() => null);
      const st = s && s.store;
      if (st) {
        const title = (st.seo && st.seo.title) || st.store_name, desc = (st.seo && st.seo.description) || (st.theme && st.theme.hero && st.theme.hero.subtitle) || st.store_name;
        head += `<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${esc(url.origin + '/')}">`
          + `<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(url.origin + '/')}">`;
      }
    }
    return new HTMLRewriter()
      .on('title#pageTitle', { element(e) { e.remove(); } })
      .on('head', { element(e) { e.prepend(head, { html: true }); } })
      .transform(new Response(page.body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' } }));
  },
};
