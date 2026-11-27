-- =====================================================================
-- GERİ ALMA: 0005 (resmi rapor karşılaştırması)
-- Yalnızca bu özelliğin eklediği tablo ve fonksiyonları kaldırır; uzman kayıtları,
-- kullanıcılar ve diğer veriler etkilenmez. Önce kodu eski sürüme döndürün
-- (git etiketi: yedek/2026-11-27-rapor-oncesi veya Vercel → Instant Rollback),
-- sonra bu dosyayı Supabase SQL Editor'de çalıştırın.
-- =====================================================================
drop function if exists public.report_compare(date, date);
drop function if exists public.official_days(date, date);
drop table if exists public.official_totals;
drop table if exists public.official_uploads;
