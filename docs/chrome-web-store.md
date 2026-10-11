# Chrome Web Mağazası yayını — Seltigo eklentisi

**Durum:** eklenti hazır ve denendi (`chrome-extension/`, test: `tests/e2e/chrome_eklenti.py`). Yayın için
gereken tek ödeme / hesap işi Mustafa'da: Chrome Web Mağazası geliştirici hesabı (tek seferlik 5 $).

## Mustafa'nın yapacakları (bir kez)
1. https://chrome.google.com/webstore/devconsole adresinde Google hesabıyla giriş → geliştirici sözleşmesini
   kabul → 5 $ kayıt ücretini öde → (şirket kurulunca) "yayıncı" bilgisini şirket olarak doğrula.
2. Hesap açılınca Claude'a haber ver; paket (`python chrome-extension/paketle.py` → `seltigo-chrome.zip`),
   mağaza metinleri, ekran görüntüleri ve gizlilik yanıtları aşağıda hazır; yükleme adımlarını birlikte yaparız.

## Mağaza bilgileri
- **Ad:** Seltigo
- **Kategori:** Alışveriş (Shopping) → alt: Araçlar
- **Dil:** Türkçe (sonra İngilizce)
- **Kısa açıklama (132 karakter):** Ürün sayfasındayken tek tıkla Seltigo mağazana ekle: ad, fiyat, görseller ve seçenekler kendi tarayıcından okunur.
- **Uzun açıklama:**
  Seltigo eklentisi, Trendyol, Hepsiburada, n11, Amazon, AliExpress ve diğer sitelerdeki bir ürünü tek tıkla
  Seltigo hesabındaki mağazana ekler. Ürün bilgileri senin tarayıcından okunur; böylece Türkiye fiyatı (TL) ve
  Türkçe içerik doğru gelir. Satış fiyatı Seltigo'daki kâr kuralınla hesaplanır, ürün mağazanda hemen yayınlanır;
  eksik görseller arka planda tamamlanır. AliExpress ürünlerinde siparişlerin otomatik AliExpress'e verilip
  verilmeyeceğini sen seçersin. Bir Seltigo hesabı gerekir.
- **Ekran görüntüleri (1280×800):** `tests/e2e` eklenti testinin çektiği görüntülerden hazırlanacak
  (Trendyol önizleme, eklendi ekranı, Seltigo ürün düzenleme sayfası).
- **Küçük tanıtım görseli (440×280):** yeşil "S" logosu + "Tek tıkla mağazana ekle".

## Tek amaç (Single purpose)
Açık sekmedeki ürün sayfasının bilgilerini kullanıcının isteğiyle okuyup kullanıcının Seltigo hesabına ürün olarak eklemek.

## İzin gerekçeleri
- `activeTab`: kullanıcı eklenti simgesine tıkladığında yalnız o sekmedeki ürün bilgisini okumak için.
- `scripting`: ürün sayfasından ad, fiyat, görsel ve seçenekleri okuyan kodu o sekmede çalıştırmak için.
- `storage`: kullanıcının Seltigo oturumunu (giriş anahtarı) yalnız bu tarayıcıda saklamak için.
- Site izinleri (`trendyol.com`, `aliexpress.com`, `hepsiburada.com`, `n11.com`, `amazon.com.tr`, `amazon.com`):
  bu pazaryerlerinin ürün sayfalarını, kullanıcı eklentiyi açtığında okuyabilmek için. Diğer sitelerde ürün
  bağlantısı Seltigo sunucusuna gönderilir ve orada okunur.
- Uzaktan kod: kullanılmıyor (tüm kod paketin içinde).

## Veri kullanımı (gizlilik formu)
- Toplanan: kimlik doğrulama bilgisi (Seltigo oturum anahtarı), web sitesi içeriği (kullanıcının eklemek istediği
  ürün sayfasındaki ürün bilgileri).
- Kullanım: yalnız eklentinin tek amacı için (ürünü kullanıcının Seltigo hesabına eklemek). Satılmaz, reklam için
  kullanılmaz, kredi değerlendirmesi için kullanılmaz.
- Gizlilik politikası adresi: https://mustafabahsimb-eng.github.io/hizlisatici-ai/gizlilik.html (eklenti bölümü eklendi).

## Sürüm notları
- 1.0.0: Trendyol (TL fiyat, Türkçe içerik, seçenekler), AliExpress (Seltigo'nun AliExpress bağlantısıyla), Amazon,
  Hepsiburada, n11 ve JSON-LD kullanan diğer siteler; izinsiz sitelerde sunucu okuyucusu.
