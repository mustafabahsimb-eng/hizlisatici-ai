# Seltigo (depodaki eski adı: HızlıSatıcı AI) — Claude Code çalışma kuralları

## Kullanıcı ve iletişim
- Kullanıcı Mustafa. Yazılımcı değil; projeyi Claude ile birlikte geliştiriyor. HER ZAMAN Türkçe, sade ve kısa yaz. Teknik terim kullanırsan bir cümleyle ne olduğunu açıkla.
- Kullanıcıdan bir şey yapmasını istediğinde (sayfayı test et, panelden bir ayara bak vb.) mesajın EN ÜSTÜNE tıklanabilir adresi koy. Canlı sayfa: https://mustafabahsimb-eng.github.io/hizlisatici-ai/<sayfa>.html — Supabase paneli: https://supabase.com/dashboard/project/ytucdrrgxsjhrqmaxckt
- Kullanıcıya iş verirken tek seferde, eksiksiz ver (adres + ne yapacağı). Tek bir işi tıklama tıklama mikro adımlara bölme.
- Senin yapabileceğin bir şeyi (tablo şemasını bulmak, dosya okumak, sorgu çalıştırmak) kullanıcıdan isteme; kendin bul.

## Karar kuralları
- Teknik kararları sen ver. AMA arayüzde kullanıcıya görünen isimleri (menü, düğme, bölüm, sekme adları) ve ürün kararlarını ASLA kendin seçme; seçenek sun ve kullanıcıya sor.
- Her özellik OTOMASYON olarak tasarlanır. Satıcının elle yapacağı ara çözümler önerme ("elle paylaş", "linki koy gerisi senin" gibi). Engel varsa otomatiğe giden yolu söyle.
- "Olmaz" deyip erteleme. Önce nasıl yapılabileceğini söyle (gerçek satıcı hesabı yoksa sandbox/test ortamı gibi).
- Kalite çıtası yüksek: tam ve profesyonel. İşi küçültüp yarım bırakma.
- Yeni fikirler yol haritasına eklenir, hemen yapılacak demek değildir.

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
