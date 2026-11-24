// Sunucu tarafı ortak yardımcılar. Bu dosya yalnızca Vercel fonksiyonlarında çalışır;
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
export const SUPABASE_URL = () => env('SUPABASE_URL');
export const PUBLISHABLE_KEY = () => env('SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY');
const SECRET_KEY = () => env('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
export const CRON_SECRET = () => env('CRON_SECRET');
export const AUTH_EMAIL_DOMAIN = () => env('AUTH_EMAIL_DOMAIN') || 'uzman-hedef.example.com'; // e-posta gönderilmez; yalnızca iç kimlik

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

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : fwd || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}

export const USERNAME_RE = /^[a-z0-9çğıöşü._-]{2,40}$/;
export const normUsername = (u) => String(u || '').trim().toLocaleLowerCase('tr-TR');
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Veritabanı hatasını kullanıcıya anlaşılır biçimde aktarır
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

// Ortak istek işleyici: yöntem kontrolü, JSON gövde, hata yanıtı
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

// İsteği yapan kullanıcıyı Supabase oturum belirtecinden (JWT) doğrular
export async function getCaller(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) throw new HttpError(401, 'Oturum gerekli');
  const admin = adminClient();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, 'Oturum geçersiz veya süresi dolmuş');
  const profile = check(await admin.from('profiles').select('*').eq('auth_user_id', data.user.id).maybeSingle());
  if (!profile || !profile.active) throw new HttpError(403, 'Hesap aktif değil');
  return profile;
}

export async function requireAdmin(req) {
  const p = await getCaller(req);
  if (p.role !== 'admin') throw new HttpError(403, 'Bu işlem yalnızca yönetici içindir');
  return p;
}

// Profil için gerçek bir Supabase oturumu üretir (sunucu tarafında).
// Supabase Auth kullanıcısı ilk girişte oluşturulur ve profile bağlanır.
export async function mintSession(profile) {
  const admin = adminClient();
  const email = `${profile.id}@${AUTH_EMAIL_DOMAIN()}`;
  let authId = profile.auth_user_id;

  if (!authId) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      app_metadata: { profile_id: profile.id },
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
  if (authId && authId !== profile.auth_user_id) {
    check(await admin.from('profiles').update({ auth_user_id: authId }).eq('id', profile.id));
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

export const publicProfile = (p) => ({ id: p.id, username: p.username, display_name: p.display_name, role: p.role });

// ---------------------------------------------------------------------
// Hız sınırlama ve denetim kaydı
// ---------------------------------------------------------------------
export async function tooMany(kind, key, max, minutes, failuresOnly = true) {
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  let q = adminClient().from('auth_attempts').select('id', { count: 'exact', head: true })
    .eq('kind', kind).eq('key', key).gte('created_at', since);
  if (failuresOnly) q = q.eq('success', false);
  const { count, error } = await q;
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
