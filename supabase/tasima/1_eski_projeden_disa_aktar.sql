-- =====================================================================
-- TAŞIMA ADIM 1 — ESKİ (Tokyo) projede çalıştırın.
-- Sonuç tek bir hücredir: "tasima_sql". Hücrenin TAMAMINI kopyalayıp
-- YENİ (Frankfurt) projenin SQL Editor'üne yapıştırıp çalıştırın.
-- Test hesapları (test.*) taşınmaz. Bakım modu yeni projede kapalı başlar.
-- =====================================================================
select string_agg(stmt, E'\n' order by o, k) as tasima_sql
from (
  select 1 as o, coalesce(role, '') || username as k, format(
    'insert into public.users (id, username, role, password_hash, active, last_entry_at, created_at, updated_at) values (%L, %L, %L, %L, %L, %L, %L, %L);',
    id, username, role, password_hash, active, last_entry_at, created_at, updated_at) as stmt
  from public.users
  where username not like 'test.%'

  union all
  select 2, '', format(
    'update public.settings set postpre_target = %L, savedesk_target = %L, maintenance = false where id = 1;',
    postpre_target, savedesk_target)
  from public.settings

  union all
  select 3, lpad(e.id::text, 12, '0'), format(
    'insert into public.entries (id, user_id, item, gsm, delta, source, day, created_at, created_by, deleted_at, deleted_by) values (%s, %L, %L, %L, %s, %L, %L, %L, %L, %L, %L);',
    e.id, e.user_id, e.item, e.gsm, e.delta, e.source, e.day, e.created_at, e.created_by, e.deleted_at, e.deleted_by)
  from public.entries e
  join public.users u on u.id = e.user_id
  where u.username not like 'test.%'

  union all
  select 4, lpad(id::text, 12, '0'), format(
    'insert into public.admin_audit (id, admin_id, action, details, created_at) values (%s, %L, %L, %L, %L);',
    id, admin_id, action, details, created_at)
  from public.admin_audit

  union all
  select 5, '', 'select setval(''public.entries_id_seq'', greatest((select max(id) from public.entries), 1)); select setval(''public.admin_audit_id_seq'', greatest((select max(id) from public.admin_audit), 1));'

  union all
  select 6, '', format('-- Taşıma özeti: %s kullanıcı, %s kayıt',
    (select count(*) from public.users where username not like 'test.%'),
    (select count(*) from public.entries e join public.users u on u.id = e.user_id where u.username not like 'test.%'))
) s;
