// Seltigo eklentisi - ürün sayfasından okuma (satıcının kendi tarayıcısında, sayfanın içinde çalışır).
// chrome.scripting.executeScript ile çağrılır; DIŞARIDAN hiçbir şeye bağımlı olmamalı (tek fonksiyon).
// Döner: { name, price, currency, list_price, images, specs, variants, brand, model_code, description,
//          url, source_platform, source_item_id, stock }  ya da { error }
function seltigoExtract() {
  const url = location.href.split('#')[0];
  const host = location.hostname.toLowerCase();
  const texts = Array.from(document.scripts).map((s) => s.textContent || '');
  const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 500);
  const num = (v) => {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
    let s = String(v).replace(/[^\d.,]/g, '');
    if (!s) return null;
    const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
    if (lc > -1 && ld > -1) s = lc > ld ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else if (lc > -1) s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
    else if (ld > -1) { const p = s.split('.'); if (p.length > 2 || (p.length === 2 && p[1].length === 3)) s = s.replace(/\./g, ''); }
    const n = parseFloat(s);
    return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
  };
  const cur = (v) => { const s = String(v || '').toUpperCase(); return /TRY|TL|₺/.test(s) ? 'TRY' : /USD|\$/.test(s) ? 'USD' : /EUR|€/.test(s) ? 'EUR' : /GBP|£/.test(s) ? 'GBP' : null; };
  const uniq = (a) => Array.from(new Set(a.filter(Boolean)));
  const meta = (p) => { const m = document.querySelector('meta[property="' + p + '"],meta[name="' + p + '"],meta[itemprop="' + p + '"]'); return m ? m.getAttribute('content') || '' : ''; };
  const jsonAfter = (text, marker) => {
    const i = text.indexOf(marker);
    if (i < 0) return null;
    const start = text.indexOf('{', i);
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let k = start; k < text.length; k++) {
      const ch = text[k];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, k + 1)); } catch (e) { return null; } } }
    }
    return null;
  };
  // JSON-LD
  const ld = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try {
      const walk = (n) => { if (!n) return; if (Array.isArray(n)) return n.forEach(walk); if (typeof n !== 'object') return; ld.push(n); if (n['@graph']) walk(n['@graph']); };
      walk(JSON.parse(s.textContent));
    } catch (e) { /* bozuk */ }
  });
  const isType = (n, t) => { const ty = n && n['@type']; return Array.isArray(ty) ? ty.includes(t) : ty === t; };
  const ldImages = (im) => {
    const out = [];
    (Array.isArray(im) ? im : [im]).forEach((x) => { if (typeof x === 'string') out.push(x); else if (x) [x.url, x.contentUrl].flat().forEach((y) => { if (typeof y === 'string') out.push(y); }); });
    return out;
  };

  const item = { url, name: '', price: null, currency: null, list_price: null, images: [], specs: [], variants: [], brand: '', model_code: '', description: '', source_platform: 'web', source_item_id: null, stock: null };

  // ---- AliExpress: tam bilgi Seltigo'nun AliExpress bağlantısından alınır (sunucu) ----
  if (/aliexpress\./.test(host)) {
    const id = (location.pathname.match(/\/item\/(\d+)/) || [])[1];
    if (id) return Object.assign(item, { source_platform: 'aliexpress', source_item_id: id, url: 'https://www.aliexpress.com/item/' + id + '.html', name: clean(document.title, 300), needServer: true });
  }

  // ---- Trendyol: sayfa içi ürün verisi (Türkiye vitrini, TL, Türkçe) ----
  if (/(^|\.)trendyol\.com$/.test(host)) {
    let p = null;
    for (const t of texts) {
      if (t.indexOf('__envoy__SHARED_PROPS') >= 0) { const env = jsonAfter(t, '__envoy__SHARED_PROPS'); if (env && env.product) { p = env.product; break; } }
      if (t.indexOf('__PRODUCT_DETAIL_APP_INITIAL_STATE__') >= 0) { const st = jsonAfter(t, '__PRODUCT_DETAIL_APP_INITIAL_STATE__'); if (st && st.product) { p = st.product; break; } }
    }
    if (p && p.name) {
      const brand = clean((p.brand && p.brand.name) || (p.webBrand && p.webBrand.name), 80);
      const vs = Array.isArray(p.allVariants) && p.allVariants.length ? p.allVariants : (Array.isArray(p.variants) ? p.variants : []);
      const attr = clean((p.variants && p.variants[0] && p.variants[0].attributeName) || 'Beden', 40);
      const variants = vs.map((v) => ({
        supplier_variant_id: String(v.itemNumber || v.barcode || v.value || ''), sku: clean(v.barcode, 80),
        attributes: { [attr]: String(v.beautifiedValue || v.value || v.attributeValue || '') },
        price: num(v.price && (v.price.value != null ? v.price.value : (v.price.sellingPrice && v.price.sellingPrice.value))),
        stock: v.inStock === false ? 0 : null, image: null,
      })).filter((v) => v.supplier_variant_id && Object.values(v.attributes)[0]);
      // Fiyat seçeneklerin içinde (tek seçenekli üründe seçeneğin adı boş olabilir; fiyatı yine oradan)
      const prices = vs.map((v) => num(v.price && (v.price.value != null ? v.price.value : (v.price.sellingPrice && v.price.sellingPrice.value)))).filter(Boolean);
      const sell = p.price && (p.price.sellingPrice ? p.price.sellingPrice.value : (p.price.discountedPrice && p.price.discountedPrice.value));
      const cdn = (x) => (String(x).startsWith('http') ? x : 'https://cdn.dsmcdn.com' + (String(x).startsWith('/') ? '' : '/') + x);
      const ldp = ld.find((n) => isType(n, 'Product'));
      Object.assign(item, {
        name: clean((brand && String(p.name).indexOf(brand) !== 0 ? brand + ' ' : '') + p.name, 300),
        price: num(sell) || (prices.length ? Math.min.apply(null, prices) : null),
        list_price: num(p.price && p.price.originalPrice && p.price.originalPrice.value),
        currency: (ldp && cur(ldp.offers && (ldp.offers.priceCurrency || (ldp.offers[0] && ldp.offers[0].priceCurrency)))) || 'TRY',
        images: uniq((p.images || []).map(cdn)).slice(0, 12),
        specs: (p.attributes || []).map((a) => ({ k: clean(a.key && a.key.name, 80), v: clean(a.value && a.value.name, 200) })).filter((x) => x.k && x.v),
        variants: variants.length > 1 ? variants.slice(0, 100) : [],
        brand, model_code: clean(p.productCode, 80),
        description: clean(((p.contentDescriptions || []).map((d) => d.description || '').join(' ')) || (ldp && ldp.description) || '', 5000),
        source_platform: 'trendyol', source_item_id: String(p.id || ''), stock: p.inStock === false || p.hasStock === false ? 0 : null,
      });
      return item;
    }
  }

  // ---- Amazon: sayfa yapısından ----
  if (/(^|\.)amazon\./.test(host)) {
    const t = document.getElementById('productTitle');
    if (t) {
      const priceEl = document.querySelector('#corePrice_feature_div .a-price .a-offscreen, #corePriceDisplay_desktop_feature_div .a-price .a-offscreen, .a-price .a-offscreen');
      const imgs = [];
      const land = document.getElementById('landingImage');
      if (land) { try { Object.keys(JSON.parse(land.getAttribute('data-a-dynamic-image') || '{}')).forEach((u) => imgs.push(u)); } catch (e) { /* yok */ } if (land.getAttribute('data-old-hires')) imgs.unshift(land.getAttribute('data-old-hires')); }
      texts.forEach((x) => { const m = x.match(/"hiRes":"(https:[^"]+)"/g); if (m) m.forEach((h) => imgs.push(h.slice(9, -1))); });
      const specs = [];
      document.querySelectorAll('#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, #prodDetails tr').forEach((tr) => {
        const k = tr.querySelector('th'), v = tr.querySelector('td');
        if (k && v) specs.push({ k: clean(k.textContent, 80), v: clean(v.textContent, 200) });
      });
      const bullets = Array.from(document.querySelectorAll('#feature-bullets li')).map((li) => '• ' + clean(li.textContent, 300)).join('\n');
      const asin = (location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/) || [])[1] || '';
      Object.assign(item, {
        name: clean(t.textContent, 300), price: num(priceEl && priceEl.textContent), currency: cur(priceEl && priceEl.textContent) || (/\.com\.tr$/.test(host) ? 'TRY' : 'USD'),
        images: uniq(imgs).slice(0, 12), specs: specs.slice(0, 60), brand: clean((document.getElementById('bylineInfo') || {}).textContent || '', 80).replace(/^(Marka|Brand|Visit the)[:\s]*/i, '').replace(/\s*(Store|Mağazası)$/i, ''),
        description: bullets.slice(0, 5000), source_platform: 'amazon', source_item_id: asin,
      });
      return item;
    }
  }

  // ---- Genel: JSON-LD + Open Graph (Hepsiburada, n11 ve diğer siteler) ----
  const group = ld.find((n) => isType(n, 'ProductGroup'));
  const prod = ld.find((n) => isType(n, 'Product')) || group;
  if (prod) {
    const offers = Array.isArray(prod.offers) ? prod.offers[0] : (prod.offers || {});
    const offer = offers && offers.offers ? (Array.isArray(offers.offers) ? offers.offers[0] : offers.offers) : offers;
    Object.assign(item, {
      name: clean(prod.name, 300), price: num(offer && (offer.price || offer.lowPrice)) || num(offers && offers.lowPrice),
      currency: cur(offer && offer.priceCurrency) || cur(offers && offers.priceCurrency),
      images: uniq(ldImages(prod.image)).slice(0, 12), brand: clean(typeof prod.brand === 'string' ? prod.brand : prod.brand && prod.brand.name, 80),
      model_code: clean(prod.mpn || prod.sku || '', 80), description: clean(prod.description, 5000),
      specs: (prod.additionalProperty || []).map((a) => ({ k: clean(a.name, 80), v: clean(a.value, 200) })).filter((x) => x.k && x.v),
    });
    if (group && Array.isArray(group.hasVariant)) {
      item.variants = group.hasVariant.slice(0, 100).map((v) => {
        const o = Array.isArray(v.offers) ? v.offers[0] : (v.offers || {});
        const attributes = {};
        (v.additionalProperty || []).forEach((a) => { if (a && a.name) attributes[a.name] = String(a.value); });
        ['size', 'color', 'material', 'pattern'].forEach((k) => { if (v[k]) attributes[k.charAt(0).toUpperCase() + k.slice(1)] = String(typeof v[k] === 'object' ? v[k].name : v[k]); });
        if (!Object.keys(attributes).length && v.name) attributes['Seçenek'] = clean(v.name, 80);
        return { supplier_variant_id: clean(v.sku || v['@id'] || '', 80), sku: clean(v.sku, 80), attributes, price: num(o && o.price), stock: /OutOfStock/i.test(String(o && o.availability)) ? 0 : null, image: ldImages(v.image)[0] || null };
      });
    }
    if (/hepsiburada\.com$/.test(host)) { item.source_platform = 'hepsiburada'; item.source_item_id = (location.pathname.match(/-p-([A-Z0-9]+)/i) || [])[1] || null; }
    if (/n11\.com$/.test(host)) { item.source_platform = 'n11'; }
  }
  if (!item.name) item.name = clean(meta('og:title') || document.title, 300);
  if (item.price == null) item.price = num(meta('product:price:amount') || meta('og:price:amount'));
  if (!item.currency) item.currency = cur(meta('product:price:currency') || meta('og:price:currency')) || (/\.tr$/.test(host) || /trendyol|hepsiburada|n11/.test(host) ? 'TRY' : null);
  if (!item.images.length && meta('og:image')) item.images = [meta('og:image')];
  if (!item.description) item.description = clean(meta('og:description') || meta('description'), 5000);
  // Okunan bilgi zayıfsa sunucudaki okuyucu da denenir (Shopify / WooCommerce veri adresleri vb.)
  item.needServer = !(item.name && item.price && item.images.length);
  return item;
}
