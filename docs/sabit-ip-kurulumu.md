# Sabit IP (çıkış proxy'si) kurulumu

**Durum (11 Ekim 2026): her şey hazır, anahtar KAPALI.** Sunucu alınmadı (ödeme sonraya). Kapalıyken
sistem bugünkü gibi doğrudan bağlantıyla çalışır.

## Neden gerekli
Supabase Edge Function'larının sabit bir IP adresi yok (her istek farklı bir AWS adresinden çıkıyor).
- **CJ:** aynı IP'den en fazla 3 kullanıcı hesabı ("Too Many Requests, one ip limit 3 users"). Testlerde
  defalarca görüldü; satıcı sayısı artınca CJ işlemleri aksar.
- **Trendyol test ortamı:** yalnız izin verilen IP'den bağlanılabiliyor.
- **eMAG:** her satıcı bizim IP'mizi kendi hesabına ekliyor.

## Nasıl çalışıyor
```
Edge Function ──(anahtar açık + hedef listede)──► Hetzner Squid (sabit IPv4) ──► CJ / Trendyol / eMAG
      │
      └──(anahtar kapalı / proxy bozuk / hedef listede değil)──► doğrudan bağlantı (bugünkü yol)
```
- **Kod:** `supabase/functions/_shared/egress.ts` — fonksiyonun başında `installEgress()` çağrılır, başka
  hiçbir şey değişmez. Ekli fonksiyonlar: cj-alt-match, cj-order-worker, cj-search, cj-tracking-sync,
  stock-price-monitor, trendyol-catalog, trendyol-verify. Yeni pazaryeri fonksiyonlarına da aynı iki satır eklenir.
- **Anahtar ve ayar:** veritabanında `egress_proxy` tablosu (tek satır): `enabled` (ana anahtar, varsayılan
  false), `host` (sunucunun IPv4'ü), `port` (3128), `username` (seltigo), `hosts` (proxy'den çıkacak alan
  adları), `status` (ok / down / unknown, sağlık kontrolü yazar). Değişiklik en geç 1 dakikada uygulanır;
  yeniden yayın gerekmez.
- **Şifre:** Edge Function secret `EGRESS_PROXY_PASSWORD` (kayıtlı). Aynı değer yalnız bu bilgisayarda
  `%LOCALAPPDATA%\seltigo-sabit-ip\proxy.env` dosyasında. Depoda ve veritabanında yok.
- **Sağlık kontrolü:** `egress-health` fonksiyonu 10 dakikada bir çalışır (`egress-health-10min`). Anahtar
  açıkken proxy üzerinden çıkış IP'sini sorar; IP sunucunun adresiyle aynıysa `status=ok`. Art arda 2 hata
  → `status=down` ve tüm fonksiyonlar doğrudan bağlantıya döner; sunucu düzelince ilk başarılı kontrolde
  kendiliğinden geri açılır.
- **Anlık geri dönüş:** bir istek proxy'ye ulaşamazsa aynı istek doğrudan bağlantıyla tekrarlanır ve o
  fonksiyon kopyası 5 dakika proxy'yi denemez. Hata `egress_proxy.last_error`'a yazılır. İstisna: sipariş
  oluşturma gibi tekrarlanınca çift işlem yaratabilecek istekler, proxy yanıt beklerken zaman aşımına
  uğrarsa tekrarlanmaz (bir sonraki zamanlanmış denemede yeniden yapılır).

## Sunucu tarafı (`infra/sabit-ip/`)
| Dosya | Görevi |
|---|---|
| `kurulum.sh` | Ubuntu 24.04'e Squid, şifre, izinli alanlar, güvenlik duvarı (ufw: yalnız SSH + 3128), fail2ban, otomatik güvenlik güncellemeleri (gerekirse 04:30 UTC'de yeniden başlatma), Squid çökerse otomatik yeniden başlatma. Tekrar çalıştırmak güvenli. |
| `squid.conf` | Yalnız şifreli istemci, yalnız HTTPS tüneli, yalnız izinli alan adları, çıkış daima sunucunun IPv4'ünden, önbellek yok. |
| `izinli-alanlar.txt` | Proxy'nin izin verdiği alan adları. Sunucu bu dosyayı **15 dakikada bir GitHub'dan çeker**; commit edilen değişiklik kendiliğinden uygulanır (bozuk liste uygulanmaz). |
| `alan-guncelle.sh` | Yukarıdaki güncelleyici (systemd zamanlayıcısı). |
| `hazirla.py` | Hetzner'e yapıştırılacak "Cloud config" metnini üretir (şifreyi içerir, yalnız bu bilgisayarda kalır). Kurulum betiğini sabit bir commit'ten indirir. |

