// Yönetici işlemleri. Her istek sunucuda doğrulanır (JWT -> profil -> rol = admin)
// ve yönetici işlem geçmişine (admin_audit) yazılır.
import {
  handler, HttpError, adminClient, check, requireAdmin, audit, normUsername,
  USERNAME_RE, UUID_RE,
} from './_lib/core.js';

const int = (v, name, { min = 0, max = 1_000_000 } = {}) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `Geçersiz ${name}`);
  return n;
};
const uuid = (v, name = 'kimlik') => {
  if (!UUID_RE.test(String(v || ''))) throw new HttpError(400, `Geçersiz ${name}`);
  return String(v);
};
const text = (v, name, max = 80) => {
  const s = String(v ?? '').trim();
  if (!s || s.length > max) throw new HttpError(400, `Geçersiz ${name}`);
  return s;
};
const isoDate = (v) => {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, 'Geçersiz tarih');
  return s;
};

const actions = {
  async approve_request(me, b) {
    const id = uuid(b.id);
    const rows = check(await adminClient().from('device_requests')
      .update({ status: 'approved', decided_at: new Date().toISOString(), decided_by: me.id })
      .eq('id', id).eq('status', 'pending').select('id, profile_id'));
    if (!rows.length) throw new HttpError(409, 'İstek artık beklemede değil');
    return { audit: { request_id: id, profile_id: rows[0].profile_id } };
  },

  async reject_request(me, b) {
    const id = uuid(b.id);
    const rows = check(await adminClient().from('device_requests')
      .update({ status: 'rejected', decided_at: new Date().toISOString(), decided_by: me.id })
      .eq('id', id).eq('status', 'pending').select('id, profile_id'));
    if (!rows.length) throw new HttpError(409, 'İstek artık beklemede değil');
    return { audit: { request_id: id, profile_id: rows[0].profile_id } };
  },

  async create_user(me, b) {
    const username = normUsername(b.username);
    if (!USERNAME_RE.test(username)) {
      throw new HttpError(400, 'Kullanıcı adı 2-40 karakter olmalı; harf, rakam, nokta, tire veya alt çizgi kullanın');
    }
    const display_name = text(b.display_name, 'ad soyad');
    const row = check(await adminClient().from('profiles')
      .insert({ username, display_name, role: 'expert' }).select('id, username, display_name').single());
    return { result: row, audit: row };
  },

  async update_user(me, b) {
    const id = uuid(b.id);
    const admin = adminClient();
    const target = check(await admin.from('profiles').select('id, role, active').eq('id', id).single());
    if (target.role !== 'expert') throw new HttpError(400, 'Yalnızca uzman hesapları düzenlenebilir');
    const patch = { updated_at: new Date().toISOString() };
    if (b.display_name !== undefined) patch.display_name = text(b.display_name, 'ad soyad');
    if (b.active !== undefined) patch.active = Boolean(b.active);
    check(await admin.from('profiles').update(patch).eq('id', id));
    if (patch.active === false) {
      check(await admin.rpc('revoke_auth_sessions', { p_profile: id }));
      check(await admin.from('device_requests').update({ status: 'expired' }).eq('profile_id', id).in('status', ['pending', 'approved']));
    }
    return { audit: { profile_id: id, ...patch } };
  },

  async revoke_sessions(me, b) {
    const id = uuid(b.id);
    check(await adminClient().rpc('revoke_auth_sessions', { p_profile: id }));
    return { audit: { profile_id: id } };
  },

  async upsert_item(me, b) {
    const admin = adminClient();
    const row = {
      name: text(b.name, 'kalem adı', 60),
      sort_order: int(b.sort_order ?? 0, 'sıra', { min: -1000, max: 1000 }),
      active: b.active === undefined ? true : Boolean(b.active),
    };
    let saved;
    if (b.id) {
      saved = check(await admin.from('counter_items').update(row).eq('id', int(b.id, 'kalem')).select().single());
    } else {
      saved = check(await admin.from('counter_items').insert(row).select().single());
    }
    return { result: saved, audit: saved };
  },

  async set_goal(me, b) {
    const scope = String(b.scope || '');
    const p_profile = scope === 'individual' ? uuid(b.profile_id, 'uzman') : null;
    const p_item = int(b.item_id, 'kalem', { min: 1 });
    const p_target = b.target === null || b.target === '' ? null : int(b.target, 'hedef');
    check(await adminClient().rpc('admin_set_goal', {
      p_admin: me.id, p_scope: scope, p_profile, p_item, p_target,
    }));
    return { audit: { scope, profile_id: p_profile, item_id: p_item, target: p_target } };
  },

  async undo_event(me, b) {
    const p_event = int(b.event_id, 'işlem', { min: 1, max: Number.MAX_SAFE_INTEGER });
    const p_reason = String(b.reason || '').slice(0, 200);
    check(await adminClient().rpc('admin_undo_event', { p_admin: me.id, p_event, p_reason }));
    return { audit: { event_id: p_event, reason: p_reason } };
  },

  async close_day(me, b) {
    const day = isoDate(b.day);
    const closed = check(await adminClient().rpc('close_day', { p_day: day, p_by: `admin:${me.username}` }));
    return { result: { closed }, audit: { day, closed } };
  },

  async catch_up(me) {
    const closed = check(await adminClient().rpc('catch_up_closes', { p_by: `admin:${me.username}` }));
    return { result: { closed_days: closed }, audit: { closed_days: closed } };
  },

  async change_password(me, b) {
    const admin = adminClient();
    const ok = check(await admin.rpc('verify_admin_password', { p_username: me.username, p_password: String(b.current || '') }));
    if (!ok) throw new HttpError(400, 'Mevcut şifre hatalı');
    const next = String(b.next || '');
    if (next.length < 6 || next.length > 200) throw new HttpError(400, 'Yeni şifre en az 6 karakter olmalı');
    check(await admin.rpc('admin_set_password', { p_admin: me.id, p_new: next }));
    return { audit: {} };
  },
};

export default handler(['POST'], async (req, body) => {
  const me = await requireAdmin(req);
  const action = String(body.action || '');
  const fn = Object.hasOwn(actions, action) ? actions[action] : null;
  if (!fn) throw new HttpError(400, 'Bilinmeyen işlem');
  const out = (await fn(me, body)) || {};
  await audit(me.id, action, out.audit || {});
  return { ok: true, ...(out.result !== undefined ? { result: out.result } : {}) };
});
