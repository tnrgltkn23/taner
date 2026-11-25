// Yönetici işlemleri. Her istek sunucuda doğrulanır (JWT -> kullanıcı -> rol = admin)
// ve yönetici işlem geçmişine (admin_audit) yazılır.
import {
  handler, HttpError, adminClient, check, requireAdmin, audit, normUsername, hashPassword, verifyPassword,
  USERNAME_RE, USER_PASSWORD_RE, UUID_RE, ITEMS,
} from './_lib/core.js';

const uuid = (v, name = 'kullanıcı') => {
  if (!UUID_RE.test(String(v || ''))) throw new HttpError(400, `Geçersiz ${name}`);
  return String(v);
};
const isoDate = (v) => {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, 'Geçersiz tarih');
  return s;
};
const percent = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new HttpError(400, `${name} 0-100 arasında olmalı`);
  return Math.round(n * 100) / 10000; // %65 -> 0.65
};

async function expertById(id) {
  const u = check(await adminClient().from('users').select('id, username, role, active').eq('id', id).maybeSingle());
  if (!u || u.role !== 'expert') throw new HttpError(404, 'Kullanıcı bulunamadı');
  return u;
}

const actions = {
  async create_user(me, b) {
    const username = normUsername(b.username);
    const password = String(b.password || '');
    if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Kullanıcı adı yalnızca küçük harf, rakam ve . _ - içerebilir (Türkçe karakter yok)');
    if (!USER_PASSWORD_RE.test(password)) throw new HttpError(400, 'Şifre 5 haneli rakam olmalıdır');
    const admin = adminClient();
    const existing = check(await admin.from('users').select('id, role, active').eq('username', username).maybeSingle());
    if (existing && (existing.active || existing.role !== 'expert')) throw new HttpError(409, 'Bu kullanıcı adı zaten kullanılıyor');
    let row;
    if (existing) {
      // Daha önce silinmiş kullanıcı geri eklenir; geçmiş verileri korunur
      row = check(await admin.from('users').update({ active: true, password_hash: hashPassword(password), updated_at: new Date().toISOString() })
        .eq('id', existing.id).select('id, username').single());
    } else {
      row = check(await admin.from('users').insert({ username, role: 'expert', password_hash: hashPassword(password) })
        .select('id, username').single());
    }
    return { result: row, audit: { username, restored: Boolean(existing) } };
  },

  async delete_user(me, b) {
    const u = await expertById(uuid(b.id));
    const admin = adminClient();
    check(await admin.from('users').update({ active: false, updated_at: new Date().toISOString() }).eq('id', u.id));
    check(await admin.rpc('revoke_auth_sessions', { p_user: u.id }));
    return { audit: { username: u.username } };
  },

  async set_user_password(me, b) {
    const u = await expertById(uuid(b.id));
    const password = String(b.password || '');
    if (!USER_PASSWORD_RE.test(password)) throw new HttpError(400, 'Şifre 5 haneli rakam olmalıdır');
    const admin = adminClient();
    check(await admin.from('users').update({ password_hash: hashPassword(password), updated_at: new Date().toISOString() }).eq('id', u.id));
    check(await admin.rpc('revoke_auth_sessions', { p_user: u.id }));
    return { audit: { username: u.username } };
  },

  async set_targets(me, b) {
    const postpre_target = percent(b.postpre, 'Post Pre hedefi');
    const savedesk_target = percent(b.savedesk, 'Savedesk hedefi');
    check(await adminClient().from('settings')
      .update({ postpre_target, savedesk_target, updated_at: new Date().toISOString(), updated_by: me.id }).eq('id', 1));
    return { audit: { postpre: postpre_target, savedesk: savedesk_target } };
  },

  async set_maintenance(me, b) {
    const on = Boolean(b.on);
    check(await adminClient().from('settings')
      .update({ maintenance: on, updated_at: new Date().toISOString(), updated_by: me.id }).eq('id', 1));
    return { audit: { maintenance: on } };
  },

  async change_own_password(me, b) {
    const admin = adminClient();
    const row = check(await admin.from('users').select('password_hash').eq('id', me.id).single());
    if (!verifyPassword(String(b.current || ''), row.password_hash)) throw new HttpError(400, 'Mevcut şifre hatalı');
    const next = String(b.next || '');
    if (next.length < 4 || next.length > 100) throw new HttpError(400, 'Yeni şifre en az 4 karakter olmalı');
    check(await admin.from('users').update({ password_hash: hashPassword(next), updated_at: new Date().toISOString() }).eq('id', me.id));
    return { audit: {} };
  },

  async set_count(me, b) {
    const u = await expertById(uuid(b.user_id));
    const day = isoDate(b.day);
    const item = String(b.item || '');
    if (!ITEMS.includes(item)) throw new HttpError(400, 'Geçersiz kalem');
    const value = Number(b.value);
    if (!Number.isInteger(value) || value < 0 || value > 100000) throw new HttpError(400, 'Adet 0 veya pozitif tam sayı olmalı');
    const diff = check(await adminClient().rpc('admin_set_count', { p_admin: me.id, p_user: u.id, p_day: day, p_item: item, p_value: value }));
    return { result: { diff }, audit: { username: u.username, day, item, value, diff } };
  },

  async delete_entry(me, b) {
    const id = Number(b.id);
    if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Geçersiz kayıt');
    const rows = check(await adminClient().from('entries')
      .update({ deleted_at: new Date().toISOString(), deleted_by: me.id })
      .eq('id', id).is('deleted_at', null).select('id, user_id, item, day, gsm'));
    if (!rows.length) throw new HttpError(404, 'Kayıt bulunamadı veya zaten silinmiş');
    const r = rows[0];
    return { audit: { entry_id: id, user_id: r.user_id, item: r.item, day: r.day } };
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