Betik her değişiklikte GitHub Actions'ta ücretsiz bir Ubuntu 24.04 makinesinde denenir
(`.github/workflows/sabit-ip-kurulum-testi.yml`): şifreli ve izinli istek geçiyor mu, şifresiz / yanlış şifreli /
izinsiz alan adına giden / düz HTTP istekleri reddediliyor mu, güncelleyici ve otomatik güncellemeler ayarlı mı.

## Sunucuyu alacağın gün
**Senin yapacakların (yaklaşık 5 dakika):**
1. https://console.hetzner.com adresinde hesap aç / giriş yap, ödeme yöntemini ekle.
2. Yeni proje → **Add Server**:
   - Location: **Nuremberg** veya **Falkenstein** (Almanya; Supabase de Frankfurt'ta)
   - Image: **Ubuntu 24.04**
   - Type: **CX23** (€5,49 + IPv4 €0,50) ya da stok yoksa **CPX02** (€6,49, IPv4 dahil)
   - Networking: **Public IPv4 açık** (IPv6 isteğe bağlı)
   - SSH key: varsa ekle (eklenirse şifreyle giriş kendiliğinden kapanır)
   - **Cloud config:** Claude'un o gün vereceği metni yapıştır (Claude `python infra/sabit-ip/hazirla.py` ile üretir)
3. **Create & Buy now** → sunucunun **IPv4 adresini** Claude'a yaz.

**Claude'un yapacakları:**
1. Kurulumun bitmesini bekler (2–4 dakika), `egress-health` deneme modu ile sınar
   (`{ cronSecret, test: { host: "<IP>" } }` — kaydetmez): çıkış IP'si doğru mu, CJ'ye tünel açılıyor mu.
2. Anahtarı açar:
   ```sql
   update egress_proxy set host = '<IP>', enabled = true, status = 'unknown', fail_count = 0 where id = 1;
   ```
3. 10 dakika içinde `egress-health` `status=ok` yazar; CJ işlemleri proxy'den çıkmaya başlar. Doğrular.
4. IP'yi gereken yerlere bildirir: Trendyol test ortamı IP izni (Trendyol entegrasyon ekibine e-posta;
   şirket gerekli); eMAG bağlantısı yapılırken satıcıya bu IP'yi hesabına eklemesi söylenecek
   (eMAG bağlantı ekranı yapılınca IP oraya yazılacak).

**Kapatmak gerekirse:** `update egress_proxy set enabled = false where id = 1;` — 1 dakika içinde her şey
doğrudan bağlantıya döner.

**Alternatif (senin için daha da az iş):** Hetzner panelinde Security → API Tokens'tan "Read & Write" bir
anahtar oluşturup Claude'a verirsen sunucuyu Claude API ile oluşturur ve kurar; anahtar yalnız bu
bilgisayarda tutulur, iş bitince panelden silebilirsin.

## Yeni bir alan adı eklemek
İki yere eklenir: `egress_proxy.hosts` (veritabanı) ve `infra/sabit-ip/izinli-alanlar.txt` (commit + push;
sunucu 15 dakika içinde alır). Yalnız birine eklenirse istek proxy'de reddedilir ve fonksiyon doğrudan
bağlantıya döner (bozulmaz, ama sabit IP'den çıkmaz).

## Güvenlik notları
- Proxy yalnız şifreli istemciye ve yalnız listedeki alan adlarına tünel açar; açık proxy değildir.
- Supabase'in çıkış adresleri değişken olduğundan 3128 portu kaynak IP ile kısıtlanamıyor; koruma şifre +
  alan adı listesidir. Şifre proxy'ye düz HTTP üzerinden gider ama CJ/Trendyol trafiğinin kendisi uçtan uca
  TLS ile şifreli kalır; şifre ele geçse bile yalnız listedeki adreslere bizim IP'mizle gidilebilir.
- Şifreyi değiştirmek için: yeni şifre → `proxy.env` → `supabase secrets set --env-file ...` → sunucuda
  `htpasswd -bm /etc/squid/passwd seltigo '<yeni>'` (ya da `hazirla.py` ile yeni sunucu).

## Sorun giderme
- Sunucuda kurulum kaydı: `/var/log/seltigo-kurulum.log`; Squid: `journalctl -u squid`, `/var/log/squid/access.log`.
- Veritabanında: `select status, fail_count, last_ip, last_ok_at, last_error, last_error_at from egress_proxy;`
- Denenmiş bulgu (11 Ekim 2026): Supabase çalışma ortamı proxy'yi destekliyor (`Deno.createHttpClient`
  mevcut); kapalı bir proxy adresiyle istek 0,7 saniyede doğrudan bağlantıya döndü. Supabase'in doğrudan
  çıkışı IPv6 olabiliyor; Squid ise çıkışı sunucunun IPv4'üne sabitliyor.
