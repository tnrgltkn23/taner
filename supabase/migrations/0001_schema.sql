-- =====================================================================
-- Uzman Hedef Takip — v2 şema (çalışma.xlsx tasarımı)
-- Supabase SQL Editor'de bir kez çalıştırılır.
-- İlk sürümün (v1) tablolarını ve fonksiyonlarını kaldırır, v2'yi kurar.
-- =====================================================================

-- ---------------------------------------------------------------------
-- v1 temizliği (yalnızca test verisi içeriyordu)
-- ---------------------------------------------------------------------
do $$ begin perform cron.unschedule('uzman-hedef-gunluk-kapanis'); exception when others then null; end $$;

drop table if exists
  public.device_requests, public.auth_attempts, public.goal_history, public.goals,
  public.daily_reports, public.daily_team_totals, public.daily_user_totals,
  public.counter_events, public.counter_items, public.admin_audit, public.profiles
cascade;

drop function if exists
  public.current_profile_id(), public.is_admin(),
  public.goal_target_at(text, uuid, int, timestamptz), public.trg_goal_history(),
  public.record_event(int), public.undo_event_internal(bigint, uuid, text, boolean),
  public.undo_my_event(bigint), public.verify_admin_password(text, text),
  public.admin_set_password(uuid, text), public.admin_set_goal(uuid, text, uuid, int, int),
  public.admin_undo_event(uuid, bigint, text), public.revoke_auth_sessions(uuid),
  public.close_day(date, text), public.catch_up_closes(text)
cascade;

-- v1'in oturum kimlikleri
do $$ begin
  delete from auth.users where email like '%@uzman-hedef.example.com';
exception when others then raise notice 'auth temizliği atlandı: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------
-- Tablolar
-- ---------------------------------------------------------------------

