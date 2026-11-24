-- =====================================================================
-- Uzman Hedef Takip — 0002: veritabanı içi yedek zamanlayıcı (pg_cron)
-- Vercel Cron'a ek güvence: her saat başı eksik kapanışları tamamlar.
-- pg_cron etkinleştirilemezse yalnızca uyarı verir, kurulum bozulmaz.
-- =====================================================================
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule(
    'uzman-hedef-gunluk-kapanis',
    '15 * * * *',
    $job$select public.catch_up_closes('pg_cron')$job$
  );
exception when others then
  raise notice 'pg_cron kurulamadı (Vercel Cron yine çalışır): %', sqlerrm;
end $$;
