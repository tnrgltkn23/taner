-- 0006 — KPI Performans sayfası: yayımlanmış KPI görünümü (salt okunur anlık görüntü)
-- Anahtarlar: bootstrap, history, shifts, version:<uuid>. Yalnızca sunucu okur (api/kpi.js).
create table if not exists public.kpi_snapshot (
  key        text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.kpi_snapshot enable row level security;
revoke all on public.kpi_snapshot from anon, authenticated;
