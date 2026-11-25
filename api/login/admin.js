// Yönetici girişi: yalnızca şifre (kullanıcı adı sorulmaz).
import {
  handler, HttpError, adminClient, check, clientIp, verifyPassword, tooMany, recordAttempt,
  mintSession, publicUser, audit, sleep,
} from '../_lib/core.js';

export default handler(['POST'], async (req, body) => {
  const password = String(body.password || '');
  if (!password || password.length > 200) throw new HttpError(400, 'Şifre gerekli');

  const ip = clientIp(req);
  if (await tooMany('admin', `ip:${ip}`, 5, 15) || await tooMany('admin', 'all', 30, 15)) {
    throw new HttpError(429, 'Çok fazla hatalı deneme. 15 dakika sonra tekrar deneyin.');
  }

  const admin = adminClient();
  const user = check(await admin.from('users')
    .select('id, username, role, active, auth_user_id, password_hash')
    .eq('role', 'admin').maybeSingle());

  if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
    await recordAttempt('admin', `ip:${ip}`, false);
    await recordAttempt('admin', 'all', false);
    await sleep(500);
    throw new HttpError(401, 'Şifre hatalı');
  }

  const session = await mintSession(user);
  await audit(user.id, 'admin_login', { ip });
  return { session, user: publicUser(user) };
});
