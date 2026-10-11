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
Sıra (12 Ekim 2026 güncel): 1 ve 2 temeldir (büyük kısmı bitti); 2b Chrome eklentisi (Trendyol TL fiyatı); 3 Seltigo Asistan (Telegram'da canlı, şirket gerekmez; ilk gerçek kullanıcılar buradan başlar; 1-2'deki okuyucuları kullanır); 4 "Link ver, mağazan hazır" (1'in üstüne); 5 WhatsApp + Instagram katalog otomasyonu (Meta; asistanın WhatsApp/Instagram/Messenger sürümleriyle aynı Meta altyapısı, şirketle canlı); 6 Ölü stok eritici (en az 30-60 günlük satış verisi gerekir; uygulama asistan ve panelden). Arayüz adları onaylandı (aşağıdaki tablo).

- [~] **1. Linkten ürün yükleme** (şirket gerekmez; temel var: Toplu Ürün Yükleme "Link yapıştır", product-import, product-lookup)
  - Tek ürün linki (AliExpress, Trendyol, satıcının kendi sitesi, toptancı sayfası) → ad, açıklama, fiyat, görseller, varyantlar otomatik.
  - AI içeriği seçilen kanala göre yeniden yazar (Trendyol / Instagram / kendi mağaza üslubu ve kuralları).
  - Mağaza / kategori / site adresi → tüm ürünler toplu çekilir. API varsa API (AliExpress DS, Shopify/WooCommerce açık uçları, XML besleme), yoksa sayfa okuma (kazıma); satıcı farkı görmez.
  - Çekilen ürünlerde kaynak adresi saklanır; fiyat/stok değişiklikleri belirli aralıklarla otomatik güncellenir (stock-price-monitor benzeri zamanlanmış görev, zarar kontrolüyle).
  - Eski madde "Siteden toplu ürün çekmeyi tamamlama (Excel indir)" buraya katıldı.
  - DURUM (11 Ekim 2026): çoğu yapıldı ve denendi.
    - Okuyucular: AliExpress (DS API, satıcının hesabıyla), Shopify (ürün / koleksiyon / tüm mağaza, sayfa sayfa; ana para birimi), WooCommerce (Store API, seçenekleriyle), Trendyol (sayfa içi veri), JSON-LD seçenekleri, site ana sayfası → site haritası.
    - Seçenekler (beden/renk) product_variants'a kaydediliyor; kaynak platform/numara saklanıyor.
    - "Fiyat ve stoğu otomatik güncel tut" + source-sync (30 dk): fiyat değişince satış fiyatı aynı oranda (kâr korunur), stok bitince gizle / gelince aç, kaldırılan sayfa = tükendi.
    - "✨ Metni kanala göre yaz" (channel-copy): 8 kanal kuralı.
    - Test: tests/e2e/linkten_yukleme.py 10/10.
  - Kalanlar / bilinen sınırlar:
    - [ ] Trendyol Türkiye dışındaki sunuculara uluslararası vitrini veriyor (Euro, Almanca): görsel/seçenek/özellik doğru, fiyat Euro. ÇÖZÜM: 2b Chrome eklentisi (satıcının tarayıcısından Türkiye fiyatı).
    - [ ] Bazı siteler sunucudan okumayı engelliyor (ör. Cloudflare korumalı): Shopify/WooCommerce ise veri adreslerine düşülüyor; değilse ücretli okuma servisi gerekir. Altyapı hazır, varsayılan KAPALI: Edge secret SCRAPER_ENABLED=true + SCRAPER_URL_TEMPLATE (ör. ScrapingBee/ZenRows, "{url}" yer tutuculu). Ödeme günü sadece bu iki değer girilir.
    - [x] Mağaza vitrininde beden/renk seçimi (12 Ekim): seçenek fiyatı ve görseli, tükenen seçenek kapalı; seçenek mağaza siparişine, tedarikçi siparişine (AliExpress SKU / CJ eşdeğerinde ad eşleşmesi) ve müşteri takip sayfasına geçiyor. Test: vitrin_secenek.py 10/10. Not: gerçek AliExpress/CJ siparişinde seçenek seçimi para harcamamak için denenmedi; ilk gerçek seçenekli siparişte izlenmeli.
    - [ ] Kendi mağaza dışındaki kanallardaki ilan fiyatları (Trendyol vb.) source-sync ile henüz güncellenmiyor (o kanalların gönderimi açılınca sync-worker kuyruğuna bağlanacak).
- [~] **2. PDF'den ürün yükleme** (şirket gerekmez)
  - Üç tür: (a) resimli katalog — ad, kod, fiyat ve fotoğraf ayıklanıp eşleştirilir; (b) resimsiz fiyat listesi/tablo; (c) taranmış/fotoğraf PDF — OCR ile okunur.
  - Resimsiz ürünlerde görsel ve bilgi otomatik tamamlanır, sırayla: 1) markanın resmi sitesi (marka + model/kod ile ürün sayfası; resmi görseller + teknik özellikler, açıklama bunlarla zenginleşir), 2) toptancının sitesi, 3) CJ/AliExpress eşleşmesi. Hiçbirinde yoksa "Görsel eksik" etiketiyle eklenir; satıcı telefonla çekip ekler, arka plan otomatik temizlenir (remove-background). Rastgele/telifli görsel alınmaz.
  - Görsel telif güvencesi: marka görsellerinde önce markanın medya kiti / basın görselleri sayfası, sonra ürün sayfası. Her görselin kaynağı kaydedilir ve satıcıya gösterilir ("Görsel kaynağı: ..."). İlk kullanımda satıcı onayı: "Orijinal ürün satıyorum, görsel kullanım sorumluluğu bana aittir" (onay tarihiyle kaydedilir). Satıcı görseli istediği an kendi fotoğrafıyla değiştirebilir.
  - Önizleme listesi; satıcı işaretlediklerini tek tıkla ekler. Telefondan da yüklenebilir (dosya veya kamera).
  - Bağlı iş: **Kullanım koşulları taslağı** — yazıldı: `docs/kullanim-kosullari-taslak.md` (görsel sorumluluk maddesi 3.2 dahil). Yayın öncesi hukukçu kontrolü + şirket bilgileri gerekli.
  - DURUM (12 Ekim 2026): çoğu yapıldı ve denendi.
    - Sekme "📄 Katalog / fiyat listesi yükle": PDF, taranmış PDF, Excel/CSV/ODS/TXT (başlık düzeni ne olursa olsun), fotoğraf ve ekran görüntüsü; birden çok dosya; telefondan fotoğraf.
    - Resimli katalogda fotoğraf doğru ürüne bağlanıyor: model kodu varsa koda göre, yoksa sayfadaki resim alanları numaralanıp yapay zekâya eşleştiriliyor; taranmış sayfa / ekran görüntüsünde fotoğrafın yerini yapay zekâ buluyor.
    - Görsel tamamlama zinciri: marka sitesi (basın / medya kiti → ürün sayfası) → toptancı sitesi (dosyada yazan web adresi) → CJ / AliExpress (sıkı ad eşleşmesi) → "Görsel eksik" + "📷 Fotoğraf çek / yükle" (arka plan otomatik temizlenir, beyaz zemin).
    - Her görselin kaynağı kaydediliyor (product_images.source_kind / source_url) ve önizlemede "Görsel kaynağı: ..." görünüyor; "Kendi fotoğrafımla değiştir"; ilk kullanım onayı tarihiyle kaydediliyor; "Seçilenleri ekle ({n})".
    - Testler: katalog_yukleme.py 18/18 (iki kez), gorsel_tamamlama.py 15/15.
  - Kalanlar:
    - [x] Ürün düzenleme sayfası "✏️ Ürünü düzenle" (12 Ekim, Mustafa'nın kararı): ad, açıklama, fiyat, stok, kaynak (Kendi stoğum / Toptancı / AliExpress / CJ), beden/renk seçenekleri, görseller (kaynağı, "Kendi fotoğrafımla değiştir"). Test: urun_duzenle.py 17/17.
    - [ ] Basın / medya kiti araması gerçek markalarda nadiren sonuç verir (çoğu marka basın görselini ayrı sunmuyor); bulunamazsa ürün sayfasına geçiliyor.
    - [x] Görsel tamamlama arka planda (12 Ekim): image-complete-worker (2 dk), satıcı beklemez; panelde ilerleme ve bitiş bildirimi, üründe "Görsel eksik" etiketi. Hız: aynı anda 2 ürün, ürün başına ~30-90 sn (≈60-120 ürün/saat). Test: gorsel_tamamlama.py 18/18.
    - [ ] Çok büyük partilerde hız: paralellik artırılabilir (yapay zekâ internet araması maliyeti ve hız sınırı izlenmeli).
- [ ] **2b. Chrome eklentisi** (öne alındı, 12 Ekim 2026; şirket gerekmez)
  - Amaç: sunucunun okuyamadığı ya da yanlış ülke vitrinini gördüğü sitelerde ürünü satıcının kendi tarayıcısından okumak. İlk hedef Trendyol'un Türkiye fiyatı (TL) ve Türkçe içeriği.
  - Satıcı ürün sayfasındayken tek tıkla Seltigo'ya ekler; eklenti sayfadaki ürün verisini (ad, fiyat, görsel, seçenek, stok) okuyup Seltigo hesabına gönderir.
  - Linkten çekilen ve otomatik takipteki (source_sync) Trendyol ürünlerinde Türkiye fiyatı da eklentiyle güncellenebilmeli (satıcının tarayıcısı açıkken arka planda).
  - Chrome Web Mağazası'na yayın: geliştirici hesabı tek seferlik 5 $ (ödeme gerektirir → altyapı hazırlanır, yayın ödemeden sonra); o zamana kadar "paketlenmemiş eklenti" olarak denenir.
- [ ] **3. Seltigo Asistan: "Mağazanı WhatsApp'tan yönet"** (12 Ekim 2026'da eklendi; adlar onay bekliyor)
  Satıcı mağazasını Seltigo'nun numarasıyla / botuyla yazışarak yönetir. Tek çekirdek (komut anlama, ürün ekleme, uyarı, rapor), kanal başına ince bağlayıcı.
  - **Gönder, gerisi otomatik:** toptancı PDF'i iletilince ürünler önizleme listesiyle gelir ("hepsini ekle" / "1-15 ekle"); fotoğraf + "350'ye sat, 20 tane" ile ilan açılır; link gönderilince ürün eklenir; sesli mesajla komut (konuşmadan yazıya). Temel hazır: price-list-parse, product-import, channel-copy, image-complete-worker, voice-product-parse.
  - **Fiyat:** PDF akışında satış fiyatı Ayarlar'daki kâr kuralına göre (ör. "alışın üstüne %40"); mesajda farklı oran söylenebilir ("1-15'i %50 kârla ekle"). Zarar kontrolü (komisyon + kargo) burada da çalışır.
  - **Kanal ve onay:** ürünler satıcının bağlı olduğu ve Ayarlar'da varsayılan seçtiği kanallarda yayınlanır; mesajda kanal söylenebilir ("sadece Trendyol'a"). Ayarlar: "yayından önce onay iste" / "direkt yayınla"; onay modunda özet + [Yayınla] [Fiyatları düzenle].
  - **Butonlu anlık uyarılar:** yeni sipariş; stok bitiyor; iade; zararlı sipariş onayı [Onayla] [İptal]; CJ bakiyesi azaldı; bağlantı süresi doluyor; rakip fiyat düşürdü [Fiyatı düşür] [Böyle kalsın].
  - **Soru-cevap:** "bu ay ne kadar kâr ettim", "en çok ne satıyor", "hangi ürün zarar ediyor"; her sabah kısa rapor, pazartesi haftalık özet.
  - **Günlük iş:** "bugün gönderilecekler" listesi ve kargo etiketleri PDF'i (Kendi stoğum / Toptancı siparişleri için kargo firması entegrasyonu gerekir → ayrı iş, şirket gerektirebilir); müşteri sorularının özeti + önerilen cevap onaya.
  - **Güvenlik:** yalnız kayıtlı (doğrulanmış) numara / hesap komut verir; fiyat düşürme, toplu silme gibi kritik işlerde ikinci onay; sessiz saatler; çalışanlara sınırlı yetki.
  - **Kanallar:**
    - Telegram: önce CANLI (şirket gerekmez, ücretsiz). İlk gerçek kullanıcılar buradan başlar.
    - WhatsApp (ayrı ücretli paket), Instagram DM, Facebook Messenger: aynı çekirdekle şimdi sandbox'ta kurulur (varsayılan kapalı anahtar), şirket kurulunca canlıya geçer.
    - Instagram / Messenger'da: komut, fotoğraf / link ile ürün ekleme, soru-cevap. Messenger'da PDF de kabul edilir; Instagram'da katalog ekran görüntüleri okunur.
    - Meta'nın 24 saat kuralı: bu iki kanalda otomatik rapor / uyarı yalnız pencere açıkken gider; tam uyarılar için WhatsApp / Telegram önerilir.
  - **Doğrulanan kısıtlar (resmi belgeler, 12 Ekim 2026):**
    - Messenger: kullanıcı yazınca 24 saat; dışında yalnız HUMAN_AGENT etiketiyle elle cevap (7 gün) — otomatik bildirim için kullanılamaz; "One-Time Notification" beta ve Instagram'da yok; Sponsored Messages reklam ve Instagram'da yok. Otomatik botlar her girdiye 30 sn içinde cevap vermeli; otomatik olduğunu belirtmeli. Gelen ek türleri: image, audio, video, file, sticker, fallback (link).
    - Instagram: yalnız kullanıcı önce yazınca, 24 saat içinde cevap; insan temsilci etiketi var. API'de gelen ek türleri arasında image, audio, video, file listeleniyor; ancak Instagram uygulaması kullanıcıya genelde dosya (PDF) gönderme imkânı vermiyor → Instagram'da PDF beklenmez, ekran görüntüsü / fotoğraf okunur. Gönderilen metin en fazla 1000 bayt.
    - WhatsApp Cloud API: 24 saatlik müşteri hizmeti penceresi; dışında yalnız onaylı şablon mesaj (ücretli); butonlu cevap en fazla 3 buton, ayrıca liste mesajı.
    - Telegram Bot API: 24 saat kuralı yok; satır içi butonlar (callback) ve sesli mesaj destekli; bot en fazla 20 MB dosya indirir (daha büyük PDF için kendi Bot API sunucusu → sabit IP sunucusuyla aynı makine olabilir).
- [ ] **4. "Link ver, mağazan hazır" akışı** (1'e dayanır)
  - Kendi sitesi olan satıcı Mağazanı Kur'da site adresini verir → ürünler çekilir → Seltigo mağazası hazır açılır.
  - Asıl değer dağıtım: akış sonunda "bu ürünleri Trendyol, Instagram, WhatsApp kataloğu ve diğer kanallara gönder" seçeneği.
  - Paket: bu giriş akışı ücretsiz pakette; çok kanal ve otomasyonlar ücretli pakette (paket.html ile uyumlu hale getirilecek).
  - Ayarlar'a "Web sitem" alanı; doluysa mağaza sayfasında satıcının sitesine bağlantı.
  - Linkten çekilen ürünlerde orijinal sayfa adresi saklanır; ürün kartında "Satın Al" yanında "Satıcının sitesinde gör".
  - İsteğe bağlı "Satın Al düğmesi kendi siteme gitsin"; dışarı giden tıklamalar ürün bazında kaydedilir (satış ilgisi verisi kaybolmasın).
- [ ] **5. WhatsApp + Instagram katalog otomasyonu** (temel var: social-catalog, catalog-feed)
  - Ürünler Meta Catalog API ile otomatik Meta kataloğuna; fiyat/stok değişince güncellenir.
  - Katalog satıcının WhatsApp Business Platform hesabına ve Instagram Alışveriş'e bağlanır.
  - WhatsApp'tan tek ürün ve çoklu ürün mesajları otomatik gönderilebilir.
  - Altyapı Meta test numarasıyla sandbox modunda kurulur (varsayılan kapalı anahtar kuralı); şirket kurulunca (Meta işletme doğrulaması) canlıya geçilir.

- [ ] **6. Ölü stok eritici** (12 Ekim 2026'da eklendi; adlar onay bekliyor)
  - 30-60 gündür satmayan ürünleri bulur (süre ayarlanabilir), otomatik eritme planı önerir: kademeli indirim, satan ürünle paket (bundle-suggest temeli var), Instagram paylaşımı.
  - Satıcının belirlediği alt fiyatın altına ASLA inmez; zarar kontrolü her zaman çalışır.
  - Satıcı onaylarsa (panelden ya da Seltigo Asistan'dan) plan otomatik uygulanır; her adım ve sonucu raporlanır.
  - Ön koşul: en az 30-60 günlük gerçek satış verisi (marketplace_orders / store_orders).

**Onaylı arayüz adları (Mustafa, 11 Ekim 2026):**
| Yer | Ad |
|---|---|
| Toplu Yükleme, link sekmesi | "🔗 Link yapıştır" (mevcut) |
| Fiyat/stok takibi | "Fiyat ve stoğu otomatik güncel tut" + aralık "6 saatte bir" / "Günde bir" |
| AI metin düğmesi | "✨ Metni kanala göre yaz" |
| Dosya sekmesi (eski "Fiyat listesi yükle (PDF/Excel)") | "📄 Katalog / fiyat listesi yükle" (12 Ekim'de değişti; "Excel" kelimesi geçmez) |
| Görseli olmayan ürün etiketi | "Görsel eksik" |
| Görsel eksik üründe düğme | "📷 Fotoğraf çek / yükle" |
| Görsel değiştirme | "Kendi fotoğrafımla değiştir" |
| Görsel kaynağı | "Görsel kaynağı: ..." |
| İlk kullanım onayı | "Orijinal ürün satıyorum, görsel kullanım sorumluluğu bana aittir" |
| Önizlemede ekleme | "Seçilenleri ekle ({n})" |
| Mağazanı Kur, site adresi | alan "Web sitenin adresi" + düğme "Ürünlerimi getir" |
| Akış sonu | "Bu ürünleri diğer kanallara da gönder" (Trendyol, Instagram, WhatsApp kataloğu… işaret kutuları) |
| Ayarlar | "Web sitem" |
| Mağaza ürün kartı | "Satıcının sitesinde gör" |
| Ayar anahtarı | "Satın Al düğmesi kendi siteme gitsin" |
| Sosyal sayfası, katalog bölümü | "WhatsApp ve Instagram kataloğu" |
| Katalog anahtarı | "Ürünleri kataloğa otomatik gönder" |
| WhatsApp düğmeleri | "Ürünü gönder" / "Seçili ürünleri gönder" |
| Test modu etiketi | "Test modu (Meta test numarası)" |
| Ürün düzenleme sayfası (12 Ekim) | düğmeler "💾 Kaydet", "+ Seçenek ekle"; etiketler "Ana görsel", "Satışta"; alan "AliExpress ürün linki" / "CJ ürün linki" |
| Toplu Ürün Yükleme (12 Ekim) | soru "AliExpress ürünleri için kaynak" (AliExpress / Kendi stoğum) |
| Panel "Ürün ekle" kartı alt yazısı (12 Ekim) | "Tek ürün, link, katalog ya da fotoğraf" |

## Sıradaki işler
- [x] AliExpress sipariş ve kargo takibi — canlı test: zarar kontrolü, ödemesiz gerçek sipariş, takip, iptal çalıştı
- [ ] Müşteri Hizmetleri Otomatik Pilotu (WhatsApp / Instagram mesajları)
- [ ] WhatsApp ürün linki ("satıcıya yaz")
- [ ] İkas / Ticimax / WooCommerce bağlantıları
- [ ] Admin paneli eksikleri
- [ ] Chrome eklentisi → öne alındı, yukarıda "2b"
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
