// Canlı ortam sağlık kontrolü.
import { handler, adminClient, CRON_SECRET, PUBLISHABLE_KEY } from './_lib/core.js';

export default handler(['GET'], async () => {
  const admin = adminClient();
  const started = Date.now();
  const { count: users, error } = await admin.from('users')
    .select('id', { count: 'exact', head: true }).eq('role', 'expert').eq('active', true);
  const { data: s } = await admin.from('settings').select('maintenance').eq('id', 1).maybeSingle();
  return {
    ok: !error,
    environment: process.env.VERCEL_ENV || 'development',
    commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
    database: error ? `hata: ${error.message}` : 'bağlı',
    schema: error ? null : 'v2',
    active_users: error ? null : users,
    maintenance: s?.maintenance ?? null,
    cron_secret_set: Boolean(CRON_SECRET()),
    publishable_key_set: Boolean(PUBLISHABLE_KEY()),
    latency_ms: Date.now() - started,
    server_time_istanbul: new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' }),
  };
});
