<?php
/**
 * Seltigo bağlantı kodu — PHP (PHP 7.4+; WordPress / WooCommerce kancaları dosyanın sonunda)
 *
 * Kurulum (bir kez):
 *  1) Bu dosyayı sitene yükle (ör. https://siten.com/seltigo.php).
 *  2) Aşağıdaki iki değeri Seltigo > Sitemi Bağla > "Seltigo bağlantı kodu" bölümünden al:
 *       SELTIGO_API_KEY        (slt_live_... — API anahtarı)
 *       SELTIGO_WEBHOOK_SECRET (whsec_...   — webhook imza anahtarı)
 *  3) Seltigo'da webhook adresine bu dosyanın adresini yaz ve "Deneme gönder"e bas.
 *  4) Aşağıdaki site_* fonksiyonlarını kendi sitenin veritabanına göre doldur (WooCommerce kullanıyorsan hazır).
 *
 * Akış:
 *  - Seltigo'da ürün eklenir / güncellenir / stok değişir  -> bu dosyaya webhook gelir -> site_* fonksiyonları siteyi günceller
 *  - Sitede satış olur                                        -> seltigo_order(...) Seltigo'ya bildirir -> ortak stok düşer,
 *                                                                tüm pazaryerleri güncellenir
 *  - Sitede stok elle değişir                                  -> seltigo_stock(...)
 * Gizli anahtarları bu dosyaya yazmak yerine ortam değişkeninde (getenv) tutman önerilir.
 */

define('SELTIGO_API', 'https://ytucdrrgxsjhrqmaxckt.supabase.co/functions/v1/site-api');
define('SELTIGO_API_KEY', getenv('SELTIGO_API_KEY') ?: 'slt_live_BURAYA');
define('SELTIGO_WEBHOOK_SECRET', getenv('SELTIGO_WEBHOOK_SECRET') ?: 'whsec_BURAYA');

// ---------- Seltigo'ya istek ----------
function seltigo_request($method, $path, $body = null) {
    $ch = curl_init(SELTIGO_API . $path);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . SELTIGO_API_KEY, 'Content-Type: application/json'],
    ]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_UNICODE));
    $res = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return ['status' => $code, 'body' => json_decode($res, true)];
}
// Sitede satış oldu: $items = [['sku' => 'AB-1', 'quantity' => 2, 'price' => 199.90], ...]
function seltigo_order($orderId, array $items, array $customer = []) {
    return seltigo_request('POST', '/orders', ['external_order_id' => (string)$orderId, 'items' => $items, 'currency' => 'TRY', 'customer' => $customer]);
}
// Sitede stok değişti: seltigo_stock('AB-1', 12)  (seçenekli üründe 3. parametre seçenek SKU'su)
function seltigo_stock($sku, $qty, $variantSku = null) {
    $it = ['sku' => $sku, 'quantity' => (int)$qty];
    if ($variantSku) $it['variant_sku'] = $variantSku;
    return seltigo_request('POST', '/stock', ['items' => [$it]]);
}
// Sitedeki ürünü Seltigo'ya gönder (yoksa açılır, aynı SKU / barkod varsa güncellenir)
function seltigo_product(array $p) { return seltigo_request('POST', '/products', $p); }

// ---------- Sitenin kendi işlemleri (kendi sistemine göre doldur) ----------
function site_set_stock($sku, $qty, $productId) {
    if (function_exists('wc_get_product_id_by_sku') && ($id = wc_get_product_id_by_sku($sku))) { wc_update_product_stock($id, (int)$qty, 'set'); return true; }
    // Kendi veritabanın: UPDATE urunler SET stok = :qty WHERE stok_kodu = :sku
    return false;
}
function site_upsert_product(array $p) {
    if (function_exists('wc_get_product_id_by_sku')) {
        $id = $p['sku'] ? wc_get_product_id_by_sku($p['sku']) : 0;
        $prod = $id ? wc_get_product($id) : new WC_Product_Simple();
        $prod->set_name($p['name']);
        if (!$id && $p['sku']) $prod->set_sku($p['sku']);
        if ($p['price'] !== null) $prod->set_regular_price((string)$p['price']);
        if ($p['stock_qty'] !== null) { $prod->set_manage_stock(true); $prod->set_stock_quantity((int)$p['stock_qty']); }
        $prod->save();
        return true;
    }
    return false; // Kendi veritabanın: INSERT ... ON DUPLICATE KEY UPDATE
}
function site_delete_product($sku) {
    if (function_exists('wc_get_product_id_by_sku') && ($id = wc_get_product_id_by_sku($sku))) { wp_trash_post($id); return true; }
    return false;
}

