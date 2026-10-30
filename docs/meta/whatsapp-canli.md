# Seltigo Asistan — WhatsApp'ı canlıya alma

Uygulama: https://developers.facebook.com/apps/1650835089949068/ · Phone Number ID `1415741358278336` · WABA ID `1075417118426038`
(İkisi Supabase secrets'ta: `ASSISTANT_WA_PHONE_ID`, `ASSISTANT_WA_WABA_ID`.)

## 1) Kalıcı anahtar (System User) — Mustafa tıklar, anahtarı Claude'a verir
1. https://business.facebook.com/settings/system-users → **Add** → ad `Seltigo Asistan`, rol **Admin** → Create.
2. Aynı ekranda kullanıcıyı seç → **Assign assets**:
   - Apps → `Seltigo` (1650835089949068) → **Full control** (Manage app).
   - WhatsApp accounts → WABA `1075417118426038` → **Full control**.
3. **Generate new token** → uygulama `Seltigo` → Token expiration **Never** → izinler `whatsapp_business_messaging`, `whatsapp_business_management` → Generate → anahtarı kopyala, Claude'a gönder.

Claude sonra: `ASSISTANT_WA_TOKEN` (kalıcı), `ASSISTANT_WA_DISPLAY_NUMBER` (Graph API'den), `ASSISTANT_WA_ENABLED=true` yazar; WABA'yı uygulamaya abone eder
(`POST /{WABA}/subscribed_apps`); bildirim şablonunu (`seltigo_asistan_bildirim_v1`) onaya gönderir; gerçek WhatsApp testini yapar.
Geçici (24 saatlik) anahtarla da aynı test yapılabilir; anahtar bitince kalıcısı girilir.

## 2) Webhook — Mustafa tıklar
1. Bir kelime uydur (ör. `seltigo-` + rastgele harfler). https://supabase.com/dashboard/project/ytucdrrgxsjhrqmaxckt/functions/secrets → `WHATSAPP_VERIFY_TOKEN` = o kelime → Save.
2. https://developers.facebook.com/apps/1650835089949068/ → sol menü WhatsApp → **Configuration** → Webhook → **Edit**:
   - Callback URL: `https://ytucdrrgxsjhrqmaxckt.supabase.co/functions/v1/whatsapp-webhook`
   - Verify token: aynı kelime → **Verify and save**
3. Webhook fields → **messages** → Subscribe.

## 3) Uygulamayı yayınlama (Unpublished → Live) — Mustafa tıklar
https://developers.facebook.com/apps/1650835089949068/settings/basic/ alanları:
| Alan | Değer |
|---|---|
| App icon (1024×1024) | `docs/meta/seltigo-icon-1024.png` (depoda; https://github.com/mustafabahsimb-eng/hizlisatici-ai/raw/main/docs/meta/seltigo-icon-1024.png) |
| Privacy Policy URL | https://mustafabahsimb-eng.github.io/hizlisatici-ai/gizlilik.html |
| User data deletion → Data deletion instructions URL | https://mustafabahsimb-eng.github.io/hizlisatici-ai/gizlilik.html#veri-silme |
| Category | Business and pages |
| Contact email | mustafabahsi.mb@gmail.com |

Save changes → üst çubukta **App Mode: Live** (ya da sol menü "Publish" → Publish).
Not: Test numarasında, alıcı listesindeki numaralardan gelen mesajlar geliştirme modunda da webhook'a düşer; Live yalnız
bu çalışmazsa ya da gerçek numaraya geçerken gerekir. İşletme doğrulaması ve "Advanced access" (gerçek müşteri numaraları) şirket kurulunca.
