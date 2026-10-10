# AliExpress uygulamasını yayın (online) aşamasına geçirme — Seltigo

Hazırlanma: 11 Ekim 2026. Kaynak: AliExpress Open Platform belgeleri (Quick Start, Register an application,
Request API Permission, Authorize your APP, Refresh token, How to use API Pay, Developer account issues).
Başvurunun ne zaman yapılacağı henüz kararlaştırılmadı.

## Neden gerekli?
| | Test aşaması (şu an) | Yayın aşaması |
|---|---|---|
| Erişim anahtarı | 24 saat | 30 gün |
| İzin (yenileme anahtarı) | 48 saat | 30–60 gün |
| Sonuç | Satıcı 2 günde bir yeniden bağlanmak zorunda | Satıcı en geç 60 günde bir yeniden bağlanır |

Not: Yenileme, iznin süresini uzatmıyor. Yayın aşamasında da 60 günde bir yeniden bağlanmak gerekecek.
Seltigo bunu 3 saatte bir kontrol ediyor ve bitişe 1 gün kala panelde uyarıyor.

## Önce verilmesi gereken karar: geliştirici türü
AliExpress'te onaylanan geliştirici türü **sonradan değiştirilemiyor**.
- **Dropshipping Developer (Individual)**: Şirket gerekmez; kimlik belgesiyle yapılır.
- **Dropshipping Developer (Corporation)**: Şirket belgeleri gerekir.

Öneri: Şirket kurulacağı için başvuruyu **şirket kurulduktan sonra Corporation** olarak yapmak.
Bireysel profil zaten onaylanmışsa değiştirilemez; o durumda şirket için yeni bir geliştirici hesabı gerekebilir.

## Adımlar
1. **Uygulama Konsolu'na gir:** https://openservice.aliexpress.com/app/index.htm (Seltigo uygulamasını açan AliExpress geliştirici hesabıyla).
   Uygulamanın kategorisinin "Drop Shipping" olduğunu ve durumunun "Test" olduğunu kontrol et.
2. **Profili tamamla:** Sağ üstte kullanıcı adı → Profile. Ülke: Turkey. Geliştirici türü: yukarıdaki karara göre.
   Kimlik/şirket belgelerini yükle. AliExpress ekibi inceler; yayına almak için profilin onaylı olması şart.
3. **Uygulama bilgilerini güncelle** (App Management → Basic Information):
   - Uygulama adı: `Seltigo`
   - Callback URL: `https://mustafabahsimb-eng.github.io/hizlisatici-ai/aliexpress-callback.html` (değiştirme; sistem bu adresi kullanıyor)
   - Logo: Seltigo logosu (yoksa varsayılan logo kabul ediliyor)
   - Açıklama: aşağıdaki **Metin A**
4. **API izin gruplarını kontrol et** (App Overview → API Permission Group): Dropshipping ürün, sipariş,
   kargo/lojistik grupları "Active" olmalı. "Inactive" olan varsa **Apply** → **Metin B**.
5. **Yayına alma başvurusu:** App Console → uygulama → **Apply Online**. Gerekçe istenirse **Metin C**.
6. **(Ayrı ve satıcı bazında) Otomatik ödeme (API Pay):** AliExpress'te API ile ödeme, her alıcı hesabının
   AliExpress'in otomatik ödeme beyaz listesine alınmasıyla açılıyor; ödeme AliExpress'e bağlı **PayPal** ile yapılıyor.
   Başvuru: `ds-api@aliexpress.com` adresine **Metin D**. Onaydan sonra belgede verilen sayfadan "Apply" ile anlaşma kabul edilir.
   Dikkat: Belgedeki desteklenen ülke listesinde **Türkiye yok**. Bu yüzden Türkiye'deki satıcılar için otomatik ödeme
   onaylanmayabilir; o durumda Seltigo siparişi verip "Ödeme bekliyor"a düşürür ve satıcı AliExpress'te öder.

## Başvuru metinleri (İngilizce, kopyalayıp yapıştır)

### Metin A — Uygulama açıklaması
> Seltigo is a multi-channel e-commerce management platform for small and mid-sized online sellers.
> Sellers connect their own AliExpress buyer account through OAuth and use Seltigo to source products,
> calculate landed cost (product + cheapest available shipping to the buyer's country), and automatically
> place dropshipping orders on AliExpress when an order arrives in their own online store.
> Seltigo then tracks the AliExpress order and shipment and shares the tracking number with the end customer.
> Each seller only accesses their own AliExpress account and orders; credentials are encrypted at rest.

### Metin B — API izin grubu gerekçesi
> We need this permission group to support the dropshipping workflow of our sellers: retrieving product and
> SKU details (aliexpress.ds.product.get), calculating shipping options and cost to the destination country
> (aliexpress.ds.freight.query / aliexpress.logistics.buyer.freight.calculate), placing orders on behalf of the
> authorized buyer account (aliexpress.ds.order.create) and tracking order status and shipments
> (aliexpress.trade.ds.order.get, aliexpress.ds.order.tracking.get). All calls are made only with the token of
> the seller who authorized our app.

### Metin C — Yayına alma (Apply Online) notu
> Seltigo has completed development and end-to-end testing with a real AliExpress buyer account in the test
> environment: OAuth authorization and token refresh, product/SKU retrieval, shipping cost calculation for Turkey,
> order creation without payment (try_to_pay=false) and order status retrieval all work as expected.
> We would like to go online so that our sellers can authorize the app with production token validity.
> Privacy policy: https://mustafabahsimb-eng.github.io/hizlisatici-ai/gizlilik.html

### Metin D — Otomatik ödeme (API Pay) e-postası
Kime: `ds-api@aliexpress.com` — Konu: `API Pay whitelist request – Seltigo (AppKey: <APP_KEY>)`
> Hello AliExpress DS team,
>
> We would like to enable automatic payment (API Pay) for our dropshipping app.
> - App name / AppKey: Seltigo / <APP_KEY>
> - Key markets: <ÜLKELER, ör. Turkey, Germany, United Kingdom>
> - AliExpress buyer account used for API payment: <ALICI HESAP E-POSTASI>
> - PayPal account used for API payment (bound to AliExpress): <PAYPAL E-POSTASI>
> - AliExpress User ID: <USER ID>
> - AliExpress Login ID: <LOGIN ID>
>
> Thank you,
> <Ad Soyad>, Seltigo

`<...>` alanları başvuru anında doldurulacak. AppKey Uygulama Konsolu → App Management → Advanced Information'da görünür.

## Yayından sonra Seltigo tarafında yapılacak
- Hiçbir kod değişikliği gerekmiyor: sistem anahtar sürelerini AliExpress'in döndürdüğü değerlerden okuyor.
- Site sahibi ve satıcılar bir kez yeniden bağlanır (yeni süreler yayın aşamasının olur).
- Panel uyarısı, iznin bitişine 1 gün kala "yeniden bağla" demeye devam eder.
