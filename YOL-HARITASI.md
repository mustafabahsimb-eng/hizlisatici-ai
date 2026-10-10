# Seltigo yol haritası

Yeni fikirler buraya eklenir; buraya eklenmesi hemen yapılacağı anlamına gelmez.

## Lansman öncesi zorunlu işler
- [ ] **Sabit IP (çıkış proxy'si)** — Supabase Edge Function'larının sabit IP'si yok. Gerekli olduğu yerler:
  - Trendyol test ortamı (IP izni ister)
  - eMAG (canlı ortamda da her satıcı IP'mizi hesabına ekler)
  - CJ: aynı IP'den en fazla 3 kullanıcı hesabı ("one ip limit 3 users"); satıcı sayısı artınca şart
  - Öneri: Hetzner'de küçük sunucu (~€6,5–12,5/ay) ya da QuotaGuard ($19+/ay). Şirket kurulunca.
- [ ] **E-posta gönderen adı** — Supabase'in kendi e-posta servisi "Supabase Auth" adıyla ve saatte birkaç e-postayla sınırlı gönderiyor; alan adıyla özel SMTP gerekli (şablonlar Seltigo'ya çevrildi).
- [ ] **CJ gerçek ödeme adımı** — Bakiyeden otomatik ödeme (payBalanceV2) para harcamamak için denenmedi; ilk gerçek siparişte izlenmeli.
- [ ] **WhatsApp kargo şablonu** — Meta onayı bekleniyor; onaydan sonra gerçek bir gönderimle doğrulanmalı.

## Sıradaki işler
- [~] AliExpress sipariş ve kargo takibi — kod ve arayüz hazır; gerçek sipariş testi site sahibinin AliExpress hesabı bağlanınca
- [ ] Siteden toplu ürün çekmeyi tamamlama (Excel indir)
- [ ] Müşteri Hizmetleri Otomatik Pilotu (WhatsApp / Instagram mesajları)
- [ ] WhatsApp ürün linki ("satıcıya yaz")
- [ ] İkas / Ticimax / WooCommerce bağlantıları
- [ ] Admin paneli eksikleri
- [ ] Chrome eklentisi
- [ ] Shopify / Wix / eBay: ürün gönderme + Hesaplarım'a "Bağla" düğmeleri (bağlantı kaydı hazır)
- [ ] Trendyol gerçek gönderim (test ortamı sabit IP + şirket bekliyor)
