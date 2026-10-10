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
- [ ] **AliExpress uygulamasını yayın (online) aşamasına geçir** — test aşamasında anahtar 24 saat, izin 48 saat; yayında 30/60 gün. Adımlar ve başvuru metinleri: `docs/aliexpress-yayin-basvurusu.md` (KARAR: şirket kurulunca "Corporation" olarak başvurulacak; tür sonradan değiştirilemez).
- [x] **AliExpress otomatik ödeme yolu** — API Pay her alıcı için AliExpress onayı (PayPal) istiyor ve Türkiye desteklenmiyor. Kuruldu: AliExpress ürünlerinin CJ eşdeğeri arka planda bulunuyor (görselle arama / CJ sourcing talebi); AliExpress'te ödeme yapılamayan satıcıda sipariş CJ'den verilip CJ bakiyesinden ödeniyor. Desteklenen ülkelerde AliExpress'in kendi API Pay'i kullanılıyor (başvuru e-postası: `docs/aliexpress-yayin-basvurusu.md`, Metin D).
- [ ] **CJ sourcing sonuçlarını gözle** — CJ ekibinin eşdeğer bulma süresi/başarısı belgede yok; açılan ilk test talepleri izleniyor.
- [ ] **CJ hesap seviyesi 3** — görselle arama (anında eşdeğer) bu seviyede açılıyor; şu an her ürün CJ sourcing talebiyle (insan eliyle, daha yavaş) eşleşiyor.
- [ ] **WhatsApp kargo şablonu** — Meta onayı bekleniyor; onaydan sonra gerçek bir gönderimle doğrulanmalı.

## Sıradaki işler
- [x] AliExpress sipariş ve kargo takibi — canlı test: zarar kontrolü, ödemesiz gerçek sipariş, takip, iptal çalıştı
- [ ] Siteden toplu ürün çekmeyi tamamlama (Excel indir)
- [ ] Müşteri Hizmetleri Otomatik Pilotu (WhatsApp / Instagram mesajları)
- [ ] WhatsApp ürün linki ("satıcıya yaz")
- [ ] İkas / Ticimax / WooCommerce bağlantıları
- [ ] Admin paneli eksikleri
- [ ] Chrome eklentisi
- [ ] Shopify / Wix / eBay: ürün gönderme + Hesaplarım'a "Bağla" düğmeleri (bağlantı kaydı hazır)
- [ ] Trendyol gerçek gönderim (test ortamı sabit IP + şirket bekliyor)
