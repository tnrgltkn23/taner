-- 0007 — Doğum günü banner'ı: çalışan adı + doğum ayı/günü (yıl tutulmaz). Yalnızca sunucu okur.
create table if not exists public.birthdays (
  name  text primary key,
  month int not null check (month between 1 and 12),
  day   int not null check (day between 1 and 31)
);
alter table public.birthdays enable row level security;
revoke all on public.birthdays from anon, authenticated;
