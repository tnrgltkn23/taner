// Yönetici girişi: yalnızca şifre (kullanıcı adı sorulmaz).
import {
  handler, HttpError, adminClient, check, clientIp, verifyPassword, tooMany, recordAttempt,
  mintSession, publicUser, audit, sleep,
} from '../_lib/core.js';

export default handler(['POST'], async (req, body) => {
  const password = String(body.password || '');
  if (!password || password.length > 200) throw new HttpError(400, 'Şifre gerekli');

  const ip = clientIp(req);
  const admin = adminClient();
  const [lockIp, lockAll, userRes] = await Promise.all([
    tooMany('admin', `ip:${ip}`, 5, 15),
    tooMany('admin', 'all', 30, 15),
    admin.from('users').select('id, username, role, active, auth_user_id, password_hash').eq('role', 'admin').maybeSingle(),
  ]);
  if (lockIp || lockAll) throw new HttpError(429, 'Çok fazla hatalı deneme. 15 dakika sonra tekrar deneyin.');
  const user = check(userRes);

  if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
    await Promise.all([recordAttempt('admin', `ip:${ip}`, false), recordAttempt('admin', 'all', false), sleep(500)]);
    throw new HttpError(401, 'Şifre hatalı');
  }

  const [session] = await Promise.all([mintSession(user), audit(user.id, 'admin_login', { ip })]);
  return { session, user: publicUser(user) };
});
