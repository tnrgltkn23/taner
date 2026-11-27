// Sunucu tarafı ortak yardımcılar. Yalnızca Vercel fonksiyonlarında çalışır;
// gizli anahtar (SUPABASE_SECRET_KEY) asla tarayıcıya gönderilmez.
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const env = (...names) => {
  for (const n of names) if (process.env[n]) return process.env[n].trim();
  return undefined;
};
// Değer ".../rest/v1/" gibi bir yol içerse bile yalnızca kök adres kullanılır
export const SUPABASE_URL = () => {
  const u = env('SUPABASE_URL');
  if (!u) return u;
  try { return new URL(u).origin; } catch { return u; }
};
export const PUBLISHABLE_KEY = () => env('SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY');
const SECRET_KEY = () => env('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
export const CRON_SECRET = () => env('CRON_SECRET');
// Çerez oturumlarını imzalamak için anahtar: gizli anahtardan türetilir (ayrı değişken gerekmez)
export function sessionKey() {
  const k = SECRET_KEY();
  if (!k) throw new HttpError(500, 'Sunucu yapılandırması eksik: SUPABASE_SECRET_KEY');
  return crypto.createHmac('sha256', k).update('uzman-portal-session-v1').digest();
}
const AUTH_EMAIL_DOMAIN = () => env('AUTH_EMAIL_DOMAIN') || 'uht2.example.com'; // e-posta gönderilmez; iç kimlik

const noPersist = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

let _admin;
export function adminClient() {
  if (!_admin) {
    const url = SUPABASE_URL();
    const key = SECRET_KEY();
    if (!url || !key) throw new HttpError(500, 'Sunucu yapılandırması eksik: SUPABASE_URL / SUPABASE_SECRET_KEY');
    _admin = createClient(url, key, noPersist);
  }
  return _admin;
}

export function publicClient() {
  const url = SUPABASE_URL();
  const key = PUBLISHABLE_KEY();
  if (!url || !key) throw new HttpError(500, 'Sunucu yapılandırması eksik: SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY');
  return createClient(url, key, noPersist);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : fwd || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}

export const USERNAME_RE = /^[a-z0-9._-]{2,40}$/;
export const USER_PASSWORD_RE = /^\d{5}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ITEMS = ['pp_ikna', 'pp_gecis', 'pp_14271', 'sd_ikna', 'sd_iptal', 'sd_17891'];
export const normUsername = (u) => String(u || '').trim().toLowerCase();

// ---------------------------------------------------------------------
// Şifre hash'i: PBKDF2-SHA256 (Node standart kütüphanesi)
// ---------------------------------------------------------------------
const ITER = 100_000;
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.pbkdf2Sync(String(pw), salt, ITER, 32, 'sha256');
  return `pbkdf2_sha256$${ITER}$${salt.toString('base64')}$${dk.toString('base64')}`;
}
export function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iter = Number(parts[1]);
  const salt = Buffer.from(parts[2], 'base64');
  const expected = Buffer.from(parts[3], 'base64');
  const dk = crypto.pbkdf2Sync(String(pw), salt, iter, expected.length, 'sha256');
  return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
}
// Kullanıcı yoksa da aynı sürede yanıt vermek için
export const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));

// ---------------------------------------------------------------------
// Hata ve istek yardımcıları
// ---------------------------------------------------------------------
export function dbError(error) {
  if (!error) return null;
  const msg = error.message || 'Veritabanı hatası';
  if (error.code === '42501') return new HttpError(403, msg);
  if (error.code === '23505') return new HttpError(409, 'Bu kayıt zaten var');
  if (error.code === 'P0001' || error.code === 'P0002' || error.code === '23514') return new HttpError(400, msg);
  return new HttpError(500, msg);
}
export function check({ data, error }) {
  if (error) throw dbError(error);
  return data;
}

export function handler(methods, fn) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!methods.includes(req.method)) throw new HttpError(405, 'Yöntem desteklenmiyor');
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body || '{}'); } catch { throw new HttpError(400, 'Geçersiz JSON'); }
      }
      const out = await fn(req, body || {}, res);
      if (!res.headersSent) res.status(200).json(out ?? { ok: true });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error(err);
      if (!res.headersSent) res.status(status).json({ error: err.message || 'Sunucu hatası' });
    }
  };
}

// ---------------------------------------------------------------------
// Kimlik doğrulama
// ---------------------------------------------------------------------
const USER_COLS = 'id, username, role, active, auth_user_id, is_super';

export async function getCaller(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) throw new HttpError(401, 'Oturum gerekli');
  const admin = adminClient();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, 'Oturum geçersiz veya süresi dolmuş');
  const u = check(await admin.from('users').select(USER_COLS).eq('auth_user_id', data.user.id).maybeSingle());
  if (!u || !u.active) throw new HttpError(403, 'Hesap aktif değil');
  return u;
}

export async function requireAdmin(req) {
  const u = await getCaller(req);
  if (u.role !== 'admin') throw new HttpError(403, 'Bu işlem yalnızca yönetici içindir');
  return u;
}

// Kullanıcı için gerçek bir Supabase oturumu üretir (sunucu tarafında).
export async function mintSession(user) {
  const admin = adminClient();
  const email = `${user.id}@${AUTH_EMAIL_DOMAIN()}`;
  let authId = user.auth_user_id;

  if (!authId) {
    const { data, error } = await admin.auth.admin.createUser({
      email, email_confirm: true, app_metadata: { app_user_id: user.id },
    });
    if (error && !/already|registered|exists/i.test(error.message)) {
      throw new HttpError(500, 'Kimlik kaydı oluşturulamadı: ' + error.message);
    }
    authId = data?.user?.id;
  }

  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (linkErr || !link?.properties?.hashed_token) {
    throw new HttpError(500, 'Oturum bağlantısı üretilemedi: ' + (linkErr?.message || ''));
  }
  authId = authId || link.user?.id;
  if (authId && authId !== user.auth_user_id) {
    check(await admin.from('users').update({ auth_user_id: authId }).eq('id', user.id));
  }

  const pub = publicClient();
  let { data: v, error: vErr } = await pub.auth.verifyOtp({ type: 'email', token_hash: link.properties.hashed_token });
  if (vErr || !v?.session) {
    ({ data: v, error: vErr } = await pub.auth.verifyOtp({ type: 'magiclink', token_hash: link.properties.hashed_token }));
  }
  if (vErr || !v?.session) throw new HttpError(500, 'Oturum açılamadı: ' + (vErr?.message || ''));
  const s = v.session;
  return { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at };
}

export const publicUser = (u) => ({ id: u.id, username: u.username, role: u.role });

// ---------------------------------------------------------------------
// Hız sınırlama ve denetim kaydı
// ---------------------------------------------------------------------
export async function tooMany(kind, key, max, minutes) {
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const { count, error } = await adminClient().from('auth_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('kind', kind).eq('key', key).eq('success', false).gte('created_at', since);
  if (error) throw dbError(error);
  return (count || 0) >= max;
}

export async function recordAttempt(kind, key, success) {
  await adminClient().from('auth_attempts').insert({ kind, key, success });
}

export async function audit(adminId, action, details = {}) {
  const { error } = await adminClient().from('admin_audit').insert({ admin_id: adminId, action, details });
  if (error) console.error('audit yazılamadı', error);
}

export async function getSettings() {
  return check(await adminClient().from('settings').select('*').eq('id', 1).single());
}
