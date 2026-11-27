-- =====================================================================
-- 0004 — Uzman Mola portalı
-- Günlük Verilerim ekranları mevcut tablolarımızı kullanır; bu dosya yalnızca
-- portalın ihtiyaç duyduğu ek alanları ekler. 0003'ten sonra çalıştırılır.
-- =====================================================================

-- Uzmanın ad soyadı (mola planındaki adla eşleşir) ve çerez oturumu sürümü
alter table public.users add column if not exists full_name text check (full_name is null or length(full_name) between 2 and 100);
alter table public.users add column if not exists session_version uuid not null default gen_random_uuid();
grant select (full_name) on public.users to authenticated;

-- Her kayda kalıcı bir kimlik (portal ekranları kayıtları UUID ile tanır;
-- uzman ekranı aynı isteği iki kez gönderirse kayıt ikilenmez)
alter table public.entries add column if not exists uid uuid not null default gen_random_uuid();
create unique index if not exists entries_uid_idx on public.entries (uid);

-- Mola planları (gün başına bir plan; çalışan listesi ve mola saatleri)
create table if not exists public.mola_plans (
  date       date primary key,
  data       jsonb not null,
  filename   text not null default 'Plan',
  updated_at timestamptz not null default now()
);

-- Portal ayarları (site geneli bakım vb.)
create table if not exists public.portal_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
insert into public.portal_settings (key, value) values ('maintenance', '{"enabled": false, "message": ""}')
on conflict (key) do nothing;

-- Yalnızca sunucu (service role) erişir
alter table public.mola_plans      enable row level security;
alter table public.portal_settings enable row level security;
revoke all on public.mola_plans, public.portal_settings from anon, authenticated;

-- Yönetici raporu: gün × uzman × kalem toplamları (ad, kullanıcı adı, takım ile)
create or replace function public.portal_report(p_from date, p_to date, p_user uuid default null, p_team uuid default null)
returns table (day date, user_id uuid, name text, username text, team text, item text, total bigint)
language sql stable security definer set search_path = public
as $$
  select e.day, e.user_id, coalesce(u.full_name, u.username), u.username, t.name, e.item, sum(e.delta)::bigint
  from entries e
  join users u on u.id = e.user_id
  left join team_leaders t on t.id = u.team_leader_id
  where e.deleted_at is null and e.day between p_from and p_to
    and (p_user is null or e.user_id = p_user)
    and (p_team is null or u.team_leader_id = p_team)
  group by e.day, e.user_id, u.full_name, u.username, t.name, e.item
  order by e.day desc, coalesce(u.full_name, u.username), e.item
$$;

-- Yarışma sonucu: saat aralığında uzmanların girdiği ikna adetleri (takım filtresiyle)
create or replace function public.portal_contest_results(p_from timestamptz, p_to timestamptz, p_team uuid default null)
returns table (name text, username text, team text, pp bigint, sd bigint, total bigint)
language sql stable security definer set search_path = public
as $$
  select coalesce(u.full_name, u.username), u.username, t.name,
         count(*) filter (where e.item = 'pp_ikna'), count(*) filter (where e.item = 'sd_ikna'), count(*)
  from entries e
  join users u on u.id = e.user_id
  left join team_leaders t on t.id = u.team_leader_id
  where e.deleted_at is null and e.source = 'user' and e.item in ('pp_ikna', 'sd_ikna')
    and e.created_at >= p_from and e.created_at < p_to
    and (p_team is null or u.team_leader_id = p_team)
  group by u.id, u.full_name, u.username, t.name
  order by count(*) desc, coalesce(u.full_name, u.username)
$$;

revoke all on function public.portal_report(date, date, uuid, uuid) from public, anon, authenticated;
revoke all on function public.portal_contest_results(timestamptz, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.portal_report(date, date, uuid, uuid) to service_role;
grant execute on function public.portal_contest_results(timestamptz, timestamptz, uuid) to service_role;
