# Trendruum entegrasyonu

Trendruum (trendruum.com) yerli pazaryeri; satıcı paneli seller.trendruum.com. Entegra ve Dopigo zaten bağlı.
Seltigo'da Trendyol / Hepsiburada / Pazarama ile aynı yapıda kuruldu (19 Ekim 2026).

## Durum
- Kod tamam ve canlıda, **varsayılan KAPALI**: Edge secret `TRENDRUUM_ENABLED=true` olmadan Trendruum'a hiçbir istek gitmez.
  - Kapalıyken: Hesaplarım'dan bağlanan satıcının bilgileri şifreli kasaya kaydedilir, bağlantı "onay bekliyor" görünür; ilanlar yalnız **prova** (yerel kontroller) olur; sipariş çekilmez.
- Trendruum'un API belgesi yalnız satıcı panelinde. Uç noktalar entegratör rehberlerindeki akışa göre kuruldu ve **satıcı hesabıyla doğrulanacak**.
- Satıcı hesabı şirket kurulunca açılacak (başvuru şahıs / limited / anonim şirket ister): https://seller.trendruum.com/onboarding/satici-formu/pazaryeri

## Parçalar
| Parça | Yer |
|---|---|
| Ortak modül (bağlantı, kategori / marka / nitelik, ilan, fiyat-stok, sipariş, takip) | `supabase/functions/_shared/trendruum.ts` |
| Bağlantı doğrulama | `trendruum-verify` (store-connect çağırır) |
| İlan kuyruğu adaptörü | `sync-worker` → `trendruumAdapter` (`trendruum_tr`) |
| Sipariş çekme + takip bildirimi | `marketplace-orders` (15 dk) → `_shared/marketplace-orders.ts` `trendruum` |
| Panel kartı | `accounts.html` (Client ID / Client Secret) |
| Pazaryeri kaydı + paket anahtarı | `supabase/migrations/20261020_trendruum.sql` (`marketplaces.trendruum_tr`, `feature_flags.trendruum`) |
| Test (sahte yanıt) | `tests/marketplaces/trendruum_mock_test.ts` (11/11) |

## Akış
- **Bağlantı:** Client ID + Client Secret (panel: Hesap Bilgilerim > Entegrasyon Bilgileri) → JWT erişim anahtarı (süresine göre önbellek; 401'de bir kez yenilenir).
- **İlan (HIZ KURALI):** kategori önce satıcının aynı kategori anahtarlı önceki ilanından öğrenilir, yoksa kelime eşleşmesi + yapay zekâ en alt kategoriyi seçer; marka Trendruum listesinden birebir; zorunlu nitelikler üründen (renk / beden / özellikler), kalanları yapay zekâ doldurur. Seçenekler ayrı barkodla aynı ana kodda (`SLT-<ürün no>`). Barkod yoksa Seltigo barkodu (`SLT…`).
- **Fiyat / stok:** içerik değişmediyse yalnız fiyat-stok ucu (yapay zekâ yok, saniyeler). Stok değişince ilan kuyruğa kendiliğinden düşer (`products_enqueue_stock_sync`). Satıştan kaldırma = stok 0.
- **Sipariş:** webhook yok, 15 dakikada bir çekilir. Trendruum Kargo ile giden paketin takip numarası siparişle gelir (`marketplaceShips`); satıcı kendi kargosuyla gönderirse Seltigo gönderiyi / etiketi oluşturur ve takip numarasını Trendruum'a yazar.
- **Açılış günü:** `TRENDRUUM_ENABLED=true` girilince "onay bekliyor" bağlantılar bir sonraki sipariş turunda kendiliğinden doğrulanır; satıcı bir şey yapmaz.

## Açılış günü (satıcı hesabı gelince) yapılacaklar
1. Satıcı panelindeki API belgesinden uç nokta adreslerini al; `_shared/trendruum.ts` içindeki `DEFAULT_PATHS` ile karşılaştır.
   Farklıysa kod değiştirmeden secret'larla düzelt: `TRENDRUUM_API_BASE` (ör. `https://api.trendruum.com`), gerekirse `TRENDRUUM_PATHS` (JSON, yalnız farklı olanlar; ör. `{"token":"/oauth/token"}`).
2. Gerçek cevap alanlarını sahte testtekilerle karşılaştır (`tests/marketplaces/trendruum_mock_test.ts`), gerekirse esnek okuyucuya alan adı ekle.
3. Edge secret `TRENDRUUM_ENABLED=true`.
4. Hesaplarım > Trendruum ile bağlan → bir ürünü gönder → fiyat / stok değiştir → test siparişinde takip bildirimi.
5. Komisyon: Trendruum oranları kategoriye ve sözleşmeye göre değişiyor, dışarıda yayınlanmıyor; panel / API'den okunup `listings.commission_pct`'e yazılacak (şimdilik satıcı girer, zarar kontrolü onunla çalışır).

## Bilinen sınırlar
- Uç nokta adresleri ve alan adları tahmini (belge satıcı panelinde); okuyucular birden çok olası alan adını dener.
- Marka Trendruum listesinde yoksa ilan "marka talebi gerekir" hatasıyla durur (Trendruum marka talebini panelden alıyor).
- İade reddi yalnız Trendruum panelinden yapılabiliyor (rehber bilgisi).
