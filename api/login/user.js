// Uzman girişi: kullanıcı adı + 5 haneli şifre.
import {
  handler, HttpError, adminClient, check, clientIp, normUsername, USERNAME_RE, USER_PASSWORD_RE,
  verifyPassword, DUMMY_HASH, tooMany, recordAttempt, mintSession, publicUser, getSettings, sleep,
} from '../_lib/core.js';

export default handler(['POST'], async (req, body) => {
  const username = normUsername(body.username);
  const password = String(body.password || '');
  if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Kullanıcı adı yalnızca küçük harf, rakam ve . _ - içerebilir');
  if (!USER_PASSWORD_RE.test(password)) throw new HttpError(400, 'Şifre 5 haneli rakam olmalıdır');

  const ip = clientIp(req);
  if (await tooMany('user', `u:${username}`, 5, 15) || await tooMany('user', `ip:${ip}`, 25, 15)) {
    throw new HttpError(429, 'Çok fazla hatalı deneme. 15 dakika sonra tekrar deneyin.');
  }

  const settings = await getSettings();
  if (settings.maintenance) throw new HttpError(503, 'Sistem bakımda. Lütfen daha sonra tekrar deneyin.');

  const admin = adminClient();
  const user = check(await admin.from('users')
    .select('id, username, role, active, auth_user_id, password_hash')
    .eq('username', username).eq('role', 'expert').maybeSingle());

  const ok = verifyPassword(password, user?.password_hash || DUMMY_HASH) && user?.active;
  if (!ok) {
    await recordAttempt('user', `u:${username}`, false);
    await recordAttempt('user', `ip:${ip}`, false);
    await sleep(300);
    throw new HttpError(401, 'Kullanıcı adı veya şifre hatalı');
  }
  await recordAttempt('user', `u:${username}`, true);

  const session = await mintSession(user);
  return { session, user: publicUser(user) };
});
