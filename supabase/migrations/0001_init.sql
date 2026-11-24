-- =====================================================================
-- Uzman Hedef Takip — 0001: şema, fonksiyonlar, RLS, realtime
-- Supabase SQL Editor'de tek seferde çalıştırılır. Tekrar çalıştırmaya
-- uygun değildir (ilk kurulum içindir).
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Tablolar
-- ---------------------------------------------------------------------

-- Kullanıcı hesapları ve rolleri
create table public.profiles (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid unique,                       -- auth.users.id (ilk girişte bağlanır)
  username      text not null unique
                check (username ~ '^[a-z0-9çğıöşü._-]{2,40}$'),
  display_name  text not null check (char_length(display_name) between 1 and 80),
  role          text not null default 'expert' check (role in ('admin', 'expert')),
  active        boolean not null default true,
  password_hash text,                              -- yalnızca yönetici (bcrypt)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Sayaç kalemleri (Satış, Savedesk vb.)
create table public.counter_items (
  id          serial primary key,
  name        text not null unique check (char_length(name) between 1 and 60),
  sort_order  int not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Sayaç işlemleri + geri alınan işlemler (undone_* alanları)
create table public.counter_events (
  id          bigserial primary key,
  profile_id  uuid not null references public.profiles(id),
  item_id     int  not null references public.counter_items(id),
  delta       int  not null default 1 check (delta <> 0),
  day         date not null,                       -- Europe/Istanbul günü
  created_at  timestamptz not null default now(),
  undone_at   timestamptz,
  undone_by   uuid references public.profiles(id),
  undo_reason text
);
create index counter_events_day_profile_idx on public.counter_events (day, profile_id);
create index counter_events_profile_created_idx on public.counter_events (profile_id, created_at desc);

-- Günlük bireysel toplamlar (atomik sayaç)
create table public.daily_user_totals (
  day         date not null,
  profile_id  uuid not null references public.profiles(id),
  item_id     int  not null references public.counter_items(id),
  total       int  not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (day, profile_id, item_id)
);

-- Günlük ekip toplamları (yalnızca toplam, kişi bilgisi yok)
create table public.daily_team_totals (
  day         date not null,
  item_id     int  not null references public.counter_items(id),
  total       int  not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (day, item_id)
);

-- Hedefler
--   individual_default : her uzman için varsayılan günlük hedef
--   individual         : belirli bir uzmana özel günlük hedef
--   team               : ekip günlük hedefi
create table public.goals (
  id           bigserial primary key,
  scope        text not null check (scope in ('individual_default', 'individual', 'team')),
  profile_id   uuid references public.profiles(id) on delete cascade,
  item_id      int  not null references public.counter_items(id) on delete cascade,
  daily_target int  not null check (daily_target >= 0),
  updated_by   uuid references public.profiles(id),
  updated_at   timestamptz not null default now(),
  constraint goals_scope_profile check ((scope = 'individual') = (profile_id is not null))
);
create unique index goals_unique on public.goals
  (scope, item_id, coalesce(profile_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Hedef değişiklik geçmişi (kapanışlarda o günün hedefi buradan bulunur)
create table public.goal_history (
  id          bigserial primary key,
  scope       text not null,
  profile_id  uuid references public.profiles(id) on delete set null,
  item_id     int  not null,
  old_target  int,
  new_target  int,                                 -- null = özel hedef kaldırıldı
  changed_by  uuid references public.profiles(id),
  changed_at  timestamptz not null default now()
);
create index goal_history_lookup_idx on public.goal_history (scope, item_id, profile_id, changed_at desc);

-- Günlük kapanış raporları
create table public.daily_reports (
  day        date primary key,
  closed_at  timestamptz not null default now(),
  closed_by  text not null,                        -- cron / pg_cron / catchup / admin:<kullanıcı>
  summary    jsonb not null
);

-- Yönetici işlem geçmişi
create table public.admin_audit (
  id         bigserial primary key,
  admin_id   uuid references public.profiles(id),
  action     text not null,
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index admin_audit_created_idx on public.admin_audit (created_at desc);

-- Uzman cihaz giriş onay istekleri
create table public.device_requests (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  secret_hash  text not null,
  device_label text,
  user_agent   text,
  ip           text,
  status       text not null default 'pending'
               check (status in ('pending', 'approved', 'rejected', 'consumed', 'expired')),
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   uuid references public.profiles(id),
  consumed_at  timestamptz
);
create index device_requests_status_idx on public.device_requests (status, created_at desc);

-- Giriş denemeleri (hız sınırlama; yalnızca sunucu erişir)
create table public.auth_attempts (
  id         bigserial primary key,
  kind       text not null,
  key        text not null,
  success    boolean not null,
  created_at timestamptz not null default now()
);
create index auth_attempts_idx on public.auth_attempts (kind, key, created_at desc);

-- ---------------------------------------------------------------------
-- Yardımcı fonksiyonlar
-- ---------------------------------------------------------------------

create or replace function public.istanbul_today()
returns date language sql stable
as $$ select (now() at time zone 'Europe/Istanbul')::date $$;

create or replace function public.current_profile_id()
returns uuid language sql stable security definer set search_path = public
as $$ select id from public.profiles where auth_user_id = auth.uid() and active $$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.profiles
                     where auth_user_id = auth.uid() and active and role = 'admin') $$;

-- Belirli bir andaki hedef (goal_history üzerinden)
create or replace function public.goal_target_at(p_scope text, p_profile uuid, p_item int, p_at timestamptz)
returns int language sql stable security definer set search_path = public
as $$
  select new_target from public.goal_history
  where scope = p_scope and profile_id is not distinct from p_profile
    and item_id = p_item and changed_at < p_at
  order by changed_at desc, id desc
  limit 1
$$;

-- Hedef değişikliklerini geçmişe yaz
create or replace function public.trg_goal_history()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into goal_history (scope, profile_id, item_id, old_target, new_target, changed_by)
    values (new.scope, new.profile_id, new.item_id, null, new.daily_target, new.updated_by);
    return new;
  elsif tg_op = 'UPDATE' then
    if new.daily_target is distinct from old.daily_target then
      insert into goal_history (scope, profile_id, item_id, old_target, new_target, changed_by)
      values (new.scope, new.profile_id, new.item_id, old.daily_target, new.daily_target, new.updated_by);
    end if;
    return new;
  else
    insert into goal_history (scope, profile_id, item_id, old_target, new_target, changed_by)
    values (old.scope, old.profile_id, old.item_id, old.daily_target, null,
            nullif(current_setting('app.actor', true), '')::uuid);
    return old;
  end if;
end $$;

create trigger goals_history
after insert or update or delete on public.goals
for each row execute function public.trg_goal_history();

-- ---------------------------------------------------------------------
-- Uzmanın çağırdığı fonksiyonlar (authenticated)
-- ---------------------------------------------------------------------

-- Sayaç +1 (atomik; eşzamanlı işlemlerde veri kaybı olmaz)
create or replace function public.record_event(p_item int)
returns bigint language plpgsql security definer set search_path = public
as $$
declare
  v_pid uuid;
  v_day date := istanbul_today();
  v_id  bigint;
begin
  select id into v_pid from profiles
  where auth_user_id = auth.uid() and active and role = 'expert';
  if v_pid is null then
    raise exception 'Yetkisiz işlem' using errcode = '42501';
  end if;
  if not exists (select 1 from counter_items where id = p_item and active) then
    raise exception 'Sayaç kalemi bulunamadı' using errcode = 'P0002';
  end if;

  insert into counter_events (profile_id, item_id, delta, day)
  values (v_pid, p_item, 1, v_day) returning id into v_id;

  insert into daily_user_totals (day, profile_id, item_id, total)
  values (v_day, v_pid, p_item, 1)
  on conflict (day, profile_id, item_id)
  do update set total = daily_user_totals.total + 1, updated_at = now();

  insert into daily_team_totals (day, item_id, total)
  values (v_day, p_item, 1)
  on conflict (day, item_id)
  do update set total = daily_team_totals.total + 1, updated_at = now();

  return v_id;
end $$;

-- Ortak geri alma mantığı
create or replace function public.undo_event_internal(p_event bigint, p_actor uuid, p_reason text, p_owner_only boolean)
returns void language plpgsql security definer set search_path = public
as $$
declare e counter_events%rowtype;
begin
  select * into e from counter_events where id = p_event for update;
  if not found then raise exception 'İşlem bulunamadı' using errcode = 'P0002'; end if;
  if e.undone_at is not null then raise exception 'İşlem zaten geri alınmış'; end if;
  if p_owner_only and e.profile_id <> p_actor then
    raise exception 'Yetkisiz işlem' using errcode = '42501';
  end if;
  if p_owner_only and e.day <> istanbul_today() then
    raise exception 'Yalnızca bugünkü işlemler geri alınabilir';
  end if;
  if exists (select 1 from daily_reports where day = e.day) then
    raise exception 'Bu günün kapanışı yapılmış; işlem geri alınamaz';
  end if;

  update counter_events
     set undone_at = now(), undone_by = p_actor, undo_reason = left(p_reason, 200)
   where id = p_event;

  update daily_user_totals set total = total - e.delta, updated_at = now()
   where day = e.day and profile_id = e.profile_id and item_id = e.item_id;

  update daily_team_totals set total = total - e.delta, updated_at = now()
   where day = e.day and item_id = e.item_id;
end $$;

create or replace function public.undo_my_event(p_event bigint)
returns void language plpgsql security definer set search_path = public
as $$
declare v_pid uuid;
begin
  select id into v_pid from profiles
  where auth_user_id = auth.uid() and active and role = 'expert';
  if v_pid is null then raise exception 'Yetkisiz işlem' using errcode = '42501'; end if;
  perform undo_event_internal(p_event, v_pid, 'Uzman geri aldı', true);
end $$;

-- ---------------------------------------------------------------------
-- Yalnızca sunucunun (service role) çağırdığı fonksiyonlar
-- ---------------------------------------------------------------------

create or replace function public.verify_admin_password(p_username text, p_password text)
returns uuid language sql stable security definer set search_path = public, extensions
as $$
  select id from public.profiles
  where username = p_username and role = 'admin' and active
    and password_hash is not null
    and password_hash = extensions.crypt(p_password, password_hash)
$$;

create or replace function public.admin_set_password(p_admin uuid, p_new text)
returns void language plpgsql security definer set search_path = public, extensions
as $$
begin
  if char_length(p_new) < 6 then raise exception 'Şifre en az 6 karakter olmalı'; end if;
  update public.profiles
     set password_hash = extensions.crypt(p_new, extensions.gen_salt('bf', 10)), updated_at = now()
   where id = p_admin and role = 'admin';
end $$;

create or replace function public.admin_set_goal(p_admin uuid, p_scope text, p_profile uuid, p_item int, p_target int)
returns void language plpgsql security definer set search_path = public
as $$
begin
  perform set_config('app.actor', p_admin::text, true);
  if p_scope not in ('individual_default', 'individual', 'team') then
    raise exception 'Geçersiz hedef türü';
  end if;
  if (p_scope = 'individual') <> (p_profile is not null) then
    raise exception 'Bireysel hedef için uzman seçilmeli';
  end if;
  if p_target is null then
    delete from goals where scope = p_scope and profile_id is not distinct from p_profile and item_id = p_item;
  elsif p_target < 0 then
    raise exception 'Hedef negatif olamaz';
  else
    update goals set daily_target = p_target, updated_by = p_admin, updated_at = now()
     where scope = p_scope and profile_id is not distinct from p_profile and item_id = p_item;
    if not found then
      insert into goals (scope, profile_id, item_id, daily_target, updated_by)
      values (p_scope, p_profile, p_item, p_target, p_admin);
    end if;
  end if;
end $$;

create or replace function public.admin_undo_event(p_admin uuid, p_event bigint, p_reason text)
returns void language plpgsql security definer set search_path = public
as $$
begin
  perform undo_event_internal(p_event, p_admin, coalesce(nullif(p_reason, ''), 'Yönetici geri aldı'), false);
end $$;

-- Uzmanın tüm oturumlarını sonlandır (refresh token'lar silinir)
create or replace function public.revoke_auth_sessions(p_profile uuid)
returns void language plpgsql security definer set search_path = public, auth
as $$
declare v_auth uuid;
begin
  select auth_user_id into v_auth from public.profiles where id = p_profile;
  if v_auth is null then return; end if;
  delete from auth.sessions where user_id = v_auth;
end $$;

-- Günlük kapanış: raporu oluşturur, tekrar çağrılırsa hiçbir şey yapmaz
create or replace function public.close_day(p_day date, p_by text)
returns boolean language plpgsql security definer set search_path = public
as $$
declare
  v_end     timestamptz := ((p_day + 1)::timestamp at time zone 'Europe/Istanbul');
  v_summary jsonb;
begin
  if p_day >= istanbul_today() then
    raise exception 'Bugün veya ileri tarihli gün kapatılamaz';
  end if;
  perform pg_advisory_xact_lock(hashtext('close_day:' || p_day::text));
  if exists (select 1 from daily_reports where day = p_day) then
    return false;
  end if;

  with items as (
    select ci.id, ci.name, ci.sort_order from counter_items ci
    where ci.created_at < v_end
      and (ci.active or exists (select 1 from daily_team_totals t
                                where t.day = p_day and t.item_id = ci.id and t.total <> 0))
  ),
  experts as (
    select p.id, p.username, p.display_name from profiles p
    where p.role = 'expert' and p.created_at < v_end
      and (p.active or exists (select 1 from daily_user_totals u
                               where u.day = p_day and u.profile_id = p.id and u.total <> 0))
  ),
  per as (
    select e.id as profile_id, i.id as item_id,
      coalesce((select u.total from daily_user_totals u
                where u.day = p_day and u.profile_id = e.id and u.item_id = i.id), 0) as total,
      coalesce(goal_target_at('individual', e.id, i.id, v_end),
               goal_target_at('individual_default', null, i.id, v_end), 0) as target
    from experts e cross join items i
  ),
  team as (
    select i.id as item_id,
      coalesce((select t.total from daily_team_totals t where t.day = p_day and t.item_id = i.id), 0) as total,
      coalesce(goal_target_at('team', null, i.id, v_end), 0) as target
    from items i
  )
  select jsonb_build_object(
    'day', p_day,
    'items', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by sort_order, id), '[]'::jsonb) from items),
    'team', (select coalesce(jsonb_agg(jsonb_build_object(
                'item_id', item_id, 'total', total, 'target', target,
                'rate', case when target > 0 then round(total * 100.0 / target, 1) end)), '[]'::jsonb) from team),
    'experts', (select coalesce(jsonb_agg(x order by x->>'display_name'), '[]'::jsonb) from (
                 select jsonb_build_object(
                   'profile_id', e.id, 'username', e.username, 'display_name', e.display_name,
                   'total',  (select coalesce(sum(total), 0)  from per where per.profile_id = e.id),
                   'target', (select coalesce(sum(target), 0) from per where per.profile_id = e.id),
                   'items',  (select coalesce(jsonb_agg(jsonb_build_object(
                                'item_id', item_id, 'total', total, 'target', target,
                                'rate', case when target > 0 then round(total * 100.0 / target, 1) end)), '[]'::jsonb)
                              from per where per.profile_id = e.id)) as x
                 from experts e) s),
    'event_count',  (select count(*) from counter_events where day = p_day and undone_at is null),
    'undone_count', (select count(*) from counter_events where day = p_day and undone_at is not null)
  ) into v_summary;

  insert into daily_reports (day, closed_by, summary) values (p_day, p_by, v_summary);
  return true;
end $$;

-- Eksik kapanışları telafi et (cron çalışmasa bile geçmiş günler kapanır)
create or replace function public.catch_up_closes(p_by text default 'catchup')
returns int language plpgsql security definer set search_path = public
as $$
declare
  v_today date := istanbul_today();
  v_start date;
  d date;
  n int := 0;
begin
  select least((select min(day) from counter_events), (select min(day) from daily_reports)) into v_start;
  if v_start is null then return 0; end if;
  v_start := greatest(v_start, v_today - 400);
  for d in select g::date from generate_series(v_start, v_today - 1, interval '1 day') g loop
    if not exists (select 1 from daily_reports where day = d) then
      if close_day(d, p_by) then n := n + 1; end if;
    end if;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Fonksiyon yetkileri
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon;

revoke execute on function
  public.verify_admin_password(text, text),
  public.admin_set_password(uuid, text),
  public.admin_set_goal(uuid, text, uuid, int, int),
  public.admin_undo_event(uuid, bigint, text),
  public.undo_event_internal(bigint, uuid, text, boolean),
  public.revoke_auth_sessions(uuid),
  public.close_day(date, text),
  public.catch_up_closes(text),
  public.goal_target_at(text, uuid, int, timestamptz),
  public.trg_goal_history()
from authenticated;

grant execute on function
  public.verify_admin_password(text, text),
  public.admin_set_password(uuid, text),
  public.admin_set_goal(uuid, text, uuid, int, int),
  public.admin_undo_event(uuid, bigint, text),
  public.undo_event_internal(bigint, uuid, text, boolean),
  public.revoke_auth_sessions(uuid),
  public.close_day(date, text),
  public.catch_up_closes(text),
  public.goal_target_at(text, uuid, int, timestamptz)
to service_role;

grant execute on function
  public.istanbul_today(), public.current_profile_id(), public.is_admin(),
  public.record_event(int), public.undo_my_event(bigint)
to authenticated;

-- ---------------------------------------------------------------------
-- Tablo yetkileri + RLS
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate on all tables in schema public from authenticated;
revoke all on public.auth_attempts from authenticated;
grant select on
  public.profiles, public.counter_items, public.counter_events, public.daily_user_totals,
  public.daily_team_totals, public.goals, public.goal_history, public.daily_reports,
  public.admin_audit, public.device_requests
to authenticated;

alter table public.profiles          enable row level security;
alter table public.counter_items     enable row level security;
alter table public.counter_events    enable row level security;
alter table public.daily_user_totals enable row level security;
alter table public.daily_team_totals enable row level security;
alter table public.goals             enable row level security;
alter table public.goal_history      enable row level security;
alter table public.daily_reports     enable row level security;
alter table public.admin_audit       enable row level security;
alter table public.device_requests   enable row level security;
alter table public.auth_attempts     enable row level security;

-- Uzman yalnızca kendi profilini; yönetici herkesi görür
create policy profiles_select on public.profiles for select to authenticated
  using (id = public.current_profile_id() or public.is_admin());

create policy counter_items_select on public.counter_items for select to authenticated
  using (public.current_profile_id() is not null);

create policy counter_events_select on public.counter_events for select to authenticated
  using (profile_id = public.current_profile_id() or public.is_admin());

create policy daily_user_totals_select on public.daily_user_totals for select to authenticated
  using (profile_id = public.current_profile_id() or public.is_admin());

-- Ekip toplamı: kişi bilgisi içermez, tüm aktif kullanıcılar görür
create policy daily_team_totals_select on public.daily_team_totals for select to authenticated
  using (public.current_profile_id() is not null);

create policy goals_select on public.goals for select to authenticated
  using (public.is_admin()
         or (public.current_profile_id() is not null
             and (scope in ('individual_default', 'team') or profile_id = public.current_profile_id())));

create policy goal_history_select    on public.goal_history    for select to authenticated using (public.is_admin());
create policy daily_reports_select   on public.daily_reports   for select to authenticated using (public.is_admin());
create policy admin_audit_select     on public.admin_audit     for select to authenticated using (public.is_admin());
create policy device_requests_select on public.device_requests for select to authenticated using (public.is_admin());
-- auth_attempts: politika yok -> yalnızca service role

-- ---------------------------------------------------------------------
-- Realtime (RLS her abone için ayrıca uygulanır)
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table
  public.counter_events, public.daily_user_totals, public.daily_team_totals,
  public.goals, public.counter_items, public.device_requests,
  public.daily_reports, public.profiles;

-- ---------------------------------------------------------------------
-- Başlangıç yöneticisi (şifre bcrypt ile hash'lenir; düz metin saklanmaz)
-- Kullanıcı adı: admin  /  Başlangıç şifresi: 2637  -> ilk girişten sonra değiştirin
-- ---------------------------------------------------------------------
insert into public.profiles (username, display_name, role, password_hash)
values ('admin', 'Yönetici', 'admin', extensions.crypt('2637', extensions.gen_salt('bf', 10)))
on conflict (username) do nothing;
