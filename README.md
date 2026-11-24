# Uzman Hedef Takip

Uzmanların günlük sayaç işlemlerini, bireysel ve ekip hedeflerini gerçek zamanlı takip eden çok kullanıcılı web uygulaması.

- **Barındırma:** Vercel (statik arayüz + sunucu fonksiyonları, `main` dalından otomatik yayın)
- **Veritabanı:** Supabase PostgreSQL (RLS etkin), Supabase Realtime, Supabase Auth
- **Saat dilimi:** Europe/Istanbul

## Mimari

```
public/            Tarayıcı arayüzü (giriş, uzman ekranı, yönetici paneli)
api/               Vercel sunucu fonksiyonları (gizli anahtar yalnızca burada)
  config.js        Tarayıcıya gizli OLMAYAN ayarları verir
  login/request.js Uzman: kullanıcı adı -> cihaz onay isteği
  login/status.js  Uzman: onaylanınca sunucu tarafında oturum üretilir
  login/admin.js   Yönetici: kullanıcı adı + şifre (bcrypt)
  admin.js         Yönetici işlemleri (JWT + rol kontrolü, denetim kaydı)
  cron/daily-close.js  Günlük kapanış (Vercel Cron, CRON_SECRET ile korunur)
  health.js        Sağlık kontrolü
supabase/migrations/  Veritabanı şeması, fonksiyonlar, RLS, realtime
```

### Güvenlik
- Tüm tablolarda **RLS** açık. Uzman yalnızca kendi profilini, işlemlerini ve toplamlarını görür; başka uzmanların adlarını ve adetlerini göremez. Ekip için yalnızca kişi bilgisi içermeyen toplam tablo okunabilir.
- Uzman tarafından yapılabilen tek yazma işlemleri `record_event` (+1) ve `undo_my_event` (kendi bugünkü işlemi) veritabanı fonksiyonlarıdır. Doğrudan tablo yazma yetkisi yoktur.
- Sayaç artışı tek bir işlemde (`INSERT ... ON CONFLICT DO UPDATE total = total + 1`) yapılır; eşzamanlı işlemlerde veri kaybı olmaz.
- **Uzman girişi:** yalnızca kullanıcı adı yazılır, ancak kullanıcı adı tek başına yetki vermez. Yeni cihazdan her giriş, yönetici panelinde onay kodu ile birlikte bir istek oluşturur; yönetici onaylayınca oturum **sunucu tarafında** üretilir ve o cihazda açık kalır. Kullanıcı adının var olup olmadığı dışarı sızdırılmaz; denemeler IP başına sınırlandırılır.
- **Yönetici şifresi** veritabanında bcrypt hash olarak saklanır (başlangıç: `2637`, ilk girişten sonra Ayarlar'dan değiştirin). 15 dakikada 5 hatalı denemede kilitlenir.
- `SUPABASE_SECRET_KEY` yalnızca Vercel ortam değişkenlerindedir; tarayıcıya hiçbir zaman gönderilmez.
- Yönetici işlemleri `api/admin.js` içinde JWT doğrulaması + rol kontrolü ile yetkilendirilir ve `admin_audit` tablosuna yazılır.

### Günlük kapanış
- Vercel Cron her gün **00:05 Türkiye saati** (21:05 UTC) `/api/cron/daily-close` çağırır.
- Kapanış, eksik kalmış **tüm** geçmiş günleri telafi eder (`catch_up_closes`). Ayrıca:
  - Supabase `pg_cron` her saat başı aynı telafiyi çalıştırır (0002 migration),
  - her yönetici girişinde telafi tetiklenir,
  - Yönetici panelinde "Eksik kapanışları şimdi tamamla" düğmesi vardır.
- Kapanan güne ait işlemler artık geri alınamaz. Rapor, o günün sonundaki hedefleri (`goal_history`) kullanır.

## Ortamlar

| Vercel ortamı | Git dalı | Supabase projesi |
|---|---|---|
| Production | `main` | `uzman-hedef-prod` |
| Preview | diğer dallar (ör. `develop`) | `uzman-hedef-dev` |
| Development | yerel | `uzman-hedef-dev` |

Ortam değişkenleri her ortam için ayrı tanımlanır (bkz. `.env.example`):
`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` (Sensitive), `CRON_SECRET` (Sensitive).

## Kurulum özeti

1. Supabase'de proje oluştur (bölge: Frankfurt `eu-central-1`).
2. SQL Editor'de sırayla `supabase/migrations/0001_init.sql` ve `0002_pg_cron.sql` çalıştır.
3. Authentication > Sign In / Providers: **"Allow new users to sign up" kapalı**, Email sağlayıcısı açık.
4. GitHub'da depo oluştur, kodu `main` dalına gönder.
5. Vercel'de depoyu içe aktar (Framework: Other). Ortam değişkenlerini gir, deploy et.
6. Canlı sitede `/api/health` kontrol et, `admin` / `2637` ile gir ve şifreyi değiştir.

## Alan adı bağlama
Vercel > Project > Settings > Domains > alan adını ekle, DNS'e verilen `A`/`CNAME` kaydını gir. Ek kod değişikliği gerekmez.
