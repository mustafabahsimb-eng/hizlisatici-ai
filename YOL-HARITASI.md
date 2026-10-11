# Seltigo yol haritası

Yeni fikirler buraya eklenir; buraya eklenmesi hemen yapılacağı anlamına gelmez.

## Lansman öncesi zorunlu işler
- [ ] **Sabit IP (çıkış proxy'si)** — Supabase Edge Function'larının sabit IP'si yok. Gerekli olduğu yerler:
  - Trendyol test ortamı (IP izni ister)
  - eMAG (canlı ortamda da her satıcı IP'mizi hesabına ekler)
  - CJ: aynı IP'den en fazla 3 kullanıcı hesabı ("one ip limit 3 users"); testlerde birkaç kez yaşandı, işçiler tekrar deneyerek geçiyor; satıcı sayısı artınca şart
  - Seçim: Hetzner Almanya, CX23 (€5,49 + IPv4 €0,50 = €5,99/ay, sık stok dışı) ya da CPX02 (IPv4 dahil €6,49/ay). Alternatif: AWS Lightsail ($5/ay), QuotaGuard ($19+/ay).
  - KARAR (2026-10-11): ödeme sonraya; altyapı şimdiden hazırlanır, varsayılan kapalı. Kurulum: `docs/sabit-ip-kurulumu.md`.
  - HAZIR (2026-10-11): proxy modülü 7 fonksiyonda, egress_proxy anahtarı (kapalı), egress-health (10 dk), Hetzner kurulum betiği + GitHub Actions testi. Kalan: sunucuyu satın alıp IP'yi girmek.
- [ ] **E-posta gönderen adı** — Supabase'in kendi e-posta servisi "Supabase Auth" adıyla ve saatte birkaç e-postayla sınırlı gönderiyor; alan adıyla özel SMTP gerekli (şablonlar Seltigo'ya çevrildi).
- [ ] **CJ gerçek ödeme adımı** — Bakiyeden otomatik ödeme (payBalanceV2) para harcamamak için denenmedi; ilk gerçek siparişte izlenmeli.
- [ ] **AliExpress uygulamasını yayın (online) aşamasına geçir** — test aşamasında anahtar 24 saat, izin 48 saat; yayında 30/60 gün. Adımlar ve başvuru metinleri: `docs/aliexpress-yayin-basvurusu.md` (KARAR: şirket kurulunca "Corporation" olarak başvurulacak; tür sonradan değiştirilemez).
- [x] **AliExpress otomatik ödeme yolu** — API Pay her alıcı için AliExpress onayı (PayPal) istiyor ve Türkiye desteklenmiyor. Kuruldu: AliExpress ürünlerinin CJ eşdeğeri arka planda bulunuyor (görselle arama / CJ sourcing talebi); AliExpress'te ödeme yapılamayan satıcıda sipariş CJ'den verilip CJ bakiyesinden ödeniyor. Desteklenen ülkelerde AliExpress'in kendi API Pay'i kullanılıyor (başvuru e-postası: `docs/aliexpress-yayin-basvurusu.md`, Metin D).
- [ ] **CJ sourcing sonuçlarını gözle** — CJ ekibinin eşdeğer bulma süresi/başarısı belgede yok; açılan ilk test talepleri izleniyor.
- [ ] **CJ hesap seviyesi 3** — görselle arama (anında eşdeğer) bu seviyede açılıyor. Şart: CJ'ye toplam 2.000 $ sipariş (LV1 0 $, LV2 500 $, LV3 2.000 $, LV4 100.000 $, LV5 500.000 $; satın alınamaz, sıfırlanmaz, anlaşmazlıklı siparişler sayılmaz). O zamana kadar: anahtar kelimeyle eşleştirme (kuruldu, 11 Ekim) + sourcing talebi.
- [ ] **WhatsApp kargo şablonu** — Meta onayı bekleniyor; onaydan sonra gerçek bir gönderimle doğrulanmalı.

## Öncelikli: ürün girişi ve dağıtım (11 Ekim 2026'da eklendi)
Sıra bağımlılığa göre: 1 ve 2 şirket gerektirmez ve diğerlerinin temelidir; 3, 1'in üstüne kurulur; 4'ün canlıya geçişi şirket ister, bu yüzden sandbox ile en sona. Arayüz adları Mustafa'nın onayını bekliyor (aşağıdaki "Önerilen adlar").

- [ ] **1. Linkten ürün yükleme** (şirket gerekmez; temel var: Toplu Ürün Yükleme "Link yapıştır", product-import, product-lookup)
  - Tek ürün linki (AliExpress, Trendyol, satıcının kendi sitesi, toptancı sayfası) → ad, açıklama, fiyat, görseller, varyantlar otomatik.
  - AI içeriği seçilen kanala göre yeniden yazar (Trendyol / Instagram / kendi mağaza üslubu ve kuralları).
  - Mağaza / kategori / site adresi → tüm ürünler toplu çekilir. API varsa API (AliExpress DS, Shopify/WooCommerce açık uçları, XML besleme), yoksa sayfa okuma (kazıma); satıcı farkı görmez.
  - Çekilen ürünlerde kaynak adresi saklanır; fiyat/stok değişiklikleri belirli aralıklarla otomatik güncellenir (stock-price-monitor benzeri zamanlanmış görev, zarar kontrolüyle).
  - Eski madde "Siteden toplu ürün çekmeyi tamamlama (Excel indir)" buraya katıldı.
- [ ] **2. PDF'den ürün yükleme** (şirket gerekmez; temel var: price-list-parse resimsiz fiyat listesini okuyor)
  - Üç tür: (a) resimli katalog — ad, kod, fiyat ve fotoğraf ayıklanıp eşleştirilir; (b) resimsiz fiyat listesi/tablo; (c) taranmış/fotoğraf PDF — OCR ile okunur.
  - Resimsiz ürünlerde görsel ve bilgi otomatik tamamlanır, sırayla: 1) markanın resmi sitesi (marka + model/kod ile ürün sayfası; resmi görseller + teknik özellikler, açıklama bunlarla zenginleşir), 2) toptancının sitesi, 3) CJ/AliExpress eşleşmesi. Hiçbirinde yoksa "Görsel eksik" etiketiyle eklenir; satıcı telefonla çekip ekler, arka plan otomatik temizlenir (remove-background). Rastgele/telifli görsel alınmaz.
  - Görsel telif güvencesi: marka görsellerinde önce markanın medya kiti / basın görselleri sayfası, sonra ürün sayfası. Her görselin kaynağı kaydedilir ve satıcıya gösterilir ("Görsel kaynağı: ..."). İlk kullanımda satıcı onayı: "Orijinal ürün satıyorum, görsel kullanım sorumluluğu bana aittir" (onay tarihiyle kaydedilir). Satıcı görseli istediği an kendi fotoğrafıyla değiştirebilir.
  - Önizleme listesi; satıcı işaretlediklerini tek tıkla ekler. Telefondan da yüklenebilir (dosya veya kamera).
  - Bağlı iş: **Kullanım koşulları taslağı** (henüz yok) — görsel sorumluluk maddesi eklenecek; yayın öncesi hukukçu kontrolü.
