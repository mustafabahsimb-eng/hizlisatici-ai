/* ============================================================
   HızlıSatıcı AI - Ortak yardımcı dosya (app.js)
   Kullanım (her sayfada, supabase-js'ten SONRA):
     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
     <script src="app.js"></script>
   ============================================================ */
(function () {
  'use strict';

  // ---------- Bağlantı ----------
  const SUPABASE_URL = 'https://ytucdrrgxsjhrqmaxckt.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_xJXwqD9NmwU70kv2eFKk0A_O2q9gOcD';

  if (!window.supabase) {
    console.error('HS: supabase-js, app.js dosyasından ÖNCE yüklenmeli.');
    return;
  }
  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  // ---------- Diller ----------
  const SUPPORTED = ['tr', 'en'];
  const LOCALES = { tr: 'tr-TR', en: 'en-US' };
  const LANG_NAMES = { tr: 'Türkçe', en: 'English' };

  const FLAGS = {
    tr: '<svg viewBox="0 0 30 20" width="22" height="15" aria-hidden="true">' +
        '<rect width="30" height="20" fill="#E30A17"/>' +
        '<circle cx="10.6" cy="10" r="5" fill="#fff"/>' +
        '<circle cx="11.85" cy="10" r="4" fill="#E30A17"/>' +
        '<polygon fill="#fff" points="14.2,10 15.69,9.48 15.72,7.91 16.67,9.16 18.18,8.71 17.28,10 18.18,11.29 16.67,10.84 15.72,12.09 15.69,10.52"/>' +
        '</svg>',
    en: '<svg viewBox="0 0 60 30" width="22" height="15" aria-hidden="true">' +
        '<rect width="60" height="30" fill="#012169"/>' +
        '<path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" stroke-width="6"/>' +
        '<path d="M0,0 L60,30 M60,0 L0,30" stroke="#C8102E" stroke-width="2"/>' +
        '<path d="M30,0 V30 M0,15 H60" stroke="#fff" stroke-width="10"/>' +
        '<path d="M30,0 V30 M0,15 H60" stroke="#C8102E" stroke-width="6"/>' +
        '</svg>'
  };

  // ---------- Ortak sözlük ----------
  const dict = {
    tr: {
      'common.back': '← Panele dön',
      'common.logout': 'Çıkış yap',
      'common.save': 'Kaydet',
      'common.saving': 'Kaydediliyor...',
      'common.saved': '✓ Kaydedildi',
      'common.loading': 'Yükleniyor...',
      'common.error': 'Bir hata oluştu',
      'common.cancel': 'Vazgeç',
      'common.delete': 'Sil',
      'common.yes': 'Evet',
      'common.no': 'Hayır',
      'common.language': 'Dil'
    },
    en: {
      'common.back': '← Back to dashboard',
      'common.logout': 'Log out',
      'common.save': 'Save',
      'common.saving': 'Saving...',
      'common.saved': '✓ Saved',
      'common.loading': 'Loading...',
      'common.error': 'Something went wrong',
      'common.cancel': 'Cancel',
      'common.delete': 'Delete',
      'common.yes': 'Yes',
      'common.no': 'No',
      'common.language': 'Language'
    }
  };

  function addDict(d) {
    Object.keys(d || {}).forEach(function (l) {
      dict[l] = dict[l] || {};
      Object.assign(dict[l], d[l]);
    });
  }

  // ---------- Güvenli tarayıcı hafızası ----------
  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* yok say */ } }

  function detectLang() {
    const saved = safeGet('hs_lang');
    if (SUPPORTED.indexOf(saved) !== -1) return saved;
    const nav = ((navigator.language || 'tr') + '').slice(0, 2).toLowerCase();
    return SUPPORTED.indexOf(nav) !== -1 ? nav : 'tr';
  }

  let lang = detectLang();
  let currentUser = null;
  let profile = null;

  // ---------- Çeviri ----------
  function t(key, vars) {
    let s = (dict[lang] && dict[lang][key] != null) ? dict[lang][key]
          : (dict.tr[key] != null ? dict.tr[key] : key);
    if (vars) {
      s = String(s).replace(/\{(\w+)\}/g, function (m, k) {
        return vars[k] != null ? vars[k] : m;
      });
    }
    return s;
  }

  function applyI18n(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
    root.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    });
    root.querySelectorAll('[data-i18n-aria]').forEach(function (el) {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
    });
    document.documentElement.lang = lang;
  }

  async function setLang(l, opts) {
    if (SUPPORTED.indexOf(l) === -1) return;
    lang = l;
    safeSet('hs_lang', l);
    applyI18n();
    renderSwitcher();
    window.dispatchEvent(new CustomEvent('hs:langchange', { detail: { lang: l } }));

    if (!(opts && opts.skipSave) && currentUser) {
      const res = await db.from('user_profiles')
        .update({ ui_language: l })
        .eq('user_id', currentUser.id);
      if (res.error) console.warn('HS: dil profile kaydedilemedi', res.error);
      if (profile) profile.ui_language = l;
    }
  }

  // ---------- Giriş ve profil ----------
  async function requireAuth() {
    const res = await db.auth.getSession();
    const session = res.data && res.data.session;
    if (!session) {
      window.location.href = 'index.html';
      return null;
    }
    currentUser = session.user;
    return session;
  }

  async function loadProfile() {
    if (!currentUser) return null;
    const res = await db.from('user_profiles')
      .select('*')
      .eq('user_id', currentUser.id)
      .maybeSingle();
    if (res.error) {
      console.warn('HS: profil okunamadı', res.error);
      return null;
    }
    profile = res.data || null;
    if (profile && profile.ui_language && profile.ui_language !== lang &&
        SUPPORTED.indexOf(profile.ui_language) !== -1) {
      await setLang(profile.ui_language, { skipSave: true });
    }
    return profile;
  }

  // Sayfa başlangıcı: HS.init() ya da HS.init({ auth: false }) (girişsiz sayfalar için)
  async function init(options) {
    applyI18n();
    mountSwitcher();
    if (options && options.auth === false) {
      return { session: null, user: null, profile: null };
    }
    const session = await requireAuth();
    if (!session) return null;
    await loadProfile();
    return { session: session, user: currentUser, profile: profile };
  }

  async function logout() {
    // Supabase yanıt vermese bile en geç 1,5 sn içinde çıkış yapılır
    try {
      await Promise.race([
        db.auth.signOut({ scope: 'local' }),
        new Promise(function (r) { setTimeout(r, 1500); })
      ]);
    } catch (e) { /* yok say */ }
    // Tarayıcıdaki oturum anahtarını elle de sil
    try {
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf('sb-') === 0 && k.indexOf('-auth-token') !== -1) localStorage.removeItem(k);
      });
    } catch (e) { /* yok say */ }
    currentUser = null;
    profile = null;
    window.location.replace('index.html');
  }

  // ---------- Biçimlendirme ----------
  function homeCurrency() {
    return ((profile && profile.home_currency) || 'TRY').trim();
  }

  function money(amount, currency) {
    if (amount == null || isNaN(amount)) return '-';
    const cur = (currency || homeCurrency()).trim().toUpperCase();
    try {
      return new Intl.NumberFormat(LOCALES[lang], {
        style: 'currency', currency: cur,
        minimumFractionDigits: 2, maximumFractionDigits: 2
      }).format(Number(amount));
    } catch (e) {
      return Number(amount).toFixed(2) + ' ' + cur;
    }
  }

  function number(n, digits) {
    if (n == null || isNaN(n)) return '-';
    const d = digits == null ? 0 : digits;
    return new Intl.NumberFormat(LOCALES[lang], {
      minimumFractionDigits: d, maximumFractionDigits: d
    }).format(Number(n));
  }

  function percent(n, digits) {
    if (n == null || isNaN(n)) return '-';
    const d = digits == null ? 1 : digits;
    return new Intl.NumberFormat(LOCALES[lang], {
      style: 'percent', minimumFractionDigits: d,
