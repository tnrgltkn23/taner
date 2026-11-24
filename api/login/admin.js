// Yönetici girişi: kullanıcı adı + şifre (bcrypt, veritabanında hash olarak saklanır).
import {
  handler, HttpError, adminClient, check, clientIp, normUsername, sleep,
  tooMany, recordAttempt, mintSession, publicProfile, audit,
} from '../_lib/core.js';

export default handler(['POST'], async (req, body) => {
  const username = normUsername(body.username);
  const password = String(body.password || '');
  if (!username || !password || password.length > 200) throw new HttpError(400, 'Kullanıcı adı ve şifre gerekli');

  const ip = clientIp(req);
  if (await tooMany('admin', `u:${username}`, 5, 15) || await tooMany('admin', `ip:${ip}`, 10, 15)) {
    throw new HttpError(429, 'Çok fazla hatalı deneme. 15 dakika sonra tekrar deneyin.');
  }

  const admin = adminClient();
  const pid = check(await admin.rpc('verify_admin_password', { p_username: username, p_password: password }));
  if (!pid) {
    await recordAttempt('admin', `u:${username}`, false);
    await recordAttempt('admin', `ip:${ip}`, false);
    await sleep(500);
    throw new HttpError(401, 'Kullanıcı adı veya şifre hatalı');
  }
  await recordAttempt('admin', `u:${username}`, true);

  const profile = check(await admin.from('profiles').select('*').eq('id', pid).single());
  const session = await mintSession(profile);
  await audit(profile.id, 'admin_login', { ip });

  // Yönetici her girişte eksik günlük kapanışları da tamamlatır
  const { data: closed } = await admin.rpc('catch_up_closes', { p_by: 'catchup' });

  return { session, profile: publicProfile(profile), closed_days: closed || 0 };
});