// ---------- Webhook alıcı (Seltigo -> site) ----------
function seltigo_handle_webhook() {
    $raw = file_get_contents('php://input');
    $sig = $_SERVER['HTTP_X_SELTIGO_SIGNATURE'] ?? '';
    $want = 'sha256=' . hash_hmac('sha256', $raw, SELTIGO_WEBHOOK_SECRET);
    if (!hash_equals($want, $sig)) { http_response_code(401); echo 'imza geçersiz'; return; }
    $e = json_decode($raw, true);
    $d = $e['data'] ?? [];
    switch ($e['event'] ?? '') {
        case 'ping': break;
        case 'stock.updated': site_set_stock($d['sku'] ?? '', $d['stock_qty'] ?? 0, $d['product_id'] ?? null); break;
        case 'product.created':
        case 'product.updated':
            // Ürünün tüm bilgisi (görseller, açıklama, seçenekler) için:
            $full = seltigo_request('GET', '/products/' . (int)$d['product_id']);
            if (($full['status'] ?? 0) === 200) site_upsert_product($full['body']['product']);
            break;
        case 'product.deleted': site_delete_product($d['sku'] ?? ''); break;
        case 'order.created': /* başka kanaldan (pazaryeri / Seltigo mağazası) satış: stok zaten stock.updated ile gelir */ break;
    }
    http_response_code(200);
    header('Content-Type: application/json');
    echo '{"ok":true}';
}

// Doğrudan çağrılırsa (webhook adresi bu dosya) alıcı çalışır
if (php_sapi_name() !== 'cli' && realpath(__FILE__) === realpath($_SERVER['SCRIPT_FILENAME'] ?? '') && ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    seltigo_handle_webhook();
    exit;
}

// ---------- WooCommerce kancaları (WordPress'te functions.php'den require edilirse) ----------
if (function_exists('add_action')) {
    // Sitede sipariş ödendi -> Seltigo (ortak stok + pazaryerleri)
    add_action('woocommerce_order_status_processing', function ($orderId) {
        $o = wc_get_order($orderId);
        $items = [];
        foreach ($o->get_items() as $it) {
            $p = $it->get_product();
            $parent = $p && $p->get_parent_id() ? wc_get_product($p->get_parent_id()) : null;
            $items[] = ['sku' => $parent ? $parent->get_sku() : ($p ? $p->get_sku() : ''), 'variant_sku' => $parent && $p ? $p->get_sku() : null,
                        'quantity' => $it->get_quantity(), 'price' => (float)$o->get_item_total($it, true)];
        }
        seltigo_order($o->get_order_number(), $items, ['name' => $o->get_formatted_billing_full_name(), 'email' => $o->get_billing_email(), 'phone' => $o->get_billing_phone(), 'city' => $o->get_billing_city()]);
    });
    // Sitede stok elle değişti -> Seltigo
    add_action('woocommerce_product_set_stock', function ($p) { if ($p->get_sku()) seltigo_stock($p->get_sku(), $p->get_stock_quantity()); });
    add_action('woocommerce_variation_set_stock', function ($v) {
        $parent = wc_get_product($v->get_parent_id());
        if ($parent && $parent->get_sku()) seltigo_stock($parent->get_sku(), $v->get_stock_quantity(), $v->get_sku());
    });
}
