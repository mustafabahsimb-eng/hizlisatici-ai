// =========================================================
// Seltigo - Sosyal medyada paylaş (share.js)
// Kullanım: HSShare.open([ürün id, ...])
// Kanallar: WhatsApp, Instagram, Facebook, Telegram (kullanıcı kullandıklarını işaretler, seçim hatırlanır)
// Telefonda: telefonun paylaşım menüsü resimler + yazıyla açılır.
// Bilgisayarda: yazı kopyalanır, resimler indirilir, kanalın web sayfası açılır.
// =========================================================
(function () {
  if (window.HSShare) return;

  HS.i18n.add({
    tr: {
      'sh.title': 'Sosyal medyada paylaş',
      'sh.titleN': 'Sosyal medyada paylaş ({n} ürün)',
      'sh.channels': 'Hangi kanallarda paylaşılsın?',
      'sh.remember': 'Seçimin hatırlanır.',
      'sh.text': 'Paylaşım yazısı',
      'sh.tplDetail': 'Detaylı',
      'sh.tplShort': 'Kısa',
      'sh.textNote': 'Instagram ve Facebook için yıldızlar (*) kaldırılır, sonuna etiketler (#) eklenir.',
      'sh.images': '{n} resim',
      'sh.preparing': 'Resimler hazırlanıyor... ({d} / {t})',
      'sh.ready': 'Hazır',
      'sh.imgFail': '{n} resim alınamadı, onlarsız paylaşılacak.',
      'sh.share': 'Paylaş',
      'sh.shareOn': '{c} ile paylaş',
      'sh.next': 'Sıradaki: {c} ile paylaş',
      'sh.done': '✓ Paylaşım tamamlandı',
      'sh.pickOne': 'En az bir kanal işaretle.',
      'sh.close': 'Kapat',
      'sh.loading': 'Ürünler yükleniyor...',
      'sh.noProducts': 'Ürün bulunamadı.',
      'sh.copied': 'Yazı kopyalandı. Gerekirse açılan uygulamada yapıştır.',
      'sh.deskHint': 'Bilgisayardasın: yazı kopyalandı ve resimler indirildi. Açılan sayfada yazıyı yapıştırıp resimleri ekle.',
      'sh.igDesk': 'Instagram bilgisayardan paylaşıma izin vermiyor: yazı kopyalandı ve resimler indirildi, gönderiyi Instagram\'da oluşturabilirsin.',
      'sh.cancelled': 'Paylaşım iptal edildi.',
      'sh.status': '{c}: {s}',
      'sh.stSent': 'açıldı ✓',
      'sh.stWait': 'sırada',
      'sh.order': 'Sipariş ve bilgi için yazın',
      'sh.newProducts': 'Yeni ürünler',
      'sh.inStock': 'Stokta',
      'sh.more': 've {n} ürün daha',
      'sh.store': 'Tüm ürünler',
    },
    en: {
      'sh.title': 'Share on social media',
      'sh.titleN': 'Share on social media ({n} products)',
      'sh.channels': 'Which channels should it be shared on?',
      'sh.remember': 'Your choice is remembered.',
      'sh.text': 'Post text',
      'sh.tplDetail': 'Detailed',
      'sh.tplShort': 'Short',
      'sh.textNote': 'For Instagram and Facebook, asterisks (*) are removed and hashtags (#) are added at the end.',
      'sh.images': '{n} images',
      'sh.preparing': 'Preparing images... ({d} / {t})',
      'sh.ready': 'Ready',
      'sh.imgFail': '{n} images could not be loaded; sharing without them.',
      'sh.share': 'Share',
      'sh.shareOn': 'Share on {c}',
      'sh.next': 'Next: share on {c}',
      'sh.done': '✓ Sharing complete',
      'sh.pickOne': 'Tick at least one channel.',
      'sh.close': 'Close',
      'sh.loading': 'Loading products...',
      'sh.noProducts': 'No products found.',
      'sh.copied': 'Text copied. Paste it in the app if needed.',
      'sh.deskHint': 'You are on a computer: the text was copied and the images downloaded. Paste the text on the page that opened and attach the images.',
      'sh.igDesk': 'Instagram does not allow posting from a computer: the text was copied and the images downloaded, you can create the post in Instagram.',
      'sh.cancelled': 'Sharing cancelled.',
      'sh.status': '{c}: {s}',
      'sh.stSent': 'opened ✓',
      'sh.stWait': 'waiting',
      'sh.order': 'Message us to order or ask',
      'sh.newProducts': 'New products',
      'sh.inStock': 'In stock',
      'sh.more': 'and {n} more products',
      'sh.store': 'All products',
    }
  });

  const t = HS.t;
  const esc = HS.escapeHtml;
  const db = HS.db;

  // Kanallar: ikonlar Font Awesome'dan (gerçek marka ikonları), renkler markaların kendi renkleri
  const CHANNELS = [
    { id: 'whatsapp', name: 'WhatsApp', icon: 'fa-brands fa-whatsapp', color: '#25D366' },
    { id: 'instagram', name: 'Instagram', icon: 'fa-brands fa-instagram', color: 'linear-gradient(45deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888)' },
    { id: 'facebook', name: 'Facebook', icon: 'fa-brands fa-facebook', color: '#1877F2' },
    { id: 'telegram', name: 'Telegram', icon: 'fa-brands fa-telegram', color: '#229ED9' },
  ];
  const FA_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css';
  const MAX_IMAGES = 10;

  let state = null; // { products, files, failed, queue, done, template }

  function fmt(s, v) { return String(s).replace(/\{(\w+)\}/g, (m, k) => v[k] != null ? v[k] : m); }

  function injectAssets() {
    if (document.getElementById('hsShareCss')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = FA_CSS;
    document.head.appendChild(link);
    const st = document.createElement('style');
    st.id = 'hsShareCss';
    st.textContent =
      '.hs-sh-back{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2000;display:flex;align-items:center;justify-content:center;padding:16px;}' +
      '.hs-sh,.hs-sh *{box-sizing:border-box;}' +
      '.hs-sh{background:#141821;border:1px solid #2a3040;border-radius:14px;width:100%;max-width:560px;max-height:92vh;overflow:auto;padding:18px;color:#e6e8ee;font-family:inherit;}' +
      '.hs-sh-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:10px;}' +
      '.hs-sh-title{font-size:16px;font-weight:600;color:#fff;}' +
      '.hs-sh-x{background:transparent;border:1px solid #2a3040;color:#9aa3b2;width:32px;height:32px;border-radius:8px;cursor:pointer;font-size:16px;flex-shrink:0;}' +
      '.hs-sh-imgs{display:flex;gap:6px;overflow-x:auto;padding-bottom:6px;margin-bottom:6px;}' +
      '.hs-sh-imgs img{width:64px;height:64px;object-fit:cover;border-radius:8px;background:#1c212c;flex-shrink:0;}' +
      '.hs-sh-note{font-size:12px;color:#9aa3b2;line-height:1.5;margin:4px 0 12px;}' +
      '.hs-sh-label{font-size:13px;color:#c3c9d4;margin:10px 0 8px;font-weight:600;}' +
      '.hs-sh-ch{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;}' +
      '.hs-sh-c{display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 4px;border:1px solid #2a3040;border-radius:10px;cursor:pointer;user-select:none;position:relative;background:#0d0f16;}' +
      '.hs-sh-c.on{border-color:#1D9E75;background:#0f1a16;}' +
      '.hs-sh-c input{position:absolute;top:6px;left:6px;accent-color:#1D9E75;width:15px;height:15px;}' +
      '.hs-sh-ic{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:24px;}' +
      '.hs-sh-cn{font-size:12px;color:#e6e8ee;}' +
      '.hs-sh-row{display:flex;align-items:center;gap:8px;justify-content:space-between;flex-wrap:wrap;}' +
      '.hs-sh select{padding:6px 10px;border-radius:8px;border:1px solid #2a3040;background:#0d0f16;color:#e6e8ee;font-size:13px;}' +
      '.hs-sh textarea{width:100%;min-height:190px;padding:10px 12px;border-radius:10px;border:1px solid #2a3040;background:#0d0f16;color:#e6e8ee;font-size:13px;line-height:1.5;font-family:inherit;resize:vertical;}' +
      '.hs-sh-go{width:100%;margin-top:14px;padding:12px;border:none;border-radius:10px;background:#1D9E75;color:#fff;font-size:15px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;}' +
      '.hs-sh-go:disabled{opacity:.5;cursor:not-allowed;}' +
      '.hs-sh-st{font-size:12px;color:#9aa3b2;margin-top:10px;line-height:1.7;}' +
      '.hs-sh-st b{color:#6ee7b7;font-weight:600;}' +
      '.hs-sh-msg{font-size:12px;color:#e6c96a;margin-top:8px;line-height:1.5;}' +
      '@media (max-width:420px){.hs-sh-ch{grid-template-columns:repeat(2,1fr);}}';
    document.head.appendChild(st);
  }

  // ---------- Kanal tercihi (hesapta saklanır, yoksa bu cihazda) ----------
  function loadChannels() {
    const meta = HS.user && HS.user.user_metadata && HS.user.user_metadata.share_channels;
    if (Array.isArray(meta) && meta.length) return meta.filter(c => CHANNELS.some(x => x.id === c));
    try { const v = JSON.parse(localStorage.getItem('hs_share_channels') || 'null'); if (Array.isArray(v) && v.length) return v; } catch (e) {}
    return ['whatsapp'];
  }
  function saveChannels(list) {
    try { localStorage.setItem('hs_share_channels', JSON.stringify(list)); } catch (e) {}
    db.auth.updateUser({ data: { share_channels: list } }).catch(() => {});
  }

  // ---------- Veri ----------
  async function loadData(ids) {
    const [pr, im, li, ss] = await Promise.all([
      db.from('products').select('*').in('id', ids),
      db.from('product_images').select('product_id, url, position').in('product_id', ids).order('position', { ascending: true }),
      db.from('listings').select('product_id, price, currency, marketplace_code, status').in('product_id', ids).eq('marketplace_code', 'own_store').is('deleted_at', null),
      db.from('store_settings').select('store_slug').eq('user_id', HS.user.id).maybeSingle(),
    ]);
    if (pr.error) throw pr.error;
    const imgs = {}, lst = {};
    (im.data || []).forEach(r => { (imgs[r.product_id] = imgs[r.product_id] || []).push(r.url); });
    (li.data || []).forEach(r => { lst[r.product_id] = r; });
    const order = new Map(ids.map((id, i) => [String(id), i]));
    const products = (pr.data || []).sort((a, b) => order.get(String(a.id)) - order.get(String(b.id))).map(p => {
      const list = [];
      if (p.image_url) list.push(p.image_url);
      (imgs[p.id] || []).forEach(u => { if (list.indexOf(u) === -1) list.push(u); });
      const l = lst[p.id];
      const price = l && Number(l.price) > 0 ? { v: Number(l.price), c: l.currency || 'TRY' }
        : (Number(p.sale_price) > 0 ? { v: Number(p.sale_price), c: (p.cost_currency || 'TRY') } : null);
      return Object.assign({}, p, { images: list.filter(u => /^https?:\/\//i.test(u)), price: price });
    });
    // Fiyatı müşterinin anlayacağı para birimine çevir (ör. USD → TL)
    const home = HS.homeCurrency();
    for (const p of products) {
      if (p.price && p.price.c !== home) {
        try { const v = await HS.convert(p.price.v, p.price.c, home); if (v != null && v > 0) p.price = { v: Math.round(v * 100) / 100, c: home }; } catch (e) {}
      }
    }
    const slug = ss && ss.data && ss.data.store_slug;
    const storeUrl = slug ? new URL('magaza.html?slug=' + encodeURIComponent(slug), location.href).toString() : '';
    return { products, storeUrl };
  }

  // ---------- Yazı ----------
  function highlights(p, max) {
    const out = [];
    if (Array.isArray(p.specs)) {
      p.specs.forEach(s => {
        if (out.length >= max || !s || !s.k || !s.v) return;
        const v = String(s.v).trim();
        if (v.length > 50 || /^(yok|hayır|no|-|none)$/i.test(v)) return;
        out.push(String(s.k).trim() + ': ' + v);
      });
    }
    if (out.length < 2 && p.generated_description) {
      String(p.generated_description).split(/\n|•/).map(x => x.trim()).filter(x => x.length > 8 && x.length < 90)
        .forEach(x => { if (out.length < max && out.indexOf(x) === -1) out.push(x.replace(/^[-–*✅]\s*/, '')); });
    }
    return out;
  }
  function title(p) { return (p.generated_title || p.name || '').trim(); }
  function priceText(p) { return p.price ? HS.money(p.price.v, p.price.c) : ''; }

  function buildText(tpl) {
    const ps = state.products, url = state.storeUrl;
    const lines = [];
    if (ps.length === 1) {
      const p = ps[0];
      lines.push('📷 *' + title(p) + '*' + (p.model_code && title(p).indexOf(p.model_code) === -1 ? ' (' + p.model_code + ')' : ''));
      if (tpl === 'detail') {
        const h = highlights(p, 4);
        if (h.length) { lines.push(''); h.forEach(x => lines.push('✅ ' + x)); }
      }
      if (priceText(p)) { lines.push(''); lines.push('💰 *' + priceText(p) + '*'); }
      if (tpl === 'detail') { lines.push(''); lines.push('🛒 ' + t('sh.order')); }
      if (url) lines.push('🔗 ' + url);
    } else {
      lines.push('🛍️ *' + t('sh.newProducts') + '*');
      const shown = ps.slice(0, 15);
      shown.forEach((p, i) => {
        lines.push('');
        lines.push((i + 1) + ') *' + title(p) + '*' + (priceText(p) ? ' — *' + priceText(p) + '*' : ''));
        if (tpl === 'detail') { const h = highlights(p, 2); if (h.length) lines.push('   ✅ ' + h.join(' · ')); }
      });
      if (ps.length > shown.length) { lines.push(''); lines.push('… ' + fmt(t('sh.more'), { n: ps.length - shown.length })); }
      lines.push('');
      if (tpl === 'detail') lines.push('🛒 ' + t('sh.order'));
      if (url) lines.push('🔗 ' + t('sh.store') + ': ' + url);
    }
    return lines.join('\n');
  }
  function hashtags() {
    const tags = new Set();
    const add = (s) => {
      const w = String(s || '').replace(/İ/g, 'i').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
      if (w.length >= 3 && w.length <= 30) tags.add('#' + w);
    };
    state.products.forEach(p => {
      add(p.brand);
      String(p.category || '').split(/[\/>,|]/).forEach(add);
      (title(p).split(/\s+/).filter(w => w.length >= 4 && !/^\d/.test(w)).slice(0, 3)).forEach(add);
    });
    return Array.from(tags).slice(0, 12).join(' ');
  }
  function textFor(channel) {
    let s = document.getElementById('hsShText').value;
    if (channel === 'instagram' || channel === 'facebook') {
      s = s.replace(/\*/g, '');
      const h = hashtags();
      if (h && s.indexOf(h) === -1) s += '\n\n' + h;
    }
    return s;
  }

  // ---------- Resimler (paylaşım için dosyaya çevrilir) ----------
  function isOwnStorage(u) {
    try { return new URL(u).hostname === new URL(HS.SUPABASE_URL).hostname; } catch (e) { return false; }
  }
  async function fetchBlob(u) {
    if (isOwnStorage(u)) {
      const r = await fetch(u);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.blob();
    }
    try { // bazı siteler doğrudan izin verir
      const r = await fetch(u, { mode: 'cors' });
      if (r.ok) { const b = await r.blob(); if (b.type.indexOf('image/') === 0) return b; }
    } catch (e) {}
    const r = await fetch(HS.SUPABASE_URL + '/functions/v1/image-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + HS.SUPABASE_KEY, 'apikey': HS.SUPABASE_KEY },
      body: JSON.stringify({ url: u })
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.blob();
  }
  // Her uygulama JPG'yi sorunsuz kabul eder (WebP bazen çıkartma gibi gider): JPG'ye çevir
  async function toJpeg(blob) {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.9));
  }
  async function prepareFiles() {
    const my = state; // pencere kapanırsa ya da yenisi açılırsa dur
    const urls = [];
    state.products.forEach(p => {
      const per = state.products.length === 1 ? MAX_IMAGES : Math.max(1, Math.floor(MAX_IMAGES / state.products.length));
      p.images.slice(0, per).forEach(u => { if (urls.length < MAX_IMAGES) urls.push({ u, p }); });
    });
    state.files = []; state.failed = 0;
    const total = urls.length;
    let done = 0;
    renderPrep(0, total);
    for (const x of urls) {
      if (state !== my) return;
      try {
        const jpg = await toJpeg(await fetchBlob(x.u));
        const base = (x.p.model_code || title(x.p) || 'urun').replace(/[^\w\-]+/g, '-').slice(0, 40);
        state.files.push(new File([jpg], base + '-' + (state.files.length + 1) + '.jpg', { type: 'image/jpeg' }));
      } catch (e) { console.warn('resim alınamadı', x.u, e); state.failed++; }
      done++;
      if (state !== my) return;
      renderPrep(done, total);
    }
    if (state !== my) return;
    state.ready = true;
    renderPrep(done, total);
    updateGo();
  }
  function renderPrep(d, total) {
    const el = document.getElementById('hsShPrep');
    if (!el) return;
    if (!total) { el.textContent = ''; return; }
    el.innerHTML = state.ready
      ? '✓ ' + esc(t('sh.ready')) + ' · ' + esc(fmt(t('sh.images'), { n: state.files.length })) +
        (state.failed ? '<div class="hs-sh-msg">' + esc(fmt(t('sh.imgFail'), { n: state.failed })) + '</div>' : '')
      : esc(fmt(t('sh.preparing'), { d: d, t: total }));
  }

  // ---------- Pencere ----------
  function selectedChannels() {
    return CHANNELS.filter(c => { const el = document.getElementById('hsShC_' + c.id); return el && el.checked; }).map(c => c.id);
  }
  function chName(id) { const c = CHANNELS.find(x => x.id === id); return c ? c.name : id; }
  function chIcon(id, size) {
    const c = CHANNELS.find(x => x.id === id);
    return '<span class="hs-sh-ic" style="background:' + c.color + ';' + (size ? 'width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.6) + 'px;border-radius:6px;' : '') + '"><i class="' + c.icon + '"></i></span>';
  }

  function updateGo() {
    const btn = document.getElementById('hsShGo');
    const st = document.getElementById('hsShSt');
    if (!btn) return;
    const sel = state.queue ? state.queue : selectedChannels();
    const pending = sel.filter(c => state.done.indexOf(c) === -1);
    btn.disabled = !state.ready || !sel.length;
    if (!sel.length) { btn.textContent = t('sh.share'); st.innerHTML = ''; return; }
    if (!pending.length) {
      btn.innerHTML = esc(t('sh.done'));
      btn.disabled = true;
    } else if (state.done.length) {
      btn.innerHTML = chIcon(pending[0], 22) + ' ' + esc(fmt(t('sh.next'), { c: chName(pending[0]) }));
    } else if (sel.length === 1) {
      btn.innerHTML = chIcon(sel[0], 22) + ' ' + esc(fmt(t('sh.shareOn'), { c: chName(sel[0]) }));
    } else {
      btn.textContent = t('sh.share');
    }
    st.innerHTML = sel.length > 1 || state.done.length
      ? sel.map(c => esc(chName(c)) + ': ' + (state.done.indexOf(c) !== -1 ? '<b>' + esc(t('sh.stSent')) + '</b>' : esc(t('sh.stWait')))).join(' · ')
      : '';
  }

  function onChannelToggle() {
    const sel = selectedChannels();
    document.querySelectorAll('.hs-sh-c').forEach(el => el.classList.toggle('on', el.querySelector('input').checked));
    if (sel.length) saveChannels(sel);
    state.queue = null; state.done = [];
    updateGo();
  }

  function close() {
    const b = document.getElementById('hsShBack');
    if (b) b.remove();
    state = null;
  }

  function isMobile() { return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent); }

  async function copyText(s) {
    try { await navigator.clipboard.writeText(s); return true; } catch (e) {}
    try {
      const ta = document.createElement('textarea'); ta.value = s; document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch (e) { return false; }
  }
  function downloadFiles() {
    state.files.forEach((f, i) => {
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(f); a.download = f.name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      }, i * 250);
    });
  }

  // Tek bir kanalda paylaş (kullanıcının tıklamasıyla çağrılır)
  async function shareOn(channel) {
    const text = textFor(channel);
    const msg = document.getElementById('hsShMsg');
    msg.textContent = '';
    const files = state.files;
    const canFiles = files.length && navigator.canShare && navigator.canShare({ files: files });

    if (isMobile() && (canFiles || navigator.share)) {
      // Bazı telefonlarda resimle birlikte yazı uygulamaya geçmiyor: yazıyı ayrıca panoya da kopyala
      // (beklemeden: paylaşım menüsü tıklamanın hemen ardından açılmalı)
      copyText(text);
      try {
        const data = canFiles ? { files: files, text: text } : { text: text };
        await navigator.share(data);
        msg.textContent = t('sh.copied');
        return true;
      } catch (e) {
        if (e && e.name === 'AbortError') { msg.textContent = t('sh.cancelled'); return false; }
        // resimlerle olmadıysa yazıyla dene
        try { await navigator.share({ text: text }); return true; } catch (e2) { /* aşağıdaki yola düş */ }
      }
    }

    // Bilgisayar (ya da paylaşım menüsü olmayan tarayıcı)
    await copyText(text);
    if (files.length) downloadFiles();
    const link = state.storeUrl || '';
    let url = '';
    if (channel === 'whatsapp') url = (isMobile() ? 'https://wa.me/?text=' : 'https://web.whatsapp.com/send?text=') + encodeURIComponent(text);
    else if (channel === 'telegram') url = 'https://t.me/share/url?url=' + encodeURIComponent(link || ' ') + '&text=' + encodeURIComponent(text);
    else if (channel === 'facebook') url = link ? 'https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(link) : 'https://www.facebook.com/';
    else if (channel === 'instagram') url = 'https://www.instagram.com/';
    if (url) window.open(url, '_blank', 'noopener');
    msg.textContent = channel === 'instagram' ? t('sh.igDesk') : t('sh.deskHint');
    return true;
  }

  async function onGo() {
    if (!state || !state.ready) return;
    if (!state.queue) {
      const sel = selectedChannels();
      if (!sel.length) { document.getElementById('hsShMsg').textContent = t('sh.pickOne'); return; }
      state.queue = sel; state.done = [];
    }
    const next = state.queue.find(c => state.done.indexOf(c) === -1);
    if (!next) return;
    const ok = await shareOn(next);
    if (ok) state.done.push(next);
    updateGo();
  }

  function renderModal() {
    const n = state.products.length;
    const chosen = loadChannels();
    const thumbs = [];
    state.products.forEach(p => p.images.slice(0, n === 1 ? 10 : 1).forEach(u => { if (thumbs.length < 10) thumbs.push(u); }));
    const box = document.getElementById('hsShBody');
    box.innerHTML =
      (thumbs.length ? '<div class="hs-sh-imgs">' + thumbs.map(u => '<img src="' + esc(u) + '" referrerpolicy="no-referrer" loading="lazy" onerror="this.remove()">').join('') + '</div>' : '') +
      '<div class="hs-sh-note" id="hsShPrep"></div>' +
      '<div class="hs-sh-label">' + esc(t('sh.channels')) + '</div>' +
      '<div class="hs-sh-ch">' + CHANNELS.map(c =>
        '<label class="hs-sh-c' + (chosen.indexOf(c.id) !== -1 ? ' on' : '') + '">' +
          '<input type="checkbox" id="hsShC_' + c.id + '"' + (chosen.indexOf(c.id) !== -1 ? ' checked' : '') + '>' +
          chIcon(c.id) + '<span class="hs-sh-cn">' + esc(c.name) + '</span></label>').join('') + '</div>' +
      '<div class="hs-sh-note">' + esc(t('sh.remember')) + '</div>' +
      '<div class="hs-sh-row"><div class="hs-sh-label" style="margin:0">' + esc(t('sh.text')) + '</div>' +
        '<select id="hsShTpl"><option value="detail">' + esc(t('sh.tplDetail')) + '</option><option value="short">' + esc(t('sh.tplShort')) + '</option></select></div>' +
      '<div style="margin-top:8px"><textarea id="hsShText"></textarea></div>' +
      '<div class="hs-sh-note">' + esc(t('sh.textNote')) + '</div>' +
      '<button class="hs-sh-go" id="hsShGo" disabled></button>' +
      '<div class="hs-sh-st" id="hsShSt"></div>' +
      '<div class="hs-sh-msg" id="hsShMsg"></div>';
    document.getElementById('hsShTitle').textContent = n === 1 ? t('sh.title') : fmt(t('sh.titleN'), { n: n });
    const tplSel = document.getElementById('hsShTpl');
    tplSel.value = state.template;
    document.getElementById('hsShText').value = buildText(state.template);
    tplSel.addEventListener('change', () => { state.template = tplSel.value; document.getElementById('hsShText').value = buildText(state.template); });
    CHANNELS.forEach(c => document.getElementById('hsShC_' + c.id).addEventListener('change', onChannelToggle));
    document.getElementById('hsShGo').addEventListener('click', onGo);
    updateGo();
  }

  async function open(ids) {
    ids = (ids || []).map(String).filter(Boolean);
    if (!ids.length) return;
    injectAssets();
    close();
    state = { products: [], files: [], failed: 0, ready: false, queue: null, done: [], template: 'detail', storeUrl: '' };
    const back = document.createElement('div');
    back.className = 'hs-sh-back'; back.id = 'hsShBack';
    back.innerHTML =
      '<div class="hs-sh" role="dialog" aria-modal="true">' +
        '<div class="hs-sh-head"><div class="hs-sh-title" id="hsShTitle">' + esc(t('sh.title')) + '</div>' +
        '<button class="hs-sh-x" id="hsShX" title="' + esc(t('sh.close')) + '">✕</button></div>' +
        '<div id="hsShBody"><div class="hs-sh-note">' + esc(t('sh.loading')) + '</div></div>' +
      '</div>';
    document.body.appendChild(back);
    back.addEventListener('click', (e) => { if (e.target === back) close(); });
    document.getElementById('hsShX').addEventListener('click', close);
    const my = state;
    try {
      const d = await loadData(ids);
      if (state !== my) return;
      if (!d.products.length) { document.getElementById('hsShBody').innerHTML = '<div class="hs-sh-note">' + esc(t('sh.noProducts')) + '</div>'; return; }
      state.products = d.products; state.storeUrl = d.storeUrl;
      renderModal();
      await prepareFiles();
    } catch (e) {
      console.error(e);
      if (state === my) document.getElementById('hsShBody').innerHTML = '<div class="hs-sh-msg">' + esc(e.message || String(e)) + '</div>';
    }
  }

  window.HSShare = { open: open, close: close, channels: CHANNELS };
})();
