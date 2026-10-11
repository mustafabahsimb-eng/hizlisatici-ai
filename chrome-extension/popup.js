// Seltigo eklentisi - açılır pencere
// Akış: (giriş) -> açık sekmedeki ürünü kendi tarayıcında oku -> önizleme -> "Seltigo'ya ekle" -> product-ingest
// Ürün kaynağı kuralı: AliExpress ürününde kaynak sorulur (AliExpress / Kendi stoğum); gerisi Kendi stoğum.
const SUPABASE_URL = 'https://ytucdrrgxsjhrqmaxckt.supabase.co';
const SUPABASE_KEY = 'sb_publishable_xJXwqD9NmwU70kv2eFKk0A_O2q9gOcD'; // herkese açık olacak şekilde tasarlanmış anahtar
const SITE = 'https://mustafabahsimb-eng.github.io/hizlisatici-ai';

const T = {
  loginHint: 'Seltigo hesabınla giriş yap',
  emailPh: 'E-posta',
  passPh: 'Şifre',
  login: 'Giriş yap',
  logout: 'Çıkış',
  loginFail: 'Giriş yapılamadı: ',
  reading: 'Ürün okunuyor...',
  readingServer: 'Ürün bilgisi tamamlanıyor...',
  noProduct: 'Bu sayfada ürün bulunamadı. Bir ürün sayfasını açıp tekrar dene.',
  add: "Seltigo'ya ekle",
  adding: 'Ekleniyor...',
  added: '✓ Seltigo mağazana eklendi.',
  edit: '✏️ Ürünü düzenle',
  variants: '{n} seçenek',
  images: '{n} görsel',
  aeQ: 'AliExpress ürünleri için kaynak (AliExpress seçilirse siparişler otomatik AliExpress\'e verilir):',
  aeA: 'AliExpress',
  aeO: 'Kendi stoğum',
  needAe: 'AliExpress ürünleri için kaynağı seç.',
  consent: 'Bu ürün görsellerini, açıklamalarını ve bilgilerini kullanma hakkım olduğunu (ör. tedarikçimin/bayisi olduğum firmanın ürünleri) ve bu içeriklerden doğacak sorumluluğun bana ait olduğunu kabul ediyorum.',
  imgTerms: 'Orijinal ürün satıyorum, görsel kullanım sorumluluğu bana aittir',
  needConsent: 'Devam etmek için onay kutularını işaretle.',
  error: 'Hata: ',
};
const $ = (id) => document.getElementById(id);
const fmt = (s, v) => String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? v[k] : m));
let session = null;
let item = null;
let tabId = null;

// ---------- Oturum ----------
async function saveSession(s) { session = s; await chrome.storage.local.set({ session: s }); }
async function auth(body, grant) {
  const r = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=' + grant, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY }, body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(d.error_description || d.msg || d.error || ('HTTP ' + r.status));
  await saveSession({ access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (d.expires_in || 3600) * 1000, email: d.user && d.user.email });
}
async function token() {
  if (!session) return null;
  if (Date.now() > session.expires_at - 60000) {
    try { await auth({ refresh_token: session.refresh_token }, 'refresh_token'); } catch (e) { await chrome.storage.local.remove('session'); session = null; return null; }
  }
  return session.access_token;
}
async function callFn(name, payload) {
  const tk = await token();
  const r = await fetch(SUPABASE_URL + '/functions/v1/' + name, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: 'Bearer ' + tk }, body: JSON.stringify(payload),
  });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, d };
}

// ---------- Görünüm ----------
function show(view) { $('loginView').style.display = view === 'login' ? '' : 'none'; $('mainView').style.display = view === 'main' ? '' : 'none'; $('logoutBtn').style.display = view === 'main' ? '' : 'none'; }
function money(v, c) { if (!(v > 0)) return '–'; try { return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: c || 'TRY' }).format(v); } catch (e) { return v + ' ' + (c || ''); } }
function renderPreview() {
  $('status').textContent = '';
  $('preview').style.display = '';
  $('pImg').src = (item.images && item.images[0]) || '';
  $('pImg').style.visibility = item.images && item.images[0] ? 'visible' : 'hidden';
  $('pName').textContent = item.name;
  $('pPrice').textContent = money(item.price, item.currency);
  const meta = [];
  if (item.variants && item.variants.length) meta.push(fmt(T.variants, { n: item.variants.length }));
  if (item.images && item.images.length) meta.push(fmt(T.images, { n: item.images.length }));
  meta.push(new URL(item.url).hostname.replace(/^www\./, ''));
  $('pMeta').textContent = meta.join(' · ');
  $('aeBox').style.display = item.source_platform === 'aliexpress' ? '' : 'none';
}

