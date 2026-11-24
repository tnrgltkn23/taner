// Uzman girişi, 2. adım: cihaz isteği onaylandı mı? Onaylandıysa oturum üretilir.
// İsteğin gizli anahtarı yalnızca isteği başlatan tarayıcıda bulunur.
import {
  handler, HttpError, adminClient, check, sha256, safeEqual, UUID_RE, mintSession, publicProfile,
} from '../_lib/core.js';

const PENDING_TTL_MS = 10 * 60_000;
const APPROVED_TTL_MS = 15 * 60_000;

export default handler(['POST'], async (req, body) => {
  const id = String(body.request_id || '');
  const secret = String(body.secret || '');
  if (!UUID_RE.test(id) || secret.length < 20) throw new HttpError(400, 'Geçersiz istek');

  const admin = adminClient();
  const r = check(await admin.from('device_requests').select('*').eq('id', id).maybeSingle());
  if (!r || !safeEqual(sha256(secret), r.secret_hash)) return { status: 'pending' };

  const now = Date.now();
  if (r.status === 'pending' && now - new Date(r.created_at).getTime() > PENDING_TTL_MS) {
    check(await admin.from('device_requests').update({ status: 'expired' }).eq('id', id).eq('status', 'pending'));
    return { status: 'expired' };
  }
  if (r.status !== 'approved') return { status: r.status };
  if (now - new Date(r.decided_at).getTime() > APPROVED_TTL_MS) return { status: 'expired' };

  // Onay tek kullanımlıktır (eşzamanlı iki istekten yalnızca biri kazanır)
  const consumed = check(await admin.from('device_requests')
    .update({ status: 'consumed', consumed_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'approved').select('id'));
  if (!consumed?.length) return { status: 'consumed' };

  const profile = check(await admin.from('profiles').select('*').eq('id', r.profile_id).single());
  if (!profile.active || profile.role !== 'expert') return { status: 'rejected' };

  const session = await mintSession(profile);
  return { status: 'approved', session, profile: publicProfile(profile) };
});
