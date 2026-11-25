-- =====================================================================
-- 0003 — Takım liderleri, ikinci (üst) yönetici, mini yarışmalar,
--        yönetici giriş IP kayıtları (90 gün)
-- 0002_period_totals.sql'den sonra çalıştırılır.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Takım liderleri
-- ---------------------------------------------------------------------
create table if not exists public.team_leaders (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique check (length(btrim(name)) between 2 and 60),
  created_at timestamptz not null default now()
);
alter table public.users add column if not exists team_leader_id uuid references public.team_leaders(id) on delete set null;

-- ---------------------------------------------------------------------
-- İki yönetici: 2637 (yönetici) ve 7899 (üst yönetici, is_super)
-- İkisinin de rolü 'admin'; üst yönetici ayrıca giriş IP ekranını görür.
-- ---------------------------------------------------------------------
alter table public.users add column if not exists is_super boolean not null default false;
drop index if exists public.users_single_admin;
create unique index if not exists users_single_super on public.users (is_super) where is_super;
alter table public.users drop constraint if exists users_super_is_admin;
alter table public.users add constraint users_super_is_admin check (not is_super or role = 'admin');

-- ---------------------------------------------------------------------
-- Mini yarışmalar
-- ---------------------------------------------------------------------
create table if not exists public.contests (
  id           bigserial primary key,
  message      text not null check (length(message) between 5 and 300),
  target       int  not null check (target between 1 and 10000),
  prize        text not null check (length(btrim(prize)) between 1 and 120),
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  created_by   uuid references public.users(id),
  created_at   timestamptz not null default now(),
  cancelled_at timestamptz,
  check (ends_at > starts_at and ends_at - starts_at <= interval '24 hours')
);
create index if not exists contests_starts_idx on public.contests (starts_at desc);

-- ---------------------------------------------------------------------
-- Yönetici giriş kayıtları (yalnızca sunucu yazar/okur; 90 gün saklanır)
-- ---------------------------------------------------------------------
create table if not exists public.admin_logins (
  id         bigserial primary key,
  user_id    uuid references public.users(id),
  ip         text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists admin_logins_created_idx on public.admin_logins (created_at desc);

-- ---------------------------------------------------------------------
-- Raporlama fonksiyonları (security invoker: RLS geçerli)
-- ---------------------------------------------------------------------
-- Takım bazında dönem toplamları; takımı olmayanlar team_leader_id = null grubunda
create or replace function public.period_totals_by_team(p_from date, p_to date, p_by_day boolean default false)
returns table (team_leader_id uuid, day date, item text, total bigint)
language sql stable set search_path = public
as $$
  select u.team_leader_id,
         case when p_by_day then e.day end as day,
         e.item,
         sum(e.delta)::bigint as total
  from entries e
  join users u on u.id = e.user_id
  where e.deleted_at is null and e.day between p_from and p_to
  group by 1, 2, e.item
$$;

-- Yarışma sorgusu: saat aralığında uzmanların kendi girdiği ikna adetleri
create or replace function public.ikna_between(p_from timestamptz, p_to timestamptz)
returns table (user_id uuid, pp_ikna bigint, sd_ikna bigint)
language sql stable set search_path = public
as $$
  select e.user_id,
         count(*) filter (where e.item = 'pp_ikna')::bigint,
         count(*) filter (where e.item = 'sd_ikna')::bigint
  from entries e
  where e.deleted_at is null and e.source = 'user'
    and e.item in ('pp_ikna', 'sd_ikna')
    and e.created_at >= p_from and e.created_at < p_to
  group by e.user_id
$$;

-- Gece temizliği: 2 aydan eski GSM'ler + 90 günden eski yönetici giriş kayıtları
create or replace function public.purge_old_gsm()
returns int language plpgsql security definer set search_path = public
as $$
declare n int;
begin
  update entries set gsm = null where gsm is not null and created_at < now() - interval '2 months';
  get diagnostics n = row_count;
  delete from admin_logins where created_at < now() - interval '90 days';
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Yetkiler ve RLS
-- ---------------------------------------------------------------------
revoke all on public.team_leaders, public.contests, public.admin_logins from anon, authenticated;
grant select on public.team_leaders, public.contests to authenticated;
grant select (team_leader_id, is_super) on public.users to authenticated;

alter table public.team_leaders enable row level security;
alter table public.contests     enable row level security;
alter table public.admin_logins enable row level security;

drop policy if exists team_leaders_select on public.team_leaders;
create policy team_leaders_select on public.team_leaders for select to authenticated
  using (public.is_admin());
drop policy if exists contests_select on public.contests;
create policy contests_select on public.contests for select to authenticated
  using (public.is_admin() or (public.current_user_id() is not null and cancelled_at is null));

revoke all on function public.period_totals_by_team(date, date, boolean) from public, anon;
revoke all on function public.ikna_between(timestamptz, timestamptz) from public, anon;
grant execute on function public.period_totals_by_team(date, date, boolean) to authenticated;
grant execute on function public.ikna_between(timestamptz, timestamptz) to authenticated;
revoke execute on function public.purge_old_gsm() from public, anon, authenticated;
grant execute on function public.purge_old_gsm() to service_role;

do $$ begin
  alter publication supabase_realtime add table public.contests;
exception when duplicate_object then null;
end $$;