// ---------- Ürünü oku ----------
async function readProduct() {
  $('status').textContent = T.reading;
  let res = null;
  if (Number.isFinite(tabId)) try {
    // İzin yoksa ya da sayfa yanıt vermezse 5 sn içinde sunucudaki okuyucuya geçilir
    const out = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId }, func: seltigoExtract }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
    ]);
    res = out && out[0] && out[0].result;
  } catch (e) { res = null; }
  const tab = Number.isFinite(tabId) ? await chrome.tabs.get(tabId).catch(() => null) : null;
  // Simgeye tıklanınca Chrome o sekmenin adresini verir (activeTab); test için ?url= de kabul edilir
  const pageUrl = (res && res.url) || (tab && tab.url) || new URLSearchParams(location.search).get('url') || '';
  if (!pageUrl) { $('status').textContent = T.noProduct; return; }
  if (!res || res.needServer) {
    $('status').textContent = T.readingServer;
    let d = null;
    try { d = (await callFn('product-import', { url: pageUrl, language: 'tr' })).d; } catch (e) { $('err').textContent = T.error + e.message; }
    if (d && d.kind === 'product' && d.item && d.item.name) {
      // Tarayıcıdan okunanlar (TL fiyat vb.) öncelikli; eksikler sunucudan
      const s = d.item;
      res = Object.assign({}, s, res && res.name && res.price ? res : {}, {
        images: (res && res.images && res.images.length) ? res.images : (s.images || []),
        variants: (res && res.variants && res.variants.length) ? res.variants : (s.variants || []),
        specs: (res && res.specs && res.specs.length) ? res.specs : (s.specs || []),
        source_platform: (res && res.source_platform !== 'web' && res.source_platform) || s.source_platform || 'web',
        source_item_id: (res && res.source_item_id) || s.source_item_id || null,
        url: pageUrl,
      });
    }
  }
  if (!res || !res.name) { $('status').textContent = T.noProduct; return; }
  delete res.needServer;
  item = res;
  renderPreview();
}

// ---------- Ekle ----------
async function addProduct(extra) {
  $('err').textContent = '';
  const aeSel = document.querySelector('input[name="aeSrc"]:checked');
  if (item.source_platform === 'aliexpress' && !aeSel) { $('err').textContent = T.needAe; return; }
  const btn = $('addBtn');
  btn.disabled = true; btn.textContent = T.adding;
  try {
    const { d } = await callFn('product-ingest', Object.assign({
      items: [item], sourceUrl: item.url, via: 'chrome-extension', aeSource: aeSel ? aeSel.value : undefined,
    }, extra || {}));
    if (d && (d.needConsent || d.needImageTerms)) {
      $('consentBox').style.display = '';
      $('consentRow').style.display = d.needConsent ? '' : 'none';
      $('imgTermsRow').style.display = d.needImageTerms ? '' : 'none';
      $('err').textContent = T.needConsent;
      return;
    }
    if (!d || !d.ok) throw new Error((d && d.error) || 'Kaydedilemedi');
    const p = d.products[0];
    $('preview').style.display = 'none';
    $('done').style.display = '';
    $('doneTxt').textContent = T.added;
    $('editLink').href = SITE + '/urun-duzenle.html?id=' + p.id;
    $('editLink').textContent = T.edit;
  } catch (e) {
    $('err').textContent = T.error + e.message;
  } finally {
    btn.disabled = false; btn.textContent = T.add;
  }
}

// ---------- Başlat ----------
(async function start() {
  $('loginHint').textContent = T.loginHint; $('email').placeholder = T.emailPh; $('password').placeholder = T.passPh;
  $('loginBtn').textContent = T.login; $('logoutBtn').textContent = T.logout; $('addBtn').textContent = T.add;
  $('aeQ').textContent = T.aeQ; $('aeA').textContent = T.aeA; $('aeO').textContent = T.aeO;
  $('consentTxt').textContent = T.consent; $('imgTermsTxt').textContent = T.imgTerms;

  // Sekme: normalde açık sekme; test için ?tab=<id>
  const q = new URLSearchParams(location.search).get('tab');
  if (q) tabId = Number(q);
  else { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = tab && tab.id; }

  const st = await chrome.storage.local.get('session');
  session = st.session || null;
  $('loginBtn').addEventListener('click', async () => {
    $('loginErr').textContent = '';
    try { await auth({ email: $('email').value.trim(), password: $('password').value }, 'password'); show('main'); readProduct(); }
    catch (e) { $('loginErr').textContent = T.loginFail + e.message; }
  });
  $('logoutBtn').addEventListener('click', async () => { await chrome.storage.local.remove('session'); session = null; show('login'); });
  $('addBtn').addEventListener('click', () => {
    const extra = {};
    if ($('consentBox').style.display !== 'none') { extra.consent = $('consent').checked; extra.imageTerms = $('imgTerms').checked; }
    addProduct(extra);
  });
  if (!(await token())) { show('login'); return; }
  show('main');
  readProduct();
})();
