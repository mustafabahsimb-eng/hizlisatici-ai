# Seltigo (depodaki eski adı: HızlıSatıcı AI) — Claude Code çalışma kuralları

## Kullanıcı ve iletişim
- Kullanıcı Mustafa. Yazılımcı değil; projeyi Claude ile birlikte geliştiriyor. HER ZAMAN Türkçe, sade ve kısa yaz. Teknik terim kullanırsan bir cümleyle ne olduğunu açıkla.
- Kullanıcıdan bir şey yapmasını istediğinde (sayfayı test et, panelden bir ayara bak vb.) mesajın EN ÜSTÜNE tıklanabilir adresi koy. Canlı sayfa: https://mustafabahsimb-eng.github.io/hizlisatici-ai/<sayfa>.html — Supabase paneli: https://supabase.com/dashboard/project/ytucdrrgxsjhrqmaxckt
- Kullanıcıya iş verirken tek seferde, eksiksiz ver (adres + ne yapacağı). Tek bir işi tıklama tıklama mikro adımlara bölme.
- Senin yapabileceğin bir şeyi (tablo şemasını bulmak, dosya okumak, sorgu çalıştırmak) kullanıcıdan isteme; kendin bul.
- Tarayıcı testlerini SEN yaparsın (Playwright ile sayfayı aç, tıkla, ekran görüntüsü al ve kendin bak). Kullanıcıdan sadece onun hesabını, ödemesini veya kararını gerektiren şeyleri iste.
  - Kurulum bu bilgisayarda: %LOCALAPPDATA%\seltigo-e2e\venv (Python, playwright==1.63.0 + Chromium). Testler depoda tests/e2e/ altında; ortak yardımcılar tests/e2e/ortak.py.
  - Giriş gereken sayfalarda kullanıcının hesabını DEĞİL, test kullanıcısını kullan: e2e-test@seltigo.test. Şifresi sadece %LOCALAPPDATA%\seltigo-e2e\test-user.env dosyasında durur; depoya, commit'e, mesaja yazma.
  - Ekran görüntülerini depoya değil geçici klasöre kaydet.
- Edge Function yayınlamadan ÖNCE kodu yerelde denetle (açılış hatası canlıyı bozar): %LOCALAPPDATA%\seltigo-e2e\venv\Scripts\deno.exe check --config %LOCALAPPDATA%\seltigo-e2e\deno-check.json supabase/functions/<ad>/index.ts (deno 2.9.7). Hata varsa yayınlama. Yayından sonra fonksiyonu bir istekle çağırıp açıldığını doğrula; açılmıyorsa hemen eski sürümü (git HEAD) geri yayınla.

## Karar kuralları
- Teknik kararları sen ver. AMA arayüzde kullanıcıya görünen isimleri (menü, düğme, bölüm, sekme adları) ve ürün kararlarını ASLA kendin seçme; seçenek sun ve kullanıcıya sor.
- Her özellik OTOMASYON olarak tasarlanır. Satıcının elle yapacağı ara çözümler önerme ("elle paylaş", "linki koy gerisi senin" gibi). Engel varsa otomatiğe giden yolu söyle.
- "Olmaz" deyip erteleme. Önce nasıl yapılabileceğini söyle (gerçek satıcı hesabı yoksa sandbox/test ortamı gibi).
- Kalite çıtası yüksek: tam ve profesyonel. İşi küçültüp yarım bırakma.
- Yeni fikirler yol haritasına eklenir (YOL-HARITASI.md), hemen yapılacak demek değildir.
- Ödeme gerektiren işlerde (sunucu, ücretli servis, abonelik): altyapıyı ve kodu şimdiden eksiksiz hazırla, varsayılan KAPALI bir anahtarla bekleyecek şekilde kur; ödemeyi kullanıcı sonra yapar. Ödeme günü sadece gerekli değeri (IP, anahtar vb.) girip açmak yetmeli.
- Kalıcı kararlar (2026-10-11):
  - Şirket kurulana kadar ücretli altyapı yok. Sabit IP ve Trendyol test ortamı ertelendi.
  - AliExpress Open Platform yayın başvurusu şirket kurulunca "Dropshipping Developer (Corporation)" olarak yapılacak (tür sonradan değiştirilemez). Rehber: docs/aliexpress-yayin-basvurusu.md
  - CJ ödemesi varsayılan OTOMATİK (bakiyeden). Zarar kontrolü (ürün + kargo + komisyon) HER ZAMAN açık, kapatılamaz; zararlı sipariş ödenmeden satıcı onayına düşer. Bakiye yetmezse sipariş bekler + Türkçe uyarı.
  - Müşteri takip sayfası her zaman var; satıcının WhatsApp'ı bağlı ve şablon onaylıysa kargo çıkınca otomatik WhatsApp (varsayılan açık).
  - AliExpress'te API ile ödeme (API Pay) her alıcı için AliExpress onayı + PayPal istiyor, Türkiye desteklenmiyor → AliExpress ürünleri CJ eşdeğerinden verilip CJ bakiyesinden ödenir.

