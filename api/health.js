// Canlı ortam sağlık kontrolü: veritabanı bağlantısı ve kurulum durumu.
import { handler, adminClient, CRON_SECRET, PUBLISHABLE_KEY } from './_lib/core.js';

export default handler(['GET'], async () => {
  const admin = adminClient();
  const started = Date.now();
  const { count: adminCount, error } = await admin.from('profiles')
    .select('id', { count: 'exact', head: true }).eq('role', 'admin');
  const { data: reports } = await admin.from('daily_reports').select('day').order('day', { ascending: false }).limit(1);
  return {
    ok: !error,
    environment: process.env.VERCEL_ENV || 'development',
    commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
    database: error ? `hata: ${error.message}` : 'bağlı',
    schema_ready: !error && adminCount > 0,
    last_closed_day: reports?.[0]?.day || null,
    cron_secret_set: Boolean(CRON_SECRET()),
    publishable_key_set: Boolean(PUBLISHABLE_KEY()),
    latency_ms: Date.now() - started,
    server_time_istanbul: new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' }),
  };
});
