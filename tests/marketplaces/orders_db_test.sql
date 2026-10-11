-- Pazaryeri siparişi tetikleyicileri (iz bırakmaz: ROLLBACK). Test kullanıcısı e2e-test@seltigo.test
--  1) Etsy + CJ ürünü -> tedarikçi siparişi (platform etsy)
--  2) Shopify + kendi stoğum + varsayılan kargo hesabı -> gönderi (kargo hesabıyla)
--  3) Trendyol (kargoyu pazaryeri ayarlıyor) + kendi stoğum -> gönderi AÇILMAZ
--  4) Trendyol + CJ ürünü -> tedarikçi siparişi (platform trendyol_tr)
--  5) Paket anahtarı kapalı (supplier_autoorder) -> tedarikçi siparişi açılmaz
begin;
create temp table r (n int, name text, ok boolean, detail text) on commit drop;
do $$
declare u uuid; p_cj bigint; p_own bigint; mo uuid; acc uuid; v record;
begin
  select id into u from auth.users where email = 'e2e-test@seltigo.test';
  select id into acc from public.shipping_accounts where user_id = u and is_default limit 1;
  if acc is null then
    insert into public.shipping_accounts (user_id, provider, mode, is_default, account_name) values (u, 'yurtici', 'test', true, 'E2E') returning id into acc;
  end if;
  insert into public.products (user_id, name, supplier, supplier_price, sale_price) values (u, 'E2E MP CJ', 'cj', 5, 20) returning id into p_cj;
  insert into public.products (user_id, name, supplier_price, sale_price) values (u, 'E2E MP kendi', 5, 20) returning id into p_own;

  insert into public.marketplace_orders (user_id, marketplace_code, external_order_id, product_id, quantity, currency, item_price, status, buyer_name, buyer_country, buyer_address, raw)
  values (u, 'etsy', 'E2E-ETSY-1/1', p_cj, 1, 'USD', 20, 'new', 'Jane', 'US', '{"line1":"1 Main","city":"Austin","country":"US"}', '{"marketplaceShips":false}');
  select status, platform into v from public.orders where user_id = u and marketplace_order_no = 'E2E-ETSY-1/1';
  insert into r values (1, 'Etsy + CJ -> tedarikçi siparişi', v.status = 'beklemede' and v.platform = 'etsy', coalesce(v.status, 'yok'));

  insert into public.marketplace_orders (user_id, marketplace_code, external_order_id, product_id, quantity, currency, item_price, status, buyer_name, buyer_country, buyer_address, raw)
  values (u, 'shopify', 'E2E-SHOP-1/1', p_own, 1, 'USD', 20, 'new', 'Bob', 'US', '{"line1":"92 Chestnut","city":"Louisville","country":"US"}', '{"marketplaceShips":false}') returning id into mo;
  select provider, account_id into v from public.shipments where marketplace_order_id = mo;
  insert into r values (2, 'Shopify + kendi stoğum -> gönderi (kargo hesabı)', v.account_id is not null and v.provider is not null, coalesce(v.provider, 'yok'));

  insert into public.marketplace_orders (user_id, marketplace_code, external_order_id, product_id, quantity, currency, item_price, status, buyer_name, buyer_country, buyer_address, raw)
  values (u, 'trendyol_tr', 'E2E-TY-1/1', p_own, 1, 'TRY', 200, 'new', 'Ali', 'TR', '{"line1":"Maslak","city":"İstanbul","country":"TR"}', '{"marketplaceShips":true}') returning id into mo;
  insert into r values (3, 'Trendyol (pazaryeri kargosu) -> gönderi açılmaz', not exists (select 1 from public.shipments where marketplace_order_id = mo), '');

  insert into public.marketplace_orders (user_id, marketplace_code, external_order_id, product_id, quantity, currency, item_price, status, buyer_name, buyer_country, buyer_address, raw)
  values (u, 'trendyol_tr', 'E2E-TY-2/1', p_cj, 2, 'TRY', 200, 'new', 'Ali', 'TR', '{"line1":"Maslak","city":"İstanbul","country":"TR"}', '{"marketplaceShips":true}');
  select status, quantity into v from public.orders where user_id = u and marketplace_order_no = 'E2E-TY-2/1';
  insert into r values (4, 'Trendyol + CJ -> tedarikçi siparişi', v.status = 'beklemede' and v.quantity = 2, coalesce(v.status, 'yok'));

  insert into public.user_feature_overrides (user_id, key, enabled, note) values (u, 'supplier_autoorder', false, 'E2E') on conflict (user_id, key) do update set enabled = false;
  insert into public.marketplace_orders (user_id, marketplace_code, external_order_id, product_id, quantity, currency, item_price, status, buyer_name, buyer_country, buyer_address, raw)
  values (u, 'etsy', 'E2E-ETSY-2/1', p_cj, 1, 'USD', 20, 'new', 'Jane', 'US', '{"line1":"1 Main","city":"Austin","country":"US"}', '{"marketplaceShips":false}');
  insert into r values (5, 'Paket anahtarı kapalı -> tedarikçi siparişi yok', not exists (select 1 from public.orders where marketplace_order_no = 'E2E-ETSY-2/1'), '');
end $$;
select n, name, ok, detail from r order by n;
rollback;
