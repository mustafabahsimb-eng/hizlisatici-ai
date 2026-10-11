-- Amazon sipariş akışı - veritabanı tetikleyicileri (iz bırakmaz: sonunda ROLLBACK)
-- Çalıştırma: supabase db query --linked --project-ref ytucdrrgxsjhrqmaxckt -f tests/amazon/amazon_db_test.sql -o csv
-- Senaryolar (test kullanıcısı e2e-test@seltigo.test):
--  1) CJ ürünü Amazon siparişi -> tedarikçi siparişi (orders, platform amazon_us, beklemede)
--  2) Adres gelmeyen CJ siparişi -> onay_bekliyor / adres_yok
--  3) Kendi stoğum ürünü, kargo hesabı yok, ABD -> Amazon etiketi gönderisi (provider amazon)
--  4) Kendi stoğum ürünü, Türkiye (Buy Shipping yok), kargo hesabı yok -> gönderi açılmaz
--  5) Asistan bildirimi kuyruğa (bağlı asistan hesabı varsa) - kuyruk fonksiyonu hata vermez
--  6) İlan kuyruğuna iş eklenince sync-worker beklemeden tetiklenir (net.http_request_queue'ya istek)
begin;
create temp table r (n int, name text, ok boolean, detail text) on commit drop;
do $$
declare
  u uuid; c uuid; p_cj bigint; p_own bigint; mo1 uuid; mo2 uuid; mo3 uuid; mo4 uuid; n_before bigint; n_after bigint; v record;
begin
  select id into u from auth.users where email = 'e2e-test@seltigo.test';
  -- Geçici: varsayılan kargo hesabını devre dışı say (yalnız bu işlemde)
  update public.shipping_accounts set is_default = false where user_id = u;
  insert into public.store_connections (user_id, marketplace_code, environment, external_seller_id, label, status, settings)
    values (u, 'amazon_us', 'sandbox', 'ATESTSELLER', 'Amazon ABD (test)', 'connected', '{"dry_run": true}') returning id into c;
  insert into public.products (user_id, name, supplier, supplier_price, sale_price) values (u, 'E2E Amazon CJ ürünü', 'cj', 5, 20) returning id into p_cj;
  insert into public.products (user_id, name, supplier_price, sale_price) values (u, 'E2E Amazon kendi stoğum', 5, 20) returning id into p_own;

  insert into public.marketplace_orders (user_id, connection_id, marketplace_code, external_order_id, product_id, quantity, currency, item_price, status, buyer_name, buyer_country,
    buyer_address, source_table) values (u, c, 'amazon_us', 'TEST-111-1', p_cj, 1, 'USD', 20, 'new', 'John Buyer', 'US',
    '{"line1":"1 Main St","city":"SEATTLE","zip":"98121","country":"US"}', 'amazon') returning id into mo1;
  select status, supplier, platform, customer_city into v from public.orders where user_id = u and marketplace_order_no = 'TEST-111-1';
  insert into r values (1, 'CJ ürünü -> tedarikçi siparişi', v.status = 'beklemede' and v.supplier = 'cj' and v.platform = 'amazon_us' and v.customer_city = 'SEATTLE', coalesce(v.status, 'yok'));

  insert into public.marketplace_orders (user_id, connection_id, marketplace_code, external_order_id, product_id, quantity, currency, item_price, status, buyer_country,
    buyer_address, source_table) values (u, c, 'amazon_us', 'TEST-111-2', p_cj, 1, 'USD', 20, 'new', 'US', '{"line1":"","country":"US"}', 'amazon') returning id into mo2;
  select status, hold_reason into v from public.orders where user_id = u and marketplace_order_no = 'TEST-111-2';
  insert into r values (2, 'Adres yok -> onay_bekliyor / adres_yok', v.status = 'onay_bekliyor' and v.hold_reason = 'adres_yok', coalesce(v.status, 'yok') || '/' || coalesce(v.hold_reason, ''));

  insert into public.marketplace_orders (user_id, connection_id, marketplace_code, external_order_id, product_id, quantity, currency, item_price, status, buyer_name, buyer_country,
    buyer_address, source_table) values (u, c, 'amazon_us', 'TEST-111-3', p_own, 1, 'USD', 20, 'new', 'John Buyer', 'US',
    '{"line1":"1 Main St","city":"SEATTLE","zip":"98121","country":"US"}', 'amazon') returning id into mo3;
  select provider, status, account_id into v from public.shipments where marketplace_order_id = mo3;
  insert into r values (3, 'Kendi stoğum + ABD -> Amazon etiketi gönderisi', v.provider = 'amazon' and v.status = 'pending' and v.account_id is null, coalesce(v.provider, 'yok'));
  insert into r values (3, 'Kendi stoğum ürününde tedarikçi siparişi açılmaz', not exists (select 1 from public.orders where marketplace_order_no = 'TEST-111-3'), '');

  update public.store_connections set marketplace_code = 'amazon_tr' where id = c;
  insert into public.marketplace_orders (user_id, connection_id, marketplace_code, external_order_id, product_id, quantity, currency, item_price, status, buyer_name, buyer_country,
    buyer_address, source_table) values (u, c, 'amazon_tr', 'TEST-111-4', p_own, 1, 'TRY', 200, 'new', 'Ali Alıcı', 'TR',
    '{"line1":"Test Mah. 1","city":"İstanbul","country":"TR"}', 'amazon') returning id into mo4;
  insert into r values (4, 'Türkiye + kargo hesabı yok -> gönderi açılmaz (Amazon etiketi TR''de yok)', not exists (select 1 from public.shipments where marketplace_order_id = mo4), '');

  insert into r values (5, 'Asistan bildirimi tetikleyicisi hata vermedi', true, (select count(*)::text from public.assistant_outbox where payload->>'marketplace' like 'amazon%' and created_at > now() - interval '1 minute'));

  select count(*) into n_before from net.http_request_queue;
  update public.sync_kick_state set last_kick = 'epoch' where id = 1;
  perform public.enqueue_sync_job(u, 'listing_sync', null, null, '{}'::jsonb, 'e2e-kick-' || gen_random_uuid()::text, 100);
  select count(*) into n_after from net.http_request_queue;
  insert into r values (6, 'Kuyruğa iş -> sync-worker hemen çağrıldı', n_after = n_before + 1, n_before || ' -> ' || n_after);
end $$;
select n, name, ok, detail from r order by n;
rollback;
