-- =====================================================================
-- 0005 — Resmi rapor (Churn Aktivite) ile site girişlerinin karşılaştırılması
-- Yönetici her gün raporu yükler; tarayıcı Excel'i kişi × gün × kalem toplamlarına
-- indirger, sunucu bu tabloya yazar. 0004'ten bağımsızdır.
-- =====================================================================

create table if not exists public.official_totals (
  day         date not null,
  username    text not null,                       -- rapordaki kullanıcı (küçük harf)
  user_id     uuid references public.users(id),    -- sitede eşleşen uzman (yoksa null)
  item        text not null check (item in ('pp_ikna', 'pp_gecis', 'pp_14271', 'sd_ikna', 'sd_iptal', 'sd_17891')),
  total       int  not null check (total >= 0),
  upload_id   bigint,
  primary key (day, username, item)
);
create index if not exists official_totals_user_day_idx on public.official_totals (user_id, day);

create table if not exists public.official_uploads (
  id          bigserial primary key,
  filename    text not null,
  day_from    date not null,
  day_to      date not null,
  row_count   int  not null,
  matched     int  not null,
  uploaded_by uuid references public.users(id),
  uploaded_at timestamptz not null default now()
);

alter table public.official_totals  enable row level security;
alter table public.official_uploads enable row level security;
revoke all on public.official_totals, public.official_uploads from anon, authenticated;
grant select on public.official_totals, public.official_uploads to authenticated;

-- Uzman yalnızca kendi resmi verisini, yönetici hepsini görür
drop policy if exists official_totals_select on public.official_totals;
create policy official_totals_select on public.official_totals for select to authenticated
  using (public.is_admin() or user_id = public.current_user_id());
drop policy if exists official_uploads_select on public.official_uploads;
create policy official_uploads_select on public.official_uploads for select to authenticated
  using (public.is_admin());

-- Resmi raporu yüklenmiş günler (gizli bilgi içermez; uzmanın kendi satırı olmasa da gün sayılır)
create or replace function public.official_days(p_from date, p_to date)
returns setof date language sql stable security definer set search_path = public
as $$ select distinct day from official_totals where day between p_from and p_to $$;
revoke all on function public.official_days(date, date) from public, anon;
grant execute on function public.official_days(date, date) to authenticated;

-- Karşılaştırma: seçilen aralıkta yalnızca resmi raporu olan günler üzerinden
-- uzman × kalem bazında site toplamı ve resmi toplam (RLS geçerli: uzman yalnız kendini görür)
create or replace function public.report_compare(p_from date, p_to date)
returns table (user_id uuid, item text, site_total bigint, official_total bigint, days_count int)
language sql stable set search_path = public
as $$
  with od as (
    select d as day from official_days(p_from, p_to) d
  ), s as (
    select e.user_id, e.item, sum(e.delta)::bigint as t
    from entries e join od on od.day = e.day
    where e.deleted_at is null
    group by e.user_id, e.item
  ), o as (
    select ot.user_id, ot.item, sum(ot.total)::bigint as t
    from official_totals ot
    where ot.day between p_from and p_to and ot.user_id is not null
    group by ot.user_id, ot.item
  )
  select coalesce(s.user_id, o.user_id), coalesce(s.item, o.item), coalesce(s.t, 0), coalesce(o.t, 0),
         (select count(*)::int from od)
  from s full join o on s.user_id = o.user_id and s.item = o.item
$$;
revoke all on function public.report_compare(date, date) from public, anon;
grant execute on function public.report_compare(date, date) to authenticated;
