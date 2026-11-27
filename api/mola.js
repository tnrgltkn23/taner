// Mola Planı yönetimi (/mola/): planlar Supabase'deki mola_plans tablosunda.
// Giriş yönetici hesaplarıyla (2637 / 7899) yapılır; oturum imzalı HttpOnly çerezde tutulur.
import crypto from 'node:crypto';
import {
  HttpError, adminClient, check, clientIp, UUID_RE, hashPassword, verifyPassword, DUMMY_HASH,
  tooMany, recordAttempt, audit, sleep, sessionKey,
} from './_lib/core.js';

const SESSION_S = 8 * 3600;
const COOKIE = 'uzman_mola';
const db = () => adminClient();
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
const dateOK = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + 'T12:00:00Z').toISOString().slice(0, 10) === v;
const sign = (p) => crypto.createHmac('sha256', sessionKey()).update('mola:' + p).digest('hex');
const cookie = (v) => `${COOKIE}=${v}; HttpOnly; Secure; SameSite=Strict; Path=/api/mola/; Max-Age=${v ? SESSION_S : 0}`;
const token = (id, ver) => { const body = `${id}.${ver}.${Date.now() + SESSION_S * 1000}`; return `${body}.${sign(body)}`; };

async function currentAdmin(req) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  const parts = (m ? m[1] : '').split('.');
  if (parts.length !== 4) return null;
  const [id, ver, exp, sig] = parts;
  if (!UUID_RE.test(id) || !UUID_RE.test(ver) || !/^\d{13}$/.test(exp) || Number(exp) <= Date.now() || !/^[0-9a-f]{64}$/.test(sig)) return null;
  const want = sign(`${id}.${ver}.${exp}`);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  const a = check(await db().from('users').select('id, role, active, session_version, password_hash').eq('id', id).maybeSingle());
  return a && a.active && a.role === 'admin' && a.session_version === ver ? a : null;
}

function checkedPlan(input) {
  if (!input || !Array.isArray(input.employees) || !input.employees.length || input.employees.length > 3000) throw new HttpError(400, 'Plan 1–3000 çalışan içermeli.');
  const minute = (v) => v === null || (Number.isInteger(v) && v >= 0 && v < 1440);
  const seen = new Set();
  const employees = input.employees.map((e) => {
    if (typeof e.name !== 'string' || !e.name.trim() || e.name.length > 200 || !minute(e.start) || !minute(e.end) || !minute(e.lunch)
        || !Array.isArray(e.breaks) || e.breaks.length !== 7 || !e.breaks.every(minute)) throw new HttpError(400, 'Planda geçersiz çalışan veya saat var.');
    const name = e.name.trim(); const k = name.toLocaleLowerCase('tr');
    if (seen.has(k)) throw new HttpError(400, 'Tekrarlanan çalışan adı: ' + name);
    seen.add(k);
    return { name, start: e.start, end: e.end, lunch: e.lunch, breaks: e.breaks };
  });
  const settings = { breakMin: Number(input.settings?.breakMin), lunchMin: Number(input.settings?.lunchMin) };
  if (!Object.values(settings).every((n) => Number.isInteger(n) && n > 0 && n <= 180)) throw new HttpError(400, 'Mola süreleri 1–180 dakika arasında olmalı.');
  return { employees, settings, demo: false };
}