- [ ] **3. "Link ver, mağazan hazır" akışı** (1'e dayanır)
  - Kendi sitesi olan satıcı Mağazanı Kur'da site adresini verir → ürünler çekilir → Seltigo mağazası hazır açılır.
  - Asıl değer dağıtım: akış sonunda "bu ürünleri Trendyol, Instagram, WhatsApp kataloğu ve diğer kanallara gönder" seçeneği.
  - Paket: bu giriş akışı ücretsiz pakette; çok kanal ve otomasyonlar ücretli pakette (paket.html ile uyumlu hale getirilecek).
  - Ayarlar'a "Web sitem" alanı; doluysa mağaza sayfasında satıcının sitesine bağlantı.
  - Linkten çekilen ürünlerde orijinal sayfa adresi saklanır; ürün kartında "Satın Al" yanında "Satıcının sitesinde gör".
  - İsteğe bağlı "Satın Al düğmesi kendi siteme gitsin"; dışarı giden tıklamalar ürün bazında kaydedilir (satış ilgisi verisi kaybolmasın).
- [ ] **4. WhatsApp + Instagram katalog otomasyonu** (temel var: social-catalog, catalog-feed)
  - Ürünler Meta Catalog API ile otomatik Meta kataloğuna; fiyat/stok değişince güncellenir.
  - Katalog satıcının WhatsApp Business Platform hesabına ve Instagram Alışveriş'e bağlanır.
  - WhatsApp'tan tek ürün ve çoklu ürün mesajları otomatik gönderilebilir.
  - Altyapı Meta test numarasıyla sandbox modunda kurulur (varsayılan kapalı anahtar kuralı); şirket kurulunca (Meta işletme doğrulaması) canlıya geçilir.

**Önerilen adlar (onay bekliyor):** sohbette Mustafa'ya sunuldu; onaylananlar buraya yazılacak.

## Sıradaki işler
- [x] AliExpress sipariş ve kargo takibi — canlı test: zarar kontrolü, ödemesiz gerçek sipariş, takip, iptal çalıştı
- [ ] Müşteri Hizmetleri Otomatik Pilotu (WhatsApp / Instagram mesajları)
- [ ] WhatsApp ürün linki ("satıcıya yaz")
- [ ] İkas / Ticimax / WooCommerce bağlantıları
- [ ] Admin paneli eksikleri
- [ ] Chrome eklentisi
- [ ] Shopify / Wix / eBay: ürün gönderme + Hesaplarım'a "Bağla" düğmeleri (bağlantı kaydı hazır)
- [ ] Trendyol gerçek gönderim (test ortamı sabit IP + şirket bekliyor)

## Durum notları (11 Ekim 2026)
**Çözüldü**
- Instagram "süresi doldu": Meta anahtarı iptal etmişti (şifre/güvenlik); Mustafa yeniden bağladı. Yeniden bağlanınca eski "geçersiz" işaretinin silinmemesi hatası düzeltildi (instagram-token-exchange, social-meta-connect); ayarlar (otomatik paylaşım) artık korunuyor. Kayıt geçerli, bitiş 9 Aralık 2026. Not: hata yüzünden otomatik paylaşım ayarı sıfırlanmış olabilir.
- AliExpress kapanan siparişleri "teslim edildi" sayma hatası düzeltildi (extend_map.endReason).
- Sitenin AliExpress arama anahtarı 2 Eylül'de dolmuştu; Mustafa bağlanınca yenilendi; token-refresher artık 3 saatte bir yeniliyor.

**Test siparişleri (para harcanmadı)**
- 4 CJ test siparişi: bizde iptal, CJ'den silindi.
- 1 AliExpress test siparişi (e9d6008d…, AliExpress no 1123253643719483): bizde iptal; AliExpress'te ödenmemiş (PLACE_ORDER_SUCCESS, 26,63 $ ödenmedi). Ödeme süresi 20 gün → en geç 31 Ekim 2026'da AliExpress kendisi kapatır; API ile iptal yok. Para çekilmez.
- Test ürünleri (81 dışında) kaldırıldı. Ürün 81 "Silicone phone case" mağazada 279,90 TL (kargo dahil maliyet ~210 TL).

**İzlenecek / yarım**
- CJ sourcing talepleri: test kullanıcısının 84, 85, 86, 88 ürünleri (CJSPU…). Sonuç gelince süre/başarı Mustafa'ya bildirilecek, test ürünleri kaldırılacak.
- WhatsApp kargo şablonu: Meta onayı bekliyor (wa-template-worker izliyor).
- İlk gerçek CJ bakiyeden ödeme ve AliExpress'in API Pay'i hiç denenmedi (para harcamamak için).
- Sabit IP altyapısı: hazırlandı ve denendi, kapalı (bkz. docs/sabit-ip-kurulumu.md).
- CJ anahtar kelime eşleştirmesi: denemede "araç telefon tutucu" ve "tüy toplayıcı rulo" doğru bulundu; benzer ama farklı ürünler (kasap bıçağı ≠ bıçak seti, havuz lambası ≠ LED şerit, telefon kılıfı ≠ drone kumanda kılıfı) reddedildi. Test ürünlerinin (84, 85, 86, 88) hiçbiri CJ kataloğunda adıyla bulunamadı, sourcing sürüyor.
- cj-search: CJ'nin saniyede 1 istek / IP sınırına takıldığında Ürün Ekle'de arama boş kalabiliyor (testte 2 kez görüldü, tekrar denemede geçti). Satıcıya anlaşılır hata + otomatik tekrar deneme eklenmeli.

**Öğrenilenler**
- AliExpress test uygulaması: anahtar 24 sa, izin 48 sa (yayında 30/60 gün); yenileme izni uzatmaz → en geç 60 günde bir yeniden bağlanma; panel 1 gün önce uyarır.
- AliExpress araması Türkiye için countryCode=TR ile yapılmalı (yoksa ürünlerin çoğu Türkiye'ye gönderilemiyor); adres İngilizce karakter olmalı.
- CJ getAccessToken saniyede 1 çağrı; anahtar 180 gün → cj_tokens'ta paylaşılıyor. CJ görselle arama seviye 3 istiyor. CJ ürün araması (listV2) da saniyede 1 istek.
- Supabase çalışma ortamı HTTP proxy destekliyor (Deno.createHttpClient); doğrudan çıkış bazen IPv6.
