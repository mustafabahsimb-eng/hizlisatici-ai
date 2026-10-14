# Etsy ilan kapağı (mockup) araçları — ilk sürüm (elle çalıştırılır)

bahsistore'un ilk 25 dijital ilanı için kullanıldı (15 Ekim 2026). İleride panel özelliği olacak (YOL-HARITASI.md "Otomatik ilan kapağı").

- `gather.py` + `sheets.py`: Pexels'te (ticari kullanım serbest) çerçeveli oda fotoğrafı arar (etsy-listings `stock_photos` sistem işlemi; anahtar Supabase'de), aday sayfaları oluşturur.
- `detect.py`: fotoğraftaki çerçeve iç alanlarını bulur (OpenCV kenar + dörtgen).
- `mock.py`: çerçeve içini seçer / kenarları düzeltir, tasarımı perspektifle yerleştirir, odanın ışığını tasarıma uygular, kare kırpar.
- `gallery.py`: setler için 4 çerçeveli galeri duvarı (eski çerçeveyi duvardan silip yeni çerçeveler çizer ya da gerçek 4 çerçeveyi kullanır).
- `extras.py`: düz tasarım görseli + stile uygun "5 Print Sizes Included" görseli (Lora / Poppins, OFL).
- `syscall.py`: Edge Function sistem çağrısı (cron komutu kopyalanır; gizli anahtar dışarı çıkmaz).

Kurulum: Python 3.14, `numpy==2.4.4 opencv-python-headless==4.13.0.92 pillow==11.3.0` (%LOCALAPPDATA%\seltigo-mockup).
Satılık tasarım dosyaları depoya GİRMEZ (.gitignore: bahsistore_etsy_paket*).
