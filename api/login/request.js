// Uzman girişi, 1. adım: kullanıcı adı + bu cihaz için onay isteği.
// Kullanıcı adı tek başına yetki vermez: yönetici onaylayana kadar oturum açılmaz.
import crypto from 'node:crypto';
import {
  handler, HttpError, adminClient, check, clientIp, normUsername, USERNAME_RE,
  randomToken, sha256, tooMany, recordAttempt,
} from '../_lib/core.js';

export default handler(['POST'], async (req, body) => {
  const username = normUsername(body.username);
  if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Geçerli bir kullanıcı adı girin');

  const ip = clientIp(req);
  if (await tooMany('device', `ip:${ip}`, 30, 15, false)) {
    throw new HttpError(429, 'Çok fazla deneme. Lütfen birkaç dakika sonra tekrar deneyin.');
  }
  await recordAttempt('device', `ip:${ip}`, true);

  const admin = adminClient();
  const secret = randomToken(32);
  const profile = check(await admin.from('profiles').select('id, role, active').eq('username', username).maybeSingle());

  // Kullanıcı adının var olup olmadığı dışarıya sızdırılmaz: aynı yanıt döner.
  if (!profile || profile.role !== 'expert' || !profile.active) {
    return { request_id: crypto.randomUUID(), secret };
  }

  // Aynı kullanıcının eski bekleyen istekleri geçersiz olur
  check(await admin.from('device_requests').update({ status: 'expired' })
    .eq('profile_id', profile.id).eq('status', 'pending'));

  const row = check(await admin.from('device_requests').insert({
    profile_id: profile.id,
    secret_hash: sha256(secret),
    device_label: String(body.device_label || '').slice(0, 60) || null,
    user_agent: String(req.headers['user-agent'] || '').slice(0, 200),
    ip,
  }).select('id').single());

  return { request_id: row.id, secret };
});
