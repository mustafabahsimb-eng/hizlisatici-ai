/* =========================================================
 * Seltigo vitrini — tam mağaza katmanı (magaza.html'den sonra yüklenir)
 *  - Tema (store.theme: renkler, yazı tipi, köşe, yerleşim, karşılama yazısı, duyuru)
 *  - SEO: başlık / açıklama / OpenGraph / canonical, schema.org (OnlineStore + ItemList, ürün sayfasında Product)
 *  - Ürün sayfası: ?p=<id> (paylaşılabilir adres, 301 yönlendirmelerinin hedefi)
 *  - Sepet (tarayıcıda), kupon, kargo seçeneği, ödeme yöntemi (kapıda / havale / iyzico / PayTR), sipariş özeti
 *  - Müşteri hesabı: kayıt / giriş, siparişlerim (kargo takibi)
 * Fiyat, kupon ve kargo her zaman sunucuda hesaplanır (store-checkout). Sepet kapalıysa (store.checkout.enabled=false)
 * eski tek ürün sipariş akışı aynen çalışır.
 * ========================================================= */
(function () {
  const FN = SUPABASE_URL + '/functions/v1/';
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SUPABASE_KEY, apikey: SUPABASE_KEY };
  const L = {
    tr: {
      cart: 'Sepet', addToCart: 'Sepete ekle', added: 'Sepete eklendi', cartEmpty: 'Sepetin boş.', qty: 'Adet', remove: 'Kaldır',
      coupon: 'Kupon kodu', apply: 'Uygula', shipping: 'Kargo', payment: 'Ödeme', subtotal: 'Ara toplam', discount: 'İndirim', shippingFee: 'Kargo',
      codFee: 'Kapıda ödeme ücreti', total: 'Toplam', free: 'Ücretsiz', checkout: 'Siparişi tamamla', continueShopping: 'Alışverişe devam',
      m_cod: 'Kapıda ödeme', m_bank_transfer: 'Havale / EFT', m_iyzico: 'Kartla öde (iyzico)', m_paytr: 'Kartla öde (PayTR)',
      email: 'E-posta', emailReq: 'E-posta (kartla ödemede zorunlu)', terms: 'Ön bilgilendirme formunu, mesafeli satış sözleşmesini ve iade koşullarını okudum, onaylıyorum.',
      placing: 'Sipariş veriliyor...', toPayment: 'Ödeme sayfasına yönlendiriliyorsun...', done: 'Siparişini aldık!', paid: 'Ödemen alındı, siparişin hazırlanıyor.', payFail: 'Ödeme tamamlanmadı. Sepetin duruyor; tekrar deneyebilirsin.',
      bankInfo: 'Havale bilgileri: {name} · IBAN {iban} · Tutar {total}. Açıklamaya sipariş numaranı yaz: {id}', track: 'Siparişimi takip et', orderNo: 'Sipariş no: {id}',
      account: 'Hesabım', login: 'Giriş yap', register: 'Üye ol', logout: 'Çıkış', password: 'Parola', passwordNew: 'Parola (en az 8 karakter)', name: 'Ad Soyad', phone: 'Telefon',
      myOrders: 'Siparişlerim', noOrders: 'Henüz siparişin yok.', hello: 'Merhaba {n}', st_pending: 'Ödeme bekleniyor', st_paid: 'Ödendi', st_cod: 'Kapıda ödeme',
      st_awaiting_transfer: 'Havale bekleniyor', st_failed: 'Ödeme başarısız', st_cancelled: 'İptal', shipStatus: 'Kargo', back: '← Mağazaya dön', chooseOptions: 'Seçenek seç',
      outOfStock: 'Tükendi', specs: 'Özellikler', share: 'Paylaş', linkCopied: 'Bağlantı kopyalandı', close: 'Kapat', error: 'Hata: ',
    },
    en: {
      cart: 'Cart', addToCart: 'Add to cart', added: 'Added to cart', cartEmpty: 'Your cart is empty.', qty: 'Qty', remove: 'Remove',
      coupon: 'Coupon code', apply: 'Apply', shipping: 'Shipping', payment: 'Payment', subtotal: 'Subtotal', discount: 'Discount', shippingFee: 'Shipping',
      codFee: 'Cash on delivery fee', total: 'Total', free: 'Free', checkout: 'Checkout', continueShopping: 'Continue shopping',
      m_cod: 'Cash on delivery', m_bank_transfer: 'Bank transfer', m_iyzico: 'Pay by card (iyzico)', m_paytr: 'Pay by card (PayTR)',
      email: 'Email', emailReq: 'Email (required for card payment)', terms: 'I have read and accept the pre-contract information, distance sales agreement and return conditions.',
      placing: 'Placing order...', toPayment: 'Redirecting to payment...', done: 'We received your order!', paid: 'Payment received, your order is being prepared.', payFail: 'Payment was not completed. Your cart is kept; you can try again.',
      bankInfo: 'Bank transfer: {name} · IBAN {iban} · Amount {total}. Put your order number in the description: {id}', track: 'Track my order', orderNo: 'Order no: {id}',
      account: 'My account', login: 'Log in', register: 'Sign up', logout: 'Log out', password: 'Password', passwordNew: 'Password (min. 8 characters)', name: 'Full name', phone: 'Phone',
      myOrders: 'My orders', noOrders: 'No orders yet.', hello: 'Hello {n}', st_pending: 'Awaiting payment', st_paid: 'Paid', st_cod: 'Cash on delivery',
      st_awaiting_transfer: 'Awaiting transfer', st_failed: 'Payment failed', st_cancelled: 'Cancelled', shipStatus: 'Shipment', back: '← Back to store', chooseOptions: 'Choose options',
      outOfStock: 'Sold out', specs: 'Details', share: 'Share', linkCopied: 'Link copied', close: 'Close', error: 'Error: ',
    },
  };
  const tt = (k, v) => { let s = (L[LANG] || L.tr)[k] ?? L.tr[k] ?? k; Object.keys(v || {}).forEach((x) => { s = s.split('{' + x + '}').join(v[x]); }); return s; };
  const esc = (s) => escapeHtml(String(s ?? ''));
  const money = (n, c) => formatPrice(n, c || 'TRY');
  const SL = () => slug || '';
  const cartKey = () => 'seltigo_cart_' + SL();
  const custKey = () => 'seltigo_cust_' + SL();
  let store = null, cart = [], lastQuote = null, sel = { coupon: '', shipping_option: '', payment_method: '' };
  const pro = () => !!(store && store.checkout && store.checkout.enabled);

  // ---------- Stil ----------
  const css = document.createElement('style');
  css.textContent = `
    .sp-hdr-actions{position:absolute;top:18px;right:18px;display:flex;gap:8px}
    header{position:relative}
    .sp-btn{background:var(--bg-panel-2);color:var(--text);border:1px solid var(--border);border-radius:var(--radius,10px);padding:8px 12px;font:inherit;font-size:14px;cursor:pointer}
    .sp-btn.primary,.primary{background:var(--accent)!important;color:var(--accent-text,#04150f)!important;border-color:var(--accent)!important}
    .sp-count{display:inline-block;min-width:18px;padding:0 5px;border-radius:9px;background:var(--accent);color:var(--accent-text,#04150f);font-size:12px;margin-left:4px}
    .sp-ann{background:var(--accent);color:var(--accent-text,#04150f);text-align:center;padding:7px 12px;font-size:13px}
    .sp-drawer{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;z-index:60}
    .sp-drawer.open{display:block}
    .sp-panel{position:absolute;right:0;top:0;bottom:0;width:min(440px,100%);background:var(--bg-panel);border-left:1px solid var(--border);overflow-y:auto;padding:18px}
    .sp-panel h3{margin:0 0 12px}
    .sp-line{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)}
    .sp-line img{width:58px;height:58px;object-fit:cover;border-radius:8px;background:var(--bg-panel-2)}
    .sp-line .n{font-size:14px} .sp-line .v{font-size:12px;color:var(--text-dim)}
    .sp-qty{display:flex;align-items:center;gap:6px;margin-top:6px} .sp-qty button{width:26px;height:26px}
    .sp-row{display:flex;justify-content:space-between;font-size:14px;margin:5px 0} .sp-row.total{font-weight:700;font-size:16px}
    .sp-panel input,.sp-panel select,.sp-panel textarea{width:100%;background:var(--bg-dark);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:9px 10px;font:inherit;font-size:14px;margin:4px 0 8px}
    .sp-opt{display:flex;gap:8px;align-items:center;border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin:5px 0;font-size:14px;cursor:pointer}
    .sp-opt input{width:auto;margin:0;accent-color:var(--accent)}
    .sp-sec{margin-top:14px;font-size:12px;letter-spacing:.06em;color:var(--text-dim);text-transform:uppercase}
    .sp-err{color:var(--danger);font-size:13px;margin:6px 0} .sp-ok{color:var(--accent);font-size:13px;margin:6px 0}
    .sp-pp{position:fixed;inset:0;background:var(--bg-dark);z-index:55;overflow-y:auto;display:none}
    .sp-pp.open{display:block}
    body.sp-pp-open .sp-hdr-actions{position:fixed;top:14px;right:18px;z-index:57}
    .sp-pp-in{max-width:1000px;margin:0 auto;padding:20px;display:grid;grid-template-columns:1.1fr 1fr;gap:28px}
    @media(max-width:760px){.sp-pp-in{grid-template-columns:1fr}.sp-hdr-actions{position:static;justify-content:center;margin-top:10px}}
    .sp-gal img.main{width:100%;aspect-ratio:1;object-fit:cover;border-radius:var(--radius,12px);background:var(--bg-panel-2)}
    .sp-thumbs{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap} .sp-thumbs img{width:64px;height:64px;object-fit:cover;border-radius:8px;cursor:pointer;opacity:.75} .sp-thumbs img.on{opacity:1;outline:2px solid var(--accent)}
    .sp-price{font-size:24px;font-weight:700;margin:10px 0}
    .sp-desc{white-space:pre-wrap;color:var(--text-dim);font-size:14px;line-height:1.6}
    body.sp-layout-large .grid{grid-template-columns:repeat(auto-fill,minmax(300px,1fr))!important}
    body.sp-layout-list .grid{grid-template-columns:1fr!important} body.sp-layout-list .card{display:grid;grid-template-columns:200px 1fr}
    body.sp-font-serif{font-family:Georgia,'Times New Roman',serif} body.sp-font-rounded{font-family:'Nunito','Segoe UI Rounded','Segoe UI',Arial,sans-serif} body.sp-font-mono{font-family:ui-monospace,Consolas,monospace}
    .card,.modal,.sp-btn{border-radius:var(--radius,12px)}
    .card-img-wrap,.card-title{cursor:pointer}
  `;
  document.head.appendChild(css);

  // ---------- Tema ----------
  function lum(h) { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
  function applyTheme(th) {
    if (!th || !th.colors) return;
    const c = th.colors, r = document.documentElement.style;
    r.setProperty('--bg-dark', c.bg); r.setProperty('--bg-panel', c.panel); r.setProperty('--bg-panel-2', c.panel2); r.setProperty('--border', c.border);
    r.setProperty('--text', c.text); r.setProperty('--text-dim', c.dim); r.setProperty('--accent', c.accent); r.setProperty('--accent-hover', c.accent); r.setProperty('--accent-text', c.accentText || '#04150f');
    r.setProperty('--radius', (Number(th.radius) || 0) + 'px');
    document.body.classList.add('sp-layout-' + (th.layout || 'grid'), 'sp-font-' + (th.font || 'system'));
    const meta = document.querySelector('meta[name=theme-color]') || Object.assign(document.createElement('meta'), { name: 'theme-color' });
    meta.content = c.panel; document.head.appendChild(meta);
    document.documentElement.style.colorScheme = lum(c.bg) > 0.4 ? 'light' : 'dark';
    if (th.hero && th.hero.subtitle) { const s = document.getElementById('storeSub'); if (s) s.textContent = th.hero.subtitle + ' · ' + s.textContent; }
    if (th.announcement) { const a = document.createElement('div'); a.className = 'sp-ann'; a.textContent = th.announcement; document.body.insertBefore(a, document.body.firstChild); }
  }

  // ---------- SEO ----------
  function setMeta(attr, key, val) {
    if (!val) return;
    let m = document.head.querySelector(`meta[${attr}="${key}"]`);
    if (!m) { m = document.createElement('meta'); m.setAttribute(attr, key); document.head.appendChild(m); }
    m.setAttribute('content', val);
  }
  function setLd(id, obj) {
    let s = document.getElementById(id);
    if (!s) { s = document.createElement('script'); s.type = 'application/ld+json'; s.id = id; document.head.appendChild(s); }
    s.textContent = JSON.stringify(obj);
  }
  function baseUrl() { return store && store.custom_domain && location.hostname === store.custom_domain ? location.origin + '/' : location.origin + location.pathname + '?slug=' + encodeURIComponent(SL()); }
  function productLink(id) { return store && store.custom_domain && location.hostname === store.custom_domain ? location.origin + '/p/' + id : location.origin + location.pathname + '?slug=' + encodeURIComponent(SL()) + '&p=' + id; }
  function storeSeo() {
    const seo = store.seo || {}, name = getStoreName(store);
    const title = seo.title || name, desc = seo.description || (store.theme && store.theme.hero && store.theme.hero.subtitle) || name;
    document.title = title;
    setMeta('name', 'description', desc); setMeta('name', 'keywords', seo.keywords);
    setMeta('property', 'og:title', title); setMeta('property', 'og:description', desc); setMeta('property', 'og:type', 'website');
    setMeta('property', 'og:url', baseUrl()); setMeta('property', 'og:image', seo.og_image || store.business_logo_url || (currentProducts[0] && currentProducts[0].image_url));
    let can = document.head.querySelector('link[rel=canonical]'); if (!can) { can = document.createElement('link'); can.rel = 'canonical'; document.head.appendChild(can); } can.href = baseUrl();
    setLd('sp-ld-store', { '@context': 'https://schema.org', '@type': 'OnlineStore', name, url: baseUrl(), ...(store.business_logo_url ? { logo: store.business_logo_url } : {}),
      ...(desc ? { description: desc } : {}) });
    setLd('sp-ld-list', { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: currentProducts.slice(0, 48).map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: productLink(p.id), name: productTitle(p) })) });
  }

  // ---------- Sepet ----------
  function loadCart() { try { cart = JSON.parse(localStorage.getItem(cartKey()) || '[]'); } catch (e) { cart = []; } }
  function saveCart() { localStorage.setItem(cartKey(), JSON.stringify(cart)); renderCount(); }
  function renderCount() { const n = cart.reduce((s, l) => s + l.qty, 0); const el = document.getElementById('spCount'); if (el) { el.textContent = n; el.style.display = n ? '' : 'none'; } }
  function addLine(p, v, qty) {
    const key = p.id + ':' + (v ? v.id : '');
    const ex = cart.find((l) => l.key === key);
    if (ex) ex.qty = Math.min(99, ex.qty + qty);
    else cart.push({ key, product_id: p.id, variant_id: v ? v.id : null, qty, name: productTitle(p), variant_label: v ? Object.entries(v.attributes).map(([k, x]) => optionName(k) + ': ' + x).join(' · ') : '', price: v ? v.price : (parseFloat(p.sale_price) || 0), currency: p.currency, image: (v && v.image_url) || p.image_url });
    saveCart(); showToast(tt('added')); track('AddToCart', { content_ids: [String(p.id)], value: v ? v.price : p.sale_price, currency: p.currency || 'TRY' });
  }

  // Ürün sayfası (sepet + seçenek + SEO)
  let ppProduct = null;
  async function openProduct(id, push) {
    const r = await fetch(FN + 'store-checkout?action=product&slug=' + encodeURIComponent(SL()) + '&id=' + id, { headers: H }).then((x) => x.json()).catch(() => null);
    if (!r || !r.ok) { showToast(tt('error') + ((r && r.error) || ''), 3000, true); return; }
    const p = r.product; ppProduct = p;
    if (push) history.pushState({ p: id }, '', productLink(id).replace(location.origin, ''));
    const pp = document.getElementById('spPP');
    const opts = {};
    (p.variants || []).forEach((v) => Object.entries(v.attributes).forEach(([k, x]) => { (opts[k] = opts[k] || []).includes(x) || opts[k].push(x); }));
    pp.innerHTML = `<div style="max-width:1000px;margin:0 auto;padding:14px 20px 0"><button class="sp-btn" id="spPPBack">${esc(tt('back'))}</button></div>
      <div class="sp-pp-in"><div class="sp-gal"><img class="main" id="spMainImg" src="${esc(safeImg(p.images[0]) || placeholderImg)}" alt="${esc(p.title)}">
        <div class="sp-thumbs">${p.images.slice(0, 10).map((u, i) => `<img src="${esc(safeImg(u))}" class="${i ? '' : 'on'}" alt="">`).join('')}</div></div>
      <div><h1 style="margin:0 0 6px;font-size:24px">${esc(p.title)}</h1>${p.brand ? `<div class="v" style="color:var(--text-dim)">${esc(p.brand)}</div>` : ''}
        <div class="sp-price" id="spPrice">${esc(money(p.price, p.currency))}</div>
        <div id="spOpts">${Object.entries(opts).map(([k, vals]) => `<label style="font-size:13px;color:var(--text-dim)">${esc(optionName(k))}</label><select data-k="${esc(k)}" class="sp-sel" style="width:100%;margin:4px 0 10px;padding:9px;background:var(--bg-panel-2);color:var(--text);border:1px solid var(--border);border-radius:8px"><option value="">${esc(tt('chooseOptions'))}</option>${vals.map((x) => `<option>${esc(x)}</option>`).join('')}</select>`).join('')}</div>
        <div style="display:flex;gap:8px;align-items:center;margin:8px 0 14px"><input type="number" id="spPPQty" value="1" min="1" max="99" style="width:80px;padding:9px;background:var(--bg-panel-2);color:var(--text);border:1px solid var(--border);border-radius:8px">
          <button class="sp-btn primary" id="spPPAdd" style="flex:1" ${p.in_stock ? '' : 'disabled'}>${esc(p.in_stock ? tt('addToCart') : tt('outOfStock'))}</button><button class="sp-btn" id="spPPShare">${esc(tt('share'))}</button></div>
        <div class="sp-err" id="spPPErr"></div>
        <div class="sp-desc">${esc(String(p.description || '').replace(/<[^>]*>/g, ''))}</div>
        ${(p.specs || []).length ? `<div class="sp-sec">${esc(tt('specs'))}</div><ul style="font-size:13px;color:var(--text-dim)">${p.specs.slice(0, 30).map((s) => `<li>${esc(s.k)}: ${esc(s.v)}</li>`).join('')}</ul>` : ''}
      </div></div>`;
    pp.classList.add('open'); document.body.classList.add('sp-pp-open'); document.body.style.overflow = 'hidden'; window.scrollTo(0, 0);
    pp.querySelectorAll('.sp-thumbs img').forEach((im) => im.onclick = () => { document.getElementById('spMainImg').src = im.src; pp.querySelectorAll('.sp-thumbs img').forEach((x) => x.classList.toggle('on', x === im)); });
    const pick = () => {
      const want = {}; pp.querySelectorAll('.sp-sel').forEach((s) => { if (s.value) want[s.dataset.k] = s.value; });
      const v = (p.variants || []).find((x) => Object.entries(x.attributes).every(([k, val]) => want[k] === val));
      if (v) { document.getElementById('spPrice').textContent = money(v.price, p.currency); if (v.image_url) document.getElementById('spMainImg').src = v.image_url; }
      return v;
    };
    pp.querySelectorAll('.sp-sel').forEach((s) => s.onchange = pick);
    document.getElementById('spPPBack').onclick = () => closeProduct(true);
    document.getElementById('spPPShare').onclick = async () => { const u = productLink(p.id); try { if (navigator.share) await navigator.share({ title: p.title, url: u }); else { await navigator.clipboard.writeText(u); showToast(tt('linkCopied')); } } catch (e) {} };
    document.getElementById('spPPAdd').onclick = () => {
      const v = pick(); const err = document.getElementById('spPPErr'); err.textContent = '';
      if ((p.variants || []).length && !v) { err.textContent = tt('chooseOptions'); return; }
      if (v && !v.available) { err.textContent = tt('outOfStock'); return; }
      const qty = Math.min(99, Math.max(1, parseInt(document.getElementById('spPPQty').value, 10) || 1));
      if (!pro()) { closeProduct(false); const lp = currentProducts.find((x) => x.id === p.id); openOrderModal(lp || { ...p, id: p.id, listing_id: p.listing_id, generated_title: p.title, sale_price: p.price, variants: p.variants }); return; }
      addLine({ id: p.id, generated_title: p.title, sale_price: p.price, currency: p.currency, image_url: p.images[0] }, v, qty);
      openCart();
    };
    // SEO: ürün başlığı, açıklama, OpenGraph, Product JSON-LD
    document.title = p.title + ' - ' + getStoreName(store);
    setMeta('name', 'description', String(p.description || '').replace(/<[^>]*>/g, '').slice(0, 160));
    setMeta('property', 'og:title', p.title); setMeta('property', 'og:type', 'product'); setMeta('property', 'og:image', p.images[0]); setMeta('property', 'og:url', r.url);
    setMeta('property', 'product:price:amount', String(p.price)); setMeta('property', 'product:price:currency', p.currency);
    const can = document.head.querySelector('link[rel=canonical]'); if (can) can.href = r.url;
    setLd('sp-ld-product', r.jsonld);
    track('ViewContent', { content_ids: [String(p.id)], value: p.price, currency: p.currency });
  }
  function closeProduct(back) {
    document.getElementById('spPP').classList.remove('open'); document.body.classList.remove('sp-pp-open'); document.body.style.overflow = '';
    const s = document.getElementById('sp-ld-product'); if (s) s.remove();
    if (back && history.state && history.state.p) history.back(); else if (back) history.replaceState({}, '', baseUrl().replace(location.origin, ''));
    storeSeo();
  }

  // ---------- Sepet çekmecesi ----------
  async function requote() {
    const body = { action: 'quote', store_slug: SL(), items: cart.map((l) => ({ product_id: l.product_id, variant_id: l.variant_id, qty: l.qty })), ...sel };
    lastQuote = cart.length ? await fetch(FN + 'store-checkout', { method: 'POST', headers: H, body: JSON.stringify(body) }).then((x) => x.json()).catch(() => null) : null;
    renderCart();
  }
  function openCart() { document.getElementById('spCart').classList.add('open'); requote(); }
  function closeCart() { document.getElementById('spCart').classList.remove('open'); }
  function renderCart() {
    const box = document.getElementById('spCartBody');
    if (!cart.length) { box.innerHTML = `<p>${esc(tt('cartEmpty'))}</p><button class="sp-btn" data-x="close">${esc(tt('continueShopping'))}</button>`; box.querySelector('[data-x=close]').onclick = closeCart; return; }
    const q = lastQuote && lastQuote.ok ? lastQuote : null;
    const cur = (q && q.currency) || cart[0].currency || 'TRY';
    if (q) { if (!sel.shipping_option && q.shipping_option) sel.shipping_option = q.shipping_option.id; if (!sel.payment_method && q.methods[0]) sel.payment_method = q.methods[0]; }
    const cust = account();
    box.innerHTML = cart.map((l, i) => {
      const ql = q && q.lines.find((x) => x.product_id === l.product_id && (x.variant_id || null) === (l.variant_id || null));
      return `<div class="sp-line"><img src="${esc(safeImg(l.image) || placeholderImg)}" alt=""><div style="flex:1"><div class="n">${esc(l.name)}</div>${l.variant_label ? `<div class="v">${esc(l.variant_label)}</div>` : ''}
        <div class="sp-qty"><button class="sp-btn" data-dec="${i}">−</button><b>${l.qty}</b><button class="sp-btn" data-inc="${i}">+</button><button class="sp-btn" data-rm="${i}" style="margin-left:auto;font-size:12px">${esc(tt('remove'))}</button></div></div>
        <div style="white-space:nowrap">${esc(money((ql ? ql.unit_price : l.price) * l.qty, cur))}</div></div>`;
    }).join('')
    + (lastQuote && !lastQuote.ok ? `<div class="sp-err">${esc(lastQuote.error || '')}</div>` : '')
    + `<div class="sp-sec">${esc(tt('coupon'))}</div><div style="display:flex;gap:6px"><input id="spCoupon" value="${esc(sel.coupon)}" placeholder="${esc(tt('coupon'))}"><button class="sp-btn" id="spCouponBtn">${esc(tt('apply'))}</button></div>`
    + (q && q.coupon_error ? `<div class="sp-err">${esc(q.coupon_error)}</div>` : q && q.coupon ? `<div class="sp-ok">✓ ${esc(q.coupon.code)}</div>` : '')
    + (q ? `<div class="sp-sec">${esc(tt('shipping'))}</div>` + q.shipping_options.map((s) => `<label class="sp-opt"><input type="radio" name="spShip" value="${esc(s.id)}" ${s.id === sel.shipping_option ? 'checked' : ''}> <span style="flex:1">${esc(s.name)}${s.days ? ` <small style="color:var(--text-dim)">· ${esc(s.days)}</small>` : ''}${s.free_over ? ` <small style="color:var(--text-dim)">· ${esc(money(s.free_over, cur))}+ ${esc(tt('free'))}</small>` : ''}</span><b>${Number(s.price) ? esc(money(s.price, cur)) : esc(tt('free'))}</b></label>`).join('') : '')
    + (q ? `<div class="sp-sec">${esc(tt('payment'))}</div>` + q.methods.map((m) => `<label class="sp-opt"><input type="radio" name="spPay" value="${m}" ${m === sel.payment_method ? 'checked' : ''}> ${esc(tt('m_' + m))}</label>`).join('') : '')
    + (q ? `<div style="margin-top:12px">
        <div class="sp-row"><span>${esc(tt('subtotal'))}</span><span>${esc(money(q.subtotal, cur))}</span></div>
        ${q.discount ? `<div class="sp-row"><span>${esc(tt('discount'))}</span><span>−${esc(money(q.discount, cur))}</span></div>` : ''}
        <div class="sp-row"><span>${esc(tt('shippingFee'))}</span><span>${q.shipping ? esc(money(q.shipping, cur)) : esc(tt('free'))}</span></div>
        ${q.cod_fee ? `<div class="sp-row"><span>${esc(tt('codFee'))}</span><span>${esc(money(q.cod_fee, cur))}</span></div>` : ''}
        <div class="sp-row total"><span>${esc(tt('total'))}</span><span>${esc(money(q.total, cur))}</span></div></div>` : '')
    + `<div class="sp-sec">${esc(tt('checkout'))}</div>
      <input id="spName" placeholder="${esc(tt('name'))}" autocomplete="name" value="${esc(cust && cust.name || '')}">
      <input id="spPhone" placeholder="${esc(tt('phone'))}" autocomplete="tel" value="${esc(cust && cust.phone || '')}">
      <input id="spEmail" type="email" placeholder="${esc(tt(sel.payment_method === 'iyzico' || sel.payment_method === 'paytr' ? 'emailReq' : 'email'))}" autocomplete="email" value="${esc(cust && cust.email || '')}">
      <textarea id="spAddr" placeholder="${esc(t('fAddress'))}" autocomplete="street-address"></textarea>
      <div style="display:flex;gap:6px"><input id="spCity" placeholder="${esc(t('fCity'))}" autocomplete="address-level1"><input id="spDistrict" placeholder="${esc(t('fDistrict'))}" autocomplete="address-level2"></div>
      <input id="spZip" placeholder="${esc(t('fZip'))}" inputmode="numeric" autocomplete="postal-code">
      <label class="sp-opt" style="align-items:flex-start"><input type="checkbox" id="spTerms"> <span style="font-size:12.5px">${esc(tt('terms'))}</span></label>
      <div class="sp-err" id="spErr"></div>
      <button class="sp-btn primary" id="spPlace" style="width:100%;padding:12px;font-weight:700" ${q ? '' : 'disabled'}>${esc(tt('checkout'))}${q ? ' · ' + esc(money(q.total, cur)) : ''}</button>`;
    const addr = (cust && cust.addresses && cust.addresses[0]) || null;
    if (addr) { box.querySelector('#spAddr').value = addr.text || ''; box.querySelector('#spCity').value = addr.city || ''; box.querySelector('#spDistrict').value = addr.district || ''; box.querySelector('#spZip').value = addr.zip || ''; }
    box.querySelectorAll('[data-inc]').forEach((b) => b.onclick = () => { cart[+b.dataset.inc].qty = Math.min(99, cart[+b.dataset.inc].qty + 1); saveCart(); requote(); });
    box.querySelectorAll('[data-dec]').forEach((b) => b.onclick = () => { const l = cart[+b.dataset.dec]; l.qty = Math.max(1, l.qty - 1); saveCart(); requote(); });
    box.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { cart.splice(+b.dataset.rm, 1); saveCart(); requote(); });
    box.querySelector('#spCouponBtn').onclick = () => { sel.coupon = box.querySelector('#spCoupon').value.trim(); requote(); };
    box.querySelectorAll('input[name=spShip]').forEach((r) => r.onchange = () => { sel.shipping_option = r.value; requote(); });
    box.querySelectorAll('input[name=spPay]').forEach((r) => r.onchange = () => { sel.payment_method = r.value; requote(); });
    box.querySelector('#spPlace').onclick = place;
  }
  async function place() {
    const g = (id) => document.getElementById(id).value.trim();
    const err = document.getElementById('spErr'); err.textContent = '';
    if (!document.getElementById('spTerms').checked) { err.textContent = tt('terms'); return; }
    const btn = document.getElementById('spPlace'); btn.disabled = true; btn.textContent = tt('placing');
    const src = (() => { const out = {}; ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'fbclid'].forEach((k) => { const v = params.get(k); if (v) out[k] = v; }); const fbc = cookie('_fbc'), fbp = cookie('_fbp'); if (fbc) out.fbc = fbc; if (fbp) out.fbp = fbp; return out; })();
    const body = { action: 'place', store_slug: SL(), items: cart.map((l) => ({ product_id: l.product_id, variant_id: l.variant_id, qty: l.qty })), ...sel, accept_terms: true,
      customer: { name: g('spName'), phone: g('spPhone'), email: g('spEmail'), address: g('spAddr'), city: g('spCity'), district: g('spDistrict'), zip: g('spZip') },
      customer_token: localStorage.getItem(custKey()) || undefined, return_url: location.origin + location.pathname, ad_source: src };
    const r = await fetch(FN + 'store-checkout', { method: 'POST', headers: H, body: JSON.stringify(body) }).then((x) => x.json()).catch(() => ({ ok: false, error: 'Ağ hatası' }));
    if (!r.ok) { err.textContent = r.error || 'Hata'; btn.disabled = false; btn.textContent = tt('checkout'); return; }
    track('Purchase', { value: r.total, currency: (lastQuote && lastQuote.currency) || 'TRY' }, { eventID: r.checkout_id });
    if (r.redirect_url) { btn.textContent = tt('toPayment'); location.href = r.redirect_url; return; }
    cart = []; saveCart();
    showResult(r.checkout_id, true, r.bank);
  }
  async function showResult(id, ok, bank) {
    const st = await fetch(FN + 'store-checkout', { method: 'POST', headers: H, body: JSON.stringify({ action: 'status', checkout_id: id }) }).then((x) => x.json()).catch(() => null);
    const paidOk = st && st.ok && ['paid', 'cod', 'awaiting_transfer'].includes(st.checkout.payment_status);
    if (paidOk) { cart = []; saveCart(); }
    const box = document.getElementById('spCartBody');
    document.getElementById('spCart').classList.add('open');
    const short = String(id).slice(0, 8).toUpperCase();
    box.innerHTML = paidOk ? `<h3>✅ ${esc(tt('done'))}</h3><p>${esc(tt('orderNo', { id: short }))}</p>${st.checkout.payment_status === 'paid' ? `<p>${esc(tt('paid'))}</p>` : ''}
      ${bank && bank.iban ? `<p class="sp-ok">${esc(tt('bankInfo', { name: bank.name || '', iban: bank.iban, total: money(st.checkout.total, st.checkout.currency), id: short }))}</p>` : ''}
      ${(st.tracking || []).slice(0, 1).map((u) => `<p><a class="sp-btn primary" style="text-decoration:none;display:inline-block" href="${esc(u)}" target="_blank" rel="noopener">${esc(tt('track'))}</a></p>`).join('')}
      <button class="sp-btn" data-x="close">${esc(tt('continueShopping'))}</button>`
      : `<h3>⚠️</h3><p class="sp-err">${esc(tt('payFail'))}</p><button class="sp-btn" data-x="cart">${esc(tt('cart'))}</button>`;
    const c = box.querySelector('[data-x=close]'); if (c) c.onclick = closeCart;
    const k = box.querySelector('[data-x=cart]'); if (k) k.onclick = () => requote();
  }

  // ---------- Müşteri hesabı ----------
  let acc = null;
  const account = () => acc;
  async function custCall(body) { return await fetch(FN + 'store-customer', { method: 'POST', headers: H, body: JSON.stringify(body) }).then((x) => x.json()).catch(() => ({ ok: false, error: 'Ağ hatası' })); }
  async function loadAccount() {
    const tok = localStorage.getItem(custKey());
    if (!tok) { acc = null; return null; }
    const r = await custCall({ action: 'me', token: tok });
    if (!r.ok) { if (r.expired) localStorage.removeItem(custKey()); acc = null; return null; }
    acc = r.customer; acc.orders = r.orders; return r;
  }
  async function openAccount(tab) {
    const d = document.getElementById('spAcc'); d.classList.add('open');
    const box = document.getElementById('spAccBody');
    const me = await loadAccount();
    if (me) {
      box.innerHTML = `<h3>${esc(tt('hello', { n: acc.name || acc.email }))}</h3><div class="sp-sec">${esc(tt('myOrders'))}</div>`
        + (me.orders.length ? me.orders.map((o) => `<div class="sp-line" style="display:block"><div class="sp-row"><b>#${esc(String(o.id).slice(0, 8).toUpperCase())}</b><span>${esc(money(o.total, o.currency))}</span></div>
          <div class="v">${esc(new Date(o.created_at).toLocaleDateString(LANG === 'en' ? 'en-GB' : 'tr-TR'))} · ${esc(tt('st_' + o.payment_status))}</div>
          <div class="v">${o.items.map((i) => esc(i.name + (i.variant_label ? ' (' + i.variant_label + ')' : '') + ' ×' + i.qty)).join('<br>')}</div>
          ${o.shipments.slice(0, 1).map((s) => `<a href="${esc(s.tracking_url)}" target="_blank" rel="noopener" style="color:var(--accent);font-size:13px">${esc(tt('track'))}</a>`).join('')}</div>`).join('') : `<p>${esc(tt('noOrders'))}</p>`)
        + `<button class="sp-btn" id="spLogout" style="margin-top:14px">${esc(tt('logout'))}</button>`;
      box.querySelector('#spLogout').onclick = async () => { await custCall({ action: 'logout', token: localStorage.getItem(custKey()) }); localStorage.removeItem(custKey()); acc = null; openAccount('login'); };
      return;
    }
    const reg = tab === 'register';
    box.innerHTML = `<div style="display:flex;gap:6px;margin-bottom:12px"><button class="sp-btn ${reg ? '' : 'primary'}" data-tab="login">${esc(tt('login'))}</button><button class="sp-btn ${reg ? 'primary' : ''}" data-tab="register">${esc(tt('register'))}</button></div>
      ${reg ? `<input id="spAName" placeholder="${esc(tt('name'))}" autocomplete="name"><input id="spAPhone" placeholder="${esc(tt('phone'))}" autocomplete="tel">` : ''}
      <input id="spAEmail" type="email" placeholder="${esc(tt('email'))}" autocomplete="email"><input id="spAPass" type="password" placeholder="${esc(tt(reg ? 'passwordNew' : 'password'))}" autocomplete="${reg ? 'new-password' : 'current-password'}">
      <div class="sp-err" id="spAErr"></div><button class="sp-btn primary" id="spAGo" style="width:100%">${esc(tt(reg ? 'register' : 'login'))}</button>`;
    box.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => openAccount(b.dataset.tab));
    box.querySelector('#spAGo').onclick = async () => {
      const v = (id) => (box.querySelector('#' + id) || {}).value || '';
      const r = await custCall({ action: reg ? 'register' : 'login', store_slug: SL(), email: v('spAEmail'), password: v('spAPass'), name: v('spAName'), phone: v('spAPhone') });
      if (!r.ok) { box.querySelector('#spAErr').textContent = r.error || 'Hata'; return; }
      localStorage.setItem(custKey(), r.token); openAccount();
    };
  }

  // ---------- Kurulum ----------
  function mountUi() {
    const hdr = document.querySelector('header');
    const act = document.createElement('div'); act.className = 'sp-hdr-actions';
    act.innerHTML = `<button class="sp-btn" id="spAccBtn">👤 <span>${esc(tt('account'))}</span></button><button class="sp-btn" id="spCartBtn">🛒 <span>${esc(tt('cart'))}</span><span class="sp-count" id="spCount" style="display:none">0</span></button>`;
    hdr.appendChild(act);
    const mk = (id, inner) => { const d = document.createElement('div'); d.className = 'sp-drawer'; d.id = id; d.innerHTML = `<div class="sp-panel"><div style="display:flex;justify-content:space-between;align-items:center"><h3>${inner}</h3><button class="sp-btn" data-close>✕</button></div><div id="${id}Body"></div></div>`; document.body.appendChild(d); d.onclick = (e) => { if (e.target === d || e.target.hasAttribute('data-close')) d.classList.remove('open'); }; };
    mk('spCart', '🛒 ' + esc(tt('cart')));
    mk('spAcc', '👤 ' + esc(tt('account')));
    document.getElementById('spCartBtn').onclick = openCart;
    document.getElementById('spAccBtn').onclick = () => openAccount();
    renderCount();
  }
  // Kartlar: görsel / başlık ürün sayfasını açar; sepet açıksa "Satın Al" -> ürün sayfası (seçenek + sepete ekle)
  function wireCards() {
    const grid = document.getElementById('productGrid');
    if (!grid || grid.dataset.sp) return;
    grid.dataset.sp = '1';
    grid.addEventListener('click', (e) => {
      const card = e.target.closest('.card'); if (!card) return;
      const idx = [...grid.children].indexOf(card); const p = currentProducts[idx]; if (!p) return;
      if (e.target.closest('.card-img-wrap') || e.target.closest('.card-title')) { e.preventDefault(); openProduct(p.id, true); return; }
      if (pro() && e.target.closest('.buy-btn') && !(store.buy_on_website && p.seller_url)) {
        e.stopImmediatePropagation(); e.preventDefault();
        if (!(p.variants || []).length) { addLine(p, null, 1); openCart(); } else openProduct(p.id, true);
      }
    }, true);
  }

  window.SeltigoPro = {
    onStore(s) {
      store = s; loadCart();
      if (!document.getElementById('spPP')) { const pp = document.createElement('div'); pp.className = 'sp-pp'; pp.id = 'spPP'; document.body.appendChild(pp); }
      applyTheme(s.theme);
      if (s.theme && s.theme.layout) document.body.classList.add('sp-layout-' + s.theme.layout);
      if (pro()) {
        mountUi();
        document.querySelectorAll('.buy-btn').forEach((b) => b.textContent = tt('addToCart'));
      }
      storeSeo(); wireCards();
      const pid = Number(params.get('p') || (location.pathname.match(/\/p\/(\d+)/) || [])[1]);
      if (pid) openProduct(pid, false);
      const co = params.get('checkout');
      if (co) { showResult(co, params.get('paid') !== '0'); history.replaceState({}, '', baseUrl().replace(location.origin, '')); }
      if (pro()) loadAccount();
    },
    onCards() { wireCards(); if (pro()) document.querySelectorAll('.buy-btn').forEach((b) => b.textContent = tt('addToCart')); },
  };
  window.addEventListener('popstate', () => { const pid = Number(new URLSearchParams(location.search).get('p')); if (pid) openProduct(pid, false); else if (document.getElementById('spPP').classList.contains('open')) { document.getElementById('spPP').classList.remove('open'); document.body.classList.remove('sp-pp-open'); document.body.style.overflow = ''; storeSeo(); } });
})();
