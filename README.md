# Uzman Hedef Takip (v2)

Uzmanların günlük Post Pre ve Savedesk adetlerini GSM numarasıyla kaydettiği, yöneticinin anlık izleyip düzeltebildiği web uygulaması. Tasarım: `çalışma.xlsx`.

| | |
|---|---|
| Site | https://taner-uw8t.vercel.app |
| Yönetici | https://taner-uw8t.vercel.app/yonetici |
| Sağlık kontrolü | https://taner-uw8t.vercel.app/api/health |
| GitHub | https://github.com/tnrgltkn23/taner |
| Supabase | https://supabase.com/dashboard/project/zexgsgdhllguscyhlbfc |

## Ekranlar
- **Giriş:** uzman = kullanıcı adı (küçük harf, Türkçe karakter yok) + 5 haneli şifre; yönetici = yalnızca şifre.
- **Günlük Skor (uzman):** hedef kartı, 6 sayaç (484 İkna, 484 Geçiş, 14271, 16234 İkna, 16234 İptal, 17891), her "Ekle" için 10 haneli GSM zorunlu, aynı GSM tekrarında Evet/Hayır onayı, 10 saniye içinde geri alma, hedefe göre kırmızı/yeşil oran.
- **Geçmiş Skorlarım (uzman):** seçilen günün adetleri ve kalem bazında GSM listesi.
- **Günlük Skor (yönetici):** Tümü → kullanıcı bazında toplamlar ve oranlar (GSM yok); tek kullanıcı → GSM bazında kayıtlar, altta genel toplam, düzeltme ve silme.
- **Geçmiş Skorlar (yönetici):** ay seçimi, gün gün toplamlar ve oranlar, tek kullanıcıda hücre düzeltme.
- **Yönetici Paneli:** hedef kartı, bakım modu, kullanıcı ekle/sil/şifre değiştir, yönetici şifresi, son işlemler.

## Oranlar
- Post Pre % = 484 İkna ÷ (484 İkna + 484 Geçiş + 14271)
- Savedesk % = 16234 İkna ÷ (16234 İkna + 16234 İptal + 17891)

## Güvenlik
- Şifreler PBKDF2-SHA256 hash olarak saklanır; `password_hash` sütunu tarayıcıya hiç açılmaz.
- Hatalı giriş sınırı: kullanıcı başına 15 dakikada 5, yönetici için IP başına 5.
- RLS: uzman yalnızca kendi kayıtlarını görür; yönetici herkesi görür.
- Uzman yazma işlemleri yalnızca `add_entry` / `undo_entry` veritabanı fonksiyonlarıyla; yönetici işlemleri `api/admin.js` (JWT + rol kontrolü + denetim kaydı).
- GSM numaraları 2 ay sonra otomatik silinir (adetler kalır): Vercel Cron `/api/cron/daily` + Supabase pg_cron.
- `SUPABASE_SECRET_KEY` ve `CRON_SECRET` yalnızca Vercel ortam değişkenlerinde.

## Kurulum
1. `supabase/migrations/0001_schema.sql` SQL Editor'de çalıştırılır.
2. Kullanıcılar yönetici panelinden eklenir (ilk yüklemede Dash listesi hash'lenmiş olarak ayrı bir SQL ile aktarıldı; o dosya depoda tutulmaz).
3. Vercel ortam değişkenleri: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `CRON_SECRET`.