-- Kullanıcılar (uzmanlar + tek yönetici). Şifreler PBKDF2-SHA256 hash'i olarak saklanır.
create table public.users (
  id             uuid primary key default gen_random_uuid(),
  auth_user_id   uuid unique,
  username       text not null unique check (username ~ '^[a-z0-9._-]{2,40}$'),
  role           text not null default 'expert' check (role in ('admin', 'expert')),
  password_hash  text not null,
  active         boolean not null default true,
  last_entry_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index users_single_admin on public.users (role) where role = 'admin';

-- Hedef kartı ve bakım modu (tek satır)
create table public.settings (
  id               int primary key default 1 check (id = 1),
  postpre_target   numeric(5,4) not null default 0.65 check (postpre_target between 0 and 1),
  savedesk_target  numeric(5,4) not null default 0.75 check (savedesk_target between 0 and 1),
  maintenance      boolean not null default false,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references public.users(id)
);
insert into public.settings default values;

-- Sayaç kayıtları. Uzman kaydı: delta = 1 + GSM. Yönetici düzeltmesi: delta = ±n, GSM yok.
create table public.entries (
  id          bigserial primary key,
  user_id     uuid not null references public.users(id),
  item        text not null check (item in ('pp_ikna', 'pp_gecis', 'pp_14271', 'sd_ikna', 'sd_iptal', 'sd_17891')),
  gsm         text check (gsm ~ '^[0-9]{10}$'),
  delta       int  not null default 1 check (delta <> 0),
  source      text not null default 'user' check (source in ('user', 'admin')),
  day         date not null,                       -- Europe/Istanbul günü
  created_at  timestamptz not null default now(),
  created_by  uuid references public.users(id),
  deleted_at  timestamptz,
  deleted_by  uuid references public.users(id)
);
create index entries_day_user_idx  on public.entries (day, user_id);
create index entries_user_time_idx on public.entries (user_id, created_at desc);
create index entries_dup_idx       on public.entries (user_id, day, gsm) where deleted_at is null;

-- Yönetici işlem geçmişi
create table public.admin_audit (
  id         bigserial primary key,
  admin_id   uuid references public.users(id),
  action     text not null,
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index admin_audit_created_idx on public.admin_audit (created_at desc);

-- Giriş denemeleri (kaba kuvvet koruması; yalnızca sunucu erişir)
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

create or replace function public.current_user_id()
returns uuid language sql stable security definer set search_path = public
as $$ select id from public.users where auth_user_id = auth.uid() and active $$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.users where auth_user_id = auth.uid() and active and role = 'admin') $$;

-- ---------------------------------------------------------------------
-- Uzman fonksiyonları
-- ---------------------------------------------------------------------

-- Ekle: GSM zorunlu (10 hane). Aynı gün aynı GSM varsa p_force olmadan 'duplicate' döner.
create or replace function public.add_entry(p_item text, p_gsm text, p_force boolean default false)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid;
  v_day date := istanbul_today();
  v_dup int;
  v_id  bigint;
  v_at  timestamptz;
begin
  select id into v_uid from users where auth_user_id = auth.uid() and active and role = 'expert';
  if v_uid is null then raise exception 'Yetkisiz işlem' using errcode = '42501'; end if;
  if (select maintenance from settings where id = 1) then
    raise exception 'Sistem bakımda, lütfen daha sonra tekrar deneyin';
  end if;
  if p_item is null or p_item not in ('pp_ikna', 'pp_gecis', 'pp_14271', 'sd_ikna', 'sd_iptal', 'sd_17891') then
    raise exception 'Geçersiz kalem';
  end if;
  if p_gsm is null or p_gsm !~ '^[0-9]{10}$' then
    raise exception 'GSM numarası 10 haneli olmalıdır';
  end if;

  if not coalesce(p_force, false) then
    select count(*) into v_dup from entries
     where user_id = v_uid and day = v_day and gsm = p_gsm and deleted_at is null;
    if v_dup > 0 then
      return jsonb_build_object('status', 'duplicate', 'count', v_dup);
    end if;
  end if;

  insert into entries (user_id, item, gsm, delta, source, day, created_by)
  values (v_uid, p_item, p_gsm, 1, 'user', v_day, v_uid)
  returning id, created_at into v_id, v_at;

  update users set last_entry_at = v_at where id = v_uid;
  return jsonb_build_object('status', 'ok', 'id', v_id, 'created_at', v_at);
end $$;

-- Geri al: yalnızca kendi kaydı ve eklendikten sonraki 10 saniye içinde (1 sn ağ payı)
create or replace function public.undo_entry(p_id bigint)
returns void language plpgsql security definer set search_path = public
as $$
declare v_uid uuid; e entries%rowtype;
begin
  select id into v_uid from users where auth_user_id = auth.uid() and active and role = 'expert';
  if v_uid is null then raise exception 'Yetkisiz işlem' using errcode = '42501'; end if;
  select * into e from entries where id = p_id for update;
  if not found or e.user_id <> v_uid or e.source <> 'user' then
    raise exception 'Kayıt bulunamadı';
  end if;
  if e.deleted_at is not null then raise exception 'Kayıt zaten geri alınmış'; end if;
  if clock_timestamp() - e.created_at > interval '11 seconds' then
    raise exception 'Geri alma süresi (10 saniye) doldu';
  end if;
  update entries set deleted_at = now(), deleted_by = v_uid where id = p_id;
end $$;

-- Günlük toplamlar (RLS geçerli: uzman yalnızca kendini, yönetici herkesi görür)
create or replace function public.day_totals(p_from date, p_to date, p_user uuid default null)
returns table (day date, user_id uuid, item text, total bigint)
language sql stable set search_path = public
as $$
  select e.day, e.user_id, e.item, sum(e.delta)::bigint
  from entries e
  where e.deleted_at is null and e.day between p_from and p_to
    and (p_user is null or e.user_id = p_user)
  group by e.day, e.user_id, e.item
$$;

-- ---------------------------------------------------------------------
-- Yalnızca sunucunun (service role) çağırdığı fonksiyonlar
-- ---------------------------------------------------------------------

-- Yönetici bir günün kalem adedini doğrudan belirler (fark kadar düzeltme kaydı eklenir)
create or replace function public.admin_set_count(p_admin uuid, p_user uuid, p_day date, p_item text, p_value int)
returns int language plpgsql security definer set search_path = public
as $$
declare v_cur int;
begin
  if p_value is null or p_value < 0 then raise exception 'Adet negatif olamaz'; end if;
  if p_item not in ('pp_ikna', 'pp_gecis', 'pp_14271', 'sd_ikna', 'sd_iptal', 'sd_17891') then
    raise exception 'Geçersiz kalem';
  end if;
  if not exists (select 1 from users where id = p_user and role = 'expert') then
    raise exception 'Kullanıcı bulunamadı';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_user::text || p_day::text || p_item));
  select coalesce(sum(delta), 0) into v_cur from entries
   where user_id = p_user and day = p_day and item = p_item and deleted_at is null;
  if p_value <> v_cur then
    insert into entries (user_id, item, gsm, delta, source, day, created_by)
    values (p_user, p_item, null, p_value - v_cur, 'admin', p_day, p_admin);
  end if;
  return p_value - v_cur;