## Güvenli çalışma
- Canlı sistemi değiştiren işlerden önce (SQL migration, Edge Function deploy, fonksiyon/tablo/veri silme) ne yapacağını Türkçe kısaca anlat ve onay al. Dosya okuma, inceleme ve yerel düzenleme için onay gerekmez.
- Depo HERKESE AÇIK: koda, commit'lere ve CLAUDE.md'ye asla gizli anahtar, token veya şifre yazma. Gizli değerler Supabase Edge Function secrets veya Vault'ta durur. (sb_publishable_ ile başlayan anahtar herkese açık olacak şekilde tasarlanmıştır, sorun değil.)
- Yeni kütüphane/sürüm seçerken en az 2 haftalık kararlı sürüm seç ve sürümü sabitle.
- İş bitince commit et ve git push yap; GitHub Pages siteyi kendisi yayınlar. Commit mesajları Türkçe.

## Proje bilgileri
- Ne: E-ticaret satıcıları için AI destekli SaaS. Tek panelden çok pazaryerine ürün yükleme, stok/fiyat/sipariş yönetimi, tedarikçi (CJ, AliExpress, Printify) entegrasyonları. Hedef: AutoDS'ten güçlü, Türkiye pazaryerlerini ve ülkeler arası satışı destekleyen sistem. Temel prensip: "Ticaret zor olmamalı", "insanlara vakit satıyoruz".
- Yapı: GitHub Pages (statik HTML + app.js) + Supabase (proje ytucdrrgxsjhrqmaxckt, Frankfurt; Auth + Postgres + Edge Functions) + Anthropic API. Native mobil yok, web. PWA henüz yok (manifest ve service worker dosyaları yok), hedef.
- Tasarım: koyu tema (lacivert-siyah) + yeşil #1D9E75. Arayüz TR/EN (app.js içindeki HS.t / i18n).
- Ortak dosya app.js: HS.init, HS.db, HS.t, HS.i18n.add, HS.setLang, HS.money, HS.date, HS.fxRate, HS.convert. Frontend'in ortak Supabase istemcisi HS.db; bazı eski sayfalarda supabaseClient adı geçiyor. Yeni kodda HS.db kullan.
- Auth deseni: frontend Authorization + apikey başlıklarına publishable key koyar; kullanıcının oturum token'ı JSON gövdesinde userAccessToken adıyla gider; Edge Function service-role istemcisiyle supabase.auth.getUser(userAccessToken) ile doğrular. Bu yüzden çoğu fonksiyonda "Verify JWT" kapalıdır. Zamanlanmış (cron) fonksiyonlar CRON_SECRET ile korunur.
- Edge Function kodları depoda supabase/functions/<ad>/index.ts altında; haftalık GitHub Actions yedeklemesi var (.github/workflows/yedek-edge-functions.yml). Fonksiyon adları pazaryeri-verify düzeninde (ör. trendyol-verify).
- Veri modeli 3 katmanlı: products (ürün, tek kayıt) → listings + listing_variants (her pazaryeri için ayrı ilan) → store_connections (pazaryeri hesap bağlantısı, kimlik bilgileri Vault'ta). Ayrıca product_variants, product_images, sync_jobs (kuyruk, sync-worker işler), audit_log, marketplace_orders, countries, vat_rates, trade_routes, marketplaces, exchange_rates (fx-rates-daily), user_profiles. Şemadan emin değilsen veritabanından kendin kontrol et.
- Araçlar: Supabase CLI %LOCALAPPDATA%\supabase-cli klasöründe kurulu ve giriş yapılmış. Git ve GitHub girişi bu bilgisayarda kayıtlı.
- Canlı veritabanına SQL: `supabase db query --linked --project-ref ytucdrrgxsjhrqmaxckt -f dosya.sql` (dosya `--` ile başlıyorsa -f şart). Zamanlanmış işler gizli anahtarı cron komutunun içinde taşır; yeni cron'u mevcut bir işin komutunu SQL içinde kopyalayarak kur (anahtar dışarı çıkmasın).

## Otomasyon altyapısı (özet; ayrıntı kodda)
- Tedarikçi siparişi: cj-order-worker (5 dk; CJ + AliExpress, zarar/bakiye kontrolü, AliExpress→CJ eşdeğeri yönlendirmesi, orders.fulfilled_via), cj-tracking-sync (2 sa; CJ + AliExpress takip, mağaza siparişi + müşteriye WhatsApp), wa-template-worker (30 dk; WhatsApp şablonu her satıcıda Meta onayına), cj-alt-match (1 sa; AliExpress ürününün CJ eşdeğeri: görsel (seviye 3) → anahtar kelime → CJ sourcing talebi), token-refresher (3 sa; AliExpress/Instagram/Meta/Etsy/eBay/Wix anahtarları; yenilenemezse panelde uyarı).
- CJ giriş anahtarı cj_tokens tablosunda paylaşılır (getAccessToken saniyede 1 çağrı). CJ "aynı IP'den 3 kullanıcı" sınırı var; işçiler tekrar dener, kalıcı çözüm sabit IP.
- Sabit IP çıkışı: supabase/functions/_shared/egress.ts (installEgress), anahtar egress_proxy tablosunda (varsayılan kapalı), sağlık kontrolü egress-health (10 dk). CJ/Trendyol/eMAG'e bağlanan YENİ fonksiyonlara da installEgress eklenir. Ayrıntı: docs/sabit-ip-kurulumu.md.
- AliExpress: test uygulaması (anahtar 24 sa, izin 48 sa, yenileme izni uzatmaz). Satıcı hesapları supplier_connections (Vault). Arama TR için countryCode=TR; ds.product.get TR'de boş dönerse "US" ile; adres ASCII olmalı; kapanan sipariş FINISH + extend_map.endReason.
- Linkten ürün yükleme: product-import (platform okuyucuları; engellenen sitede ücretli okuma servisi anahtarı SCRAPER_ENABLED, varsayılan kapalı), source-sync (30 dk; "Fiyat ve stoğu otomatik güncel tut"), channel-copy ("✨ Metni kanala göre yaz"). Trendyol sunucudan uluslararası vitrin (Euro) verir.
- Müşteri takip sayfası: takip.html?t=<tracking_token> (get_order_tracking RPC).

## Açık işler ve bulgular (güncel durum: YOL-HARITASI.md "Durum notları")
- Instagram "süresi doldu" çözüldü (11 Ekim; geçerli, bitiş 9 Aralık 2026). AliExpress test siparişi bizde iptal, AliExpress'te ödenmemiş açık; 31 Ekim'e kadar kendiliğinden kapanır (API iptali yok, para çekilmez).
- Sabit IP: altyapı HAZIR ve denendi, anahtar KAPALI; sunucu alınınca IP girilip açılır (docs/sabit-ip-kurulumu.md "Sunucuyu alacağın gün"). Ödeme bekliyor.
- AliExpress yayın başvurusu: şirket kurulunca (Corporation). CJ seviye 3 (toplam 2.000 $ sipariş) gelene kadar CJ eşleştirme anahtar kelimeyle + sourcing.
- Öncelikli sıradaki işler (2026-10-11, ayrıntı YOL-HARITASI.md "Öncelikli"): 1) Linkten ürün yükleme (tek link + mağaza/site toplu çekme, AI kanal metni, otomatik fiyat/stok güncelleme), 2) PDF'den ürün yükleme (resimli katalog / fiyat listesi / taranmış PDF + OCR; görsel tamamlama sırası: marka resmi sitesi (önce medya kiti) → toptancı → CJ/AliExpress → "Görsel eksik"; rastgele/telifli görsel yok; her görselin kaynağı kaydedilir ve gösterilir; satıcı görsel sorumluluk onayı + kullanım koşulları maddesi), 3) "Link ver, mağazan hazır" (site adresi → ürünler → Seltigo mağazası → diğer kanallara gönder; ücretsiz pakette, çok kanal/otomasyon ücretli; "Web sitem", "Satıcının sitesinde gör", "Satın Al düğmesi kendi siteme gitsin" + dış tıklama kaydı), 4) WhatsApp + Instagram katalog otomasyonu (Meta Catalog API, tek/çoklu ürün mesajı; sandbox, şirketle canlı). Arayüz adları onaylandı (YOL-HARITASI.md tablosu); başka ad uydurma.
- İzlenecek: CJ sourcing talepleri (test kullanıcısının 84, 85, 86, 88 ürünleri), WhatsApp kargo şablonu Meta onayı, ilk gerçek CJ/AliExpress ödemesi.
