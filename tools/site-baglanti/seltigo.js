/**
 * Seltigo bağlantı kodu — JavaScript (Node.js 18+, ek paket gerekmez)
 *
 * Kurulum (bir kez):
 *  1) Ortam değişkenleri: SELTIGO_API_KEY (slt_live_...), SELTIGO_WEBHOOK_SECRET (whsec_...)
 *     — Seltigo > Sitemi Bağla > "Seltigo bağlantı kodu" bölümünden.
 *  2) Webhook alıcısını sunucuna bağla (Express örneği aşağıda) ve adresini Seltigo'ya yaz; "Deneme gönder"e bas.
 *  3) siteSetStock / siteUpsertProduct / siteDeleteProduct fonksiyonlarını kendi veritabanına göre doldur.
 *  4) Sitede satış olunca seltigoOrder(...), stok elle değişince seltigoStock(...) çağır.
 */
const crypto = require('node:crypto');
const API = 'https://ytucdrrgxsjhrqmaxckt.supabase.co/functions/v1/site-api';
const KEY = process.env.SELTIGO_API_KEY;
const SECRET = process.env.SELTIGO_WEBHOOK_SECRET;

async function seltigo(method, path, body) {
  const r = await fetch(API + path, {
    method, headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
// Sitede satış: items = [{ sku: 'AB-1', quantity: 2, price: 199.9 }, ...]
const seltigoOrder = (orderId, items, customer = {}) => seltigo('POST', '/orders', { external_order_id: String(orderId), items, currency: 'TRY', customer });
// Sitede stok değişti (seçenekli üründe variantSku)
const seltigoStock = (sku, quantity, variantSku) => seltigo('POST', '/stock', { items: [{ sku, quantity, ...(variantSku ? { variant_sku: variantSku } : {}) }] });
// Sitedeki ürünü Seltigo'ya gönder (aynı SKU / barkod varsa güncellenir)
const seltigoProduct = (p) => seltigo('POST', '/products', p);

// ---------- Sitenin kendi işlemleri (doldur) ----------
async function siteSetStock(sku, qty) { /* UPDATE urunler SET stok = qty WHERE stok_kodu = sku */ }
async function siteUpsertProduct(p) { /* p: { id, sku, gtin, name, title, description, price, stock_qty, images[], variants[] } */ }
async function siteDeleteProduct(sku) { /* ürünü yayından kaldır */ }

// ---------- Webhook doğrulama + işleme (Seltigo -> site) ----------
function verifySignature(rawBody, header) {
  const want = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(want), b = Buffer.from(String(header || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function handleSeltigoWebhook(rawBody, signatureHeader) {
  if (!verifySignature(rawBody, signatureHeader)) return { status: 401, body: 'imza geçersiz' };
  const e = JSON.parse(rawBody);
  const d = e.data || {};
  if (e.event === 'stock.updated') await siteSetStock(d.sku, d.stock_qty);
  else if (e.event === 'product.created' || e.event === 'product.updated') {
    const full = await seltigo('GET', '/products/' + d.product_id);
    if (full.status === 200) await siteUpsertProduct(full.body.product);
  } else if (e.event === 'product.deleted') await siteDeleteProduct(d.sku);
  return { status: 200, body: '{"ok":true}' };
}

// Express örneği (ham gövde imza için şart):
//   app.post('/seltigo-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
//     const r = await handleSeltigoWebhook(req.body.toString('utf8'), req.get('X-Seltigo-Signature'));
//     res.status(r.status).send(r.body);
//   });

module.exports = { seltigo, seltigoOrder, seltigoStock, seltigoProduct, handleSeltigoWebhook, verifySignature };