async function route(req, r, method, b, q) {
  if (r === 'admin/session' && method === 'GET') return [200, { authenticated: Boolean(await currentAdmin(req)) }];
  if (r === 'admin/logout' && method === 'POST') return [200, { ok: true }, cookie('')];
  if (r === 'admin/login' && method === 'POST') {
    const password = String(b.password || '').slice(0, 128);
    const ip = clientIp(req);
    const [lockIp, lockAll, res] = await Promise.all([
      tooMany('admin', `ip:${ip}`, 5, 15), tooMany('admin', 'all', 30, 15),
      db().from('users').select('id, password_hash, session_version').eq('role', 'admin').eq('active', true).order('is_super', { ascending: false }),
    ]);
    if (lockIp || lockAll) return [429, { error: 'Çok fazla deneme. 15 dakika sonra tekrar dene.' }];
    const admins = check(res) || [];
    let a = null;
    for (const x of admins) if (!a && verifyPassword(password, x.password_hash)) a = x;
    if (admins.length < 2) verifyPassword(password, DUMMY_HASH);
    if (!a) { await Promise.all([recordAttempt('admin', `ip:${ip}`, false), recordAttempt('admin', 'all', false), sleep(500)]); return [401, { error: 'Şifre hatalı.' }]; }
    await Promise.all([audit(a.id, 'admin_login', { ip, mola: true }), db().from('admin_logins').insert({ user_id: a.id, ip, user_agent: String(req.headers['user-agent'] || '').slice(0, 300) })]);
    return [200, { ok: true }, cookie(token(a.id, a.session_version))];
  }
  const me = await currentAdmin(req);
  if (!me) return [401, { error: 'Yönetici oturumu gerekli.' }];
  if (r === 'admin/authorize' && method === 'POST') return [200, { ok: true }];
  if (r === 'admin/password' && method === 'POST') {
    if (!verifyPassword(String(b.current || ''), me.password_hash)) return [400, { error: 'Mevcut şifre hatalı.' }];
    if (typeof b.password !== 'string' || b.password.length < 6 || b.password.length > 100) return [400, { error: 'Yeni şifre 6–100 karakter olmalı.' }];
    const ver = crypto.randomUUID();
    check(await db().from('users').update({ password_hash: hashPassword(b.password), session_version: ver, updated_at: new Date().toISOString() }).eq('id', me.id));
    await audit(me.id, 'change_own_password', { mola: true });
    return [200, { ok: true }, cookie(token(me.id, ver))];
  }
  if (r === 'admin/maintenance') {
    if (method === 'GET') {
      const { data } = await db().from('portal_settings').select('value').eq('key', 'maintenance').maybeSingle();
      return [200, data?.value || { enabled: false, message: '' }];
    }
    if (method === 'POST') {
      if (typeof b.enabled !== 'boolean') return [400, { error: 'Geçersiz bakım ayarı.' }];
      const value = { enabled: b.enabled, message: String(b.message || '').slice(0, 300) };
      check(await db().from('portal_settings').upsert({ key: 'maintenance', value, updated_at: new Date().toISOString() }));
      return [200, value];
    }
  }
  if (r === 'admin/plans') {
    if (method === 'GET') {
      if (q.date) {
        if (!dateOK(q.date)) return [400, { error: 'Geçersiz tarih.' }];
        const row = check(await db().from('mola_plans').select('data, filename, updated_at').eq('date', q.date).maybeSingle());
        return [200, { plan: row?.data ?? null, date: q.date, filename: row?.filename, updatedAt: row?.updated_at }];
      }
      if (!dateOK(q.from) || !dateOK(q.to) || q.from > q.to || Date.parse(q.to) - Date.parse(q.from) > 32 * 86400_000) return [400, { error: 'Geçersiz tarih aralığı.' }];
      const rows = check(await db().from('mola_plans').select('date, data, filename, updated_at').gte('date', q.from).lte('date', q.to).order('date'));
      return [200, { days: rows.map((x) => ({ date: x.date, filename: x.filename, updatedAt: x.updated_at, count: x.data.employees.length })) }];
    }
    if (method === 'POST') {
      if (!Array.isArray(b.days) || !b.days.length || b.days.length > 31) return [400, { error: 'Tek seferde 1–31 günlük plan yükleyebilirsin.' }];
      const seen = new Set(); const time = new Date().toISOString();
      const rows = b.days.map((x) => {
        if (!dateOK(x.date) || seen.has(x.date)) throw new HttpError(400, 'Her plan için farklı ve geçerli bir tarih seç.');
        seen.add(x.date);
        return { date: x.date, filename: String(x.filename || 'Plan').slice(0, 200), data: checkedPlan(x.plan), updated_at: time };
      });
      check(await db().from('mola_plans').upsert(rows));
      await audit(me.id, 'portal_plans', { days: rows.map((x) => x.date) });
      return [200, { ok: true, count: rows.length }];
    }
    if (method === 'DELETE') {
      if (!dateOK(b.date)) return [400, { error: 'Geçersiz tarih.' }];
      check(await db().from('mola_plans').delete().eq('date', b.date));
      await audit(me.id, 'portal_plan_delete', { date: b.date });
      return [200, { ok: true }];
    }
  }
  return [404, { error: 'Bulunamadı.' }];
}

export default async function mola(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const q = { ...(req.query || {}) };
    const r = String(q.r || '').replace(/^\/+|\/+$/g, ''); delete q.r;
    if (req.method !== 'GET') {
      const origin = req.headers.origin; const host = req.headers['x-forwarded-host'] || req.headers.host;
      if (!origin || new URL(origin).host !== host) throw new HttpError(403, 'Geçersiz istek.');
    }
    let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b || '{}'); } catch { b = {}; } }
    const [status, body, setCookie] = await route(req, r, req.method, b || {}, q);
    if (setCookie) res.setHeader('Set-Cookie', setCookie);
    res.status(status).json(body);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) console.error('mola', e);
    res.status(status).json({ error: status >= 500 ? 'İşlem tamamlanamadı.' : e.message });
  }
}
