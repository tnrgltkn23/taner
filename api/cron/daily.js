// Vercel Cron: her gece 2 aydan eski GSM numaralarını siler (adetler korunur).
import { handler, HttpError, adminClient, check, CRON_SECRET, safeEqual } from '../_lib/core.js';

export default handler(['GET', 'POST'], async (req) => {
  const secret = CRON_SECRET();
  if (!secret || !safeEqual(req.headers.authorization || '', `Bearer ${secret}`)) throw new HttpError(401, 'Yetkisiz');
  const purged = check(await adminClient().rpc('purge_old_gsm'));
  return { ok: true, purged_gsm: purged };
});
