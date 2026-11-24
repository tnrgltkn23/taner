// Vercel Cron: her gün 00:05 (Europe/Istanbul = 21:05 UTC) çalışır.
// Yalnızca dünü değil, eksik kalmış TÜM geçmiş günleri kapatır.
import { handler, HttpError, adminClient, check, CRON_SECRET, safeEqual } from '../_lib/core.js';

export default handler(['GET', 'POST'], async (req) => {
  const secret = CRON_SECRET();
  const auth = req.headers.authorization || '';
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) throw new HttpError(401, 'Yetkisiz');
  const closed = check(await adminClient().rpc('catch_up_closes', { p_by: 'cron' }));
  return { ok: true, closed_days: closed };
});
