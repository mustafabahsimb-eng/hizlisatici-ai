-- Amazon pazarları: varsayılan komisyon (satış komisyonu / referral fee) %15
-- Amazon'un yayınladığı oran kategoriye göre %5-20 (çoğu kategoride %15). Zarar kontrolü bununla çalışır;
-- ilanda satıcı / kategori oranı varsa (listings.commission_pct) o kullanılır. Yalnız boş olanlar doldurulur.
update public.marketplaces
set default_commission_pct = 15
where code like 'amazon\_%' escape '\'
  and default_commission_pct is null;
