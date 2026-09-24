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
    // Sunucu hata verirse de tarayıcıdaki oturum MUTLAKA silinsin
    try {
      const res = await db.auth.signOut();
      if (res && res.error) await db.auth.signOut({ scope: 'local' });
    } catch (e) {
      try { await db.auth.signOut({ scope: 'local' }); } catch (e2) { /* yok say */ }
    }
    try {
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf('sb-') === 0 && k.indexOf('-auth-token') !== -1) localStorage.removeItem(k);
      });
    } catch (e) { /* yok say */ }
    currentUser = null;
    profile = null;
    window.location.href = 'index.html';
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
      style: 'percent', minimumFractionDigits: d, maximumFractionDigits: d
    }).format(Number(n) / 100);
  }

  function date(value, withTime) {
    if (!value) return '-';
    const d = new Date(value);
    if (isNaN(d.getTime())) return '-';
    const opts = withTime
      ? { dateStyle: 'medium', timeStyle: 'short' }
      : { dateStyle: 'medium' };
    if (profile && profile.timezone) opts.timeZone = profile.timezone;
    try {
      return d.toLocaleString(LOCALES[lang], opts);
    } catch (e) {
      delete opts.timeZone;
      return d.toLocaleString(LOCALES[lang], opts);
    }
  }

  // ---------- Döviz ----------
  const fxCache = {};

  async function fxRate(from, to) {
    const f = (from || '').trim().toUpperCase();
    const tt = (to || '').trim().toUpperCase();
    if (!f || !tt) return null;
    if (f === tt) return 1;
    const key = f + '>' + tt;
    if (fxCache[key] !== undefined) return fxCache[key];
    const res = await db.rpc('fx_rate', { p_from: f, p_to: tt, p_date: null });
    const rate = (res.error || res.data == null) ? null : Number(res.data);
    fxCache[key] = rate;
    return rate;
  }

  async function convert(amount, from, to) {
    if (amount == null || isNaN(amount)) return null;
    const r = await fxRate(from, to || homeCurrency());
    return r == null ? null : Number(amount) * r;
  }

  // ---------- Güvenlik ----------
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  // ---------- Bayrak düğmesi ----------
  function injectStyles() {
    if (document.getElementById('hsLangStyles')) return;
    const css =
      '.hs-lang{position:relative;display:inline-flex;align-items:center;margin-left:12px;}' +
      '.hs-lang-btn{display:flex;align-items:center;gap:6px;background:transparent;border:1px solid #2a3040;' +
      'color:#cfd4de;padding:6px 10px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;line-height:1;}' +
      '.hs-lang-btn:hover{border-color:#3a4258;color:#fff;}' +
      '.hs-lang-btn svg,.hs-lang-item svg{border-radius:2px;flex-shrink:0;display:block;}' +
      '.hs-lang-menu{position:absolute;right:0;top:calc(100% + 6px);background:#141821;border:1px solid #2a3040;' +
      'border-radius:10px;padding:6px;min-width:150px;z-index:1000;display:none;box-shadow:0 8px 24px rgba(0,0,0,.4);}' +
      '.hs-lang.open .hs-lang-menu{display:block;}' +
      '.hs-lang-item{display:flex;align-items:center;gap:10px;width:100%;background:transparent;border:none;' +
      'color:#e6e8ee;padding:8px 10px;border-radius:6px;font-size:13px;cursor:pointer;text-align:left;}' +
      '.hs-lang-item:hover{background:#1c212c;}' +
      '.hs-lang-item.active{color:#6ee7b7;font-weight:600;}';
    const style = document.createElement('style');
    style.id = 'hsLangStyles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function renderSwitcher() {
    const wrap = document.getElementById('hsLangSwitcher');
    if (!wrap) return;
    wrap.innerHTML =
      '<button type="button" class="hs-lang-btn" aria-haspopup="true" aria-label="' + escapeHtml(t('common.language')) + '">' +
        FLAGS[lang] + '<span>' + lang.toUpperCase() + '</span>' +
      '</button>' +
      '<div class="hs-lang-menu" role="menu">' +
        SUPPORTED.map(function (l) {
          return '<button type="button" role="menuitem" class="hs-lang-item' + (l === lang ? ' active' : '') +
                 '" data-lang="' + l + '">' + FLAGS[l] + '<span>' + LANG_NAMES[l] + '</span></button>';
        }).join('') +
      '</div>';

    wrap.querySelector('.hs-lang-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      wrap.classList.toggle('open');
    });
    wrap.querySelectorAll('.hs-lang-item').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        wrap.classList.remove('open');
        setLang(btn.getAttribute('data-lang'));
      });
    });
  }

  function mountSwitcher() {
    injectStyles();
    if (document.getElementById('hsLangSwitcher')) {
      renderSwitcher();
      return;
    }
    const host = document.getElementById('langSwitcherHost') ||
                 document.querySelector('header .header-right') ||
                 document.querySelector('header');
    if (!host) return;
    const wrap = document.createElement('div');
    wrap.id = 'hsLangSwitcher';
    wrap.className = 'hs-lang';
    host.appendChild(wrap);
    renderSwitcher();
  }

  document.addEventListener('click', function () {
    const wrap = document.getElementById('hsLangSwitcher');
    if (wrap) wrap.classList.remove('open');
  });

  // ---------- Dışa açılan ----------
  const HS = {
    SUPABASE_URL: SUPABASE_URL,
    SUPABASE_KEY: SUPABASE_KEY,
    db: db,
    init: init,
    requireAuth: requireAuth,
    loadProfile: loadProfile,
    logout: logout,
    t: t,
    i18n: { add: addDict, apply: applyI18n },
    setLang: setLang,
    money: money,
    number: number,
    percent: percent,
    date: date,
    fxRate: fxRate,
    convert: convert,
    escapeHtml: escapeHtml,
    homeCurrency: homeCurrency,
    supportedLangs: SUPPORTED.slice()
  };
  Object.defineProperty(HS, 'lang', { get: function () { return lang; } });
  Object.defineProperty(HS, 'user', { get: function () { return currentUser; } });
  Object.defineProperty(HS, 'profile', { get: function () { return profile; } });

  window.HS = HS;
})();
