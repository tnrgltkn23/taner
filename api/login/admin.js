// Yönetici girişi: yalnızca şifre (kullanıcı adı sorulmaz).
// İki yönetici hesabı vardır: yönetici ve üst yönetici (is_super). Şifre hangisine
// uyuyorsa o hesapla oturum açılır. Her başarılı girişin IP'si 90 gün saklanır.
import {
  handler, HttpError, adminClient, check, clientIp, verifyPassword, tooMany, recordAttempt,
  mintSession, publicUser, audit, sleep, DUMMY_HASH,
} from '../_lib/core.js';

export default handler(['POST'], async (req, body) => {
  const password = String(body.password || '');
  if (!password || password.length > 200) throw new HttpError(400, 'Şifre gerekli');

  const ip = clientIp(req);
  const admin = adminClient();
  const [lockIp, lockAll, adminsRes] = await Promise.all([
    tooMany('admin', `ip:${ip}`, 5, 15),
    tooMany('admin', 'all', 30, 15),
    admin.from('users').select('id, username, role, active, auth_user_id, password_hash, is_super')
      // Üst yönetici önce denenir: iki hesap aynı şifreye sahip olsa bile 7899 hesabı kilitlenmez.
      .eq('role', 'admin').eq('active', true).order('is_super', { ascending: false }),
  ]);
  if (lockIp || lockAll) throw new HttpError(429, 'Çok fazla hatalı deneme. 15 dakika sonra tekrar deneyin.');
  const admins = check(adminsRes) || [];

  // Her hesabı dene (hesap sayısından bağımsız sabit süre için en az iki doğrulama)
  let user = null;
  for (const a of admins) if (!user && verifyPassword(password, a.password_hash)) user = a;
  if (admins.length < 2) verifyPassword(password, DUMMY_HASH);

  if (!user) {
    await Promise.all([recordAttempt('admin', `ip:${ip}`, false), recordAttempt('admin', 'all', false), sleep(500)]);
    throw new HttpError(401, 'Şifre hatalı');
  }

  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  const [session] = await Promise.all([
    mintSession(user),
    audit(user.id, 'admin_login', { ip }),
    admin.from('admin_logins').insert({ user_id: user.id, ip, user_agent: ua }).then(({ error }) => {
      if (error) console.error('admin_logins yazılamadı', error);
    }),
  ]);
  return { session, user: { ...publicUser(user), is_super: user.is_super } };
});