end $$;

-- 2 aydan eski GSM numaralarını siler (adetler korunur)
create or replace function public.purge_old_gsm()
returns int language plpgsql security definer set search_path = public
as $$
declare n int;
begin
  update entries set gsm = null where gsm is not null and created_at < now() - interval '2 months';
  get diagnostics n = row_count;
  return n;
end $$;

-- Kullanıcının tüm oturumlarını kapatır (şifre değişince / silinince)
create or replace function public.revoke_auth_sessions(p_user uuid)
returns void language plpgsql security definer set search_path = public, auth
as $$
declare v_auth uuid;
begin
  select auth_user_id into v_auth from public.users where id = p_user;
  if v_auth is not null then delete from auth.sessions where user_id = v_auth; end if;
end $$;

-- ---------------------------------------------------------------------
-- Yetkiler
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon;
revoke execute on function
  public.admin_set_count(uuid, uuid, date, text, int),
  public.purge_old_gsm(),
  public.revoke_auth_sessions(uuid)
from authenticated;
grant execute on function
  public.admin_set_count(uuid, uuid, date, text, int),
  public.purge_old_gsm(),
  public.revoke_auth_sessions(uuid)
to service_role;
grant execute on function
  public.istanbul_today(), public.current_user_id(), public.is_admin(),
  public.add_entry(text, text, boolean), public.undo_entry(bigint),
  public.day_totals(date, date, uuid)
to authenticated;

revoke all on all tables in schema public from anon;
revoke all on public.users, public.settings, public.entries, public.admin_audit, public.auth_attempts from authenticated;
-- password_hash sütunu tarayıcıya hiçbir zaman açılmaz
grant select (id, username, role, active, last_entry_at, created_at) on public.users to authenticated;
grant select on public.settings, public.entries, public.admin_audit to authenticated;

alter table public.users         enable row level security;
alter table public.settings      enable row level security;
alter table public.entries       enable row level security;
alter table public.admin_audit   enable row level security;
alter table public.auth_attempts enable row level security;

create policy users_select on public.users for select to authenticated
  using (id = public.current_user_id() or public.is_admin());
create policy settings_select on public.settings for select to authenticated
  using (public.current_user_id() is not null);
create policy entries_select on public.entries for select to authenticated
  using (user_id = public.current_user_id() or public.is_admin());
create policy admin_audit_select on public.admin_audit for select to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table public.entries, public.settings;

-- ---------------------------------------------------------------------
-- Zamanlanmış görev: her gece 03:00 (TR) 2 aydan eski GSM'leri sil
-- ---------------------------------------------------------------------
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('uzman-hedef-gsm-temizlik', '0 0 * * *', $job$select public.purge_old_gsm()$job$);
exception when others then
  raise notice 'pg_cron kurulamadı (Vercel Cron yine çalışır): %', sqlerrm;
end $$;
