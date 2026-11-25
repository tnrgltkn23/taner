-- =====================================================================
-- 0002 — Dönem toplamları (Yönetici Ana Sayfa + Geçmiş Skorlar "Tümü")
-- day_totals gün × kullanıcı × kalem satırı döndürür; 45 uzman × 30 gün
-- Supabase'in 1000 satır sınırını aşar. Bu fonksiyon kullanıcıları
-- birleştirir: en fazla 31 gün × 6 kalem satır.
-- RLS geçerlidir (security invoker): uzman yalnız kendi verisini toplar.
-- =====================================================================
create or replace function public.period_totals(
  p_from date, p_to date, p_user uuid default null, p_by_day boolean default false
)
returns table (day date, item text, total bigint)
language sql stable set search_path = public
as $$
  select case when p_by_day then e.day end as day,
         e.item,
         sum(e.delta)::bigint as total
  from entries e
  where e.deleted_at is null and e.day between p_from and p_to
    and (p_user is null or e.user_id = p_user)
  group by 1, e.item
$$;

revoke all on function public.period_totals(date, date, uuid, boolean) from public, anon;
grant execute on function public.period_totals(date, date, uuid, boolean) to authenticated;
