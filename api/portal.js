// Uzman Mola portalı sunucusu. Portalın ekranları (Günlük Verilerim, yönetici, mola planı,
// İkna Rehberi) bu tek fonksiyona yönlendirilir (vercel.json → rewrites, ?r=<yol>).
// Veriler mevcut Supabase tablolarımızdan gelir; oturumlar imzalı HttpOnly çerezlerle tutulur.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  HttpError, adminClient, check, clientIp, normUsername, USERNAME_RE, USER_PASSWORD_RE, UUID_RE, ITEMS,
  hashPassword, verifyPassword, DUMMY_HASH, tooMany, recordAttempt, audit, getSettings, sleep, sessionKey,
} from './_lib/core.js';

const ITEM_LIST = [
  { code: 'pp_ikna', label: '484 İkna', group: 'pp' },
  { code: 'pp_gecis', label: '484 Geçiş', group: 'pp' },
  { code: 'pp_14271', label: '14271', group: 'pp' },
  { code: 'sd_ikna', label: '16234 İkna', group: 'sd' },
  { code: 'sd_iptal', label: '16234 İptal', group: 'sd' },
  { code: 'sd_17891', label: '17891', group: 'sd' },
];
const USER_SESSION_S = 8 * 3600;
const MANAGER_SESSION_S = 4 * 3600;
const PLAN_ADMIN_SESSION_S = 8 * 3600;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------- yardımcılar
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dateOK = (v) => typeof v === 'string' && DAY_RE.test(v) && new Date(v + 'T12:00:00Z').toISOString().slice(0, 10) === v;
const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400_000).toISOString().slice(0, 10);
const ms = (iso) => (iso ? Date.parse(iso) : null);
const db = () => adminClient();

class Reply {
  constructor(status, body, cookies = []) { this.status = status; this.body = body; this.cookies = cookies; }
}
const reply = (body, status = 200, cookies = []) => new Reply(status, body, cookies);

function cookieOf(req, name) {
  const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : '';
}
const cookie = (name, value, maxAge, p) => `${name}=${value}; HttpOnly; Secure; SameSite=Strict; Path=${p}; Max-Age=${value ? maxAge : 0}`;
const sign = (payload) => crypto.createHmac('sha256', sessionKey()).update(payload).digest('hex');
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Token: <alanlar>.<bitiş ms>.<imza>
function makeToken(kind, fields, seconds) {
  const exp = String(Date.now() + seconds * 1000);
  const body = [...fields, exp].join('.');
  return `${body}.${sign(kind + ':' + body)}`;
}
function readToken(kind, token, count) {
  const parts = String(token || '').split('.');
  if (parts.length !== count + 2) return null;
  const sig = parts.pop();
  const exp = parts[parts.length - 1];
  if (!/^\d{13}$/.test(exp) || Number(exp) <= Date.now() || !/^[0-9a-f]{64}$/.test(sig)) return null;
  if (!safeEq(sig, sign(kind + ':' + parts.join('.')))) return null;
  return parts.slice(0, count);
}

const rateFraction = (v) => Math.round(Number(v) * 10000) / 100; // 0.65 → 65
async function targets() {
  const s = await getSettings();
  return { pp: rateFraction(s.postpre_target), sd: rateFraction(s.savedesk_target) };
}
async function portalSetting(key, fallback) {
  const { data } = await db().from('portal_settings').select('value').eq('key', key).maybeSingle();
  return data ? data.value : fallback;
}
async function putPortalSetting(key, value) {
  check(await db().from('portal_settings').upsert({ key, value, updated_at: new Date().toISOString() }));
}

// Supabase en fazla 1000 satır döndürür: sayfalayarak hepsini al
async function allRows(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = check(await build().range(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

// ---------------------------------------------------------------- uzman oturumu (Günlük Verilerim)
async function currentUser(req) {
  const f = readToken('daily', cookieOf(req, 'uzman_daily'), 2);
  if (!f || !UUID_RE.test(f[0]) || !UUID_RE.test(f[1])) return null;
  const u = check(await db().from('users').select('id, username, full_name, active, role, session_version')
    .eq('id', f[0]).maybeSingle());
  if (!u || !u.active || u.role !== 'expert' || u.session_version !== f[1]) return null;
  return { id: u.id, username: u.username, name: u.full_name || u.username };
}

function entryOut(r) {
  return { id: r.uid, item: r.item, gsm: r.gsm, delta: r.delta, createdAt: ms(r.created_at), source: r.source === 'user' ? 'expert' : 'admin' };
}
async function dayEntries(userId, day) {
  const rows = check(await db().from('entries').select('uid, item, gsm, delta, created_at, source')
    .eq('user_id', userId).eq('day', day).is('deleted_at', null)
    .order('created_at', { ascending: false }).order('id', { ascending: false }));
  return rows.map(entryOut);
}

// Mola planı eşleştirmesi: ad soyad aksan ve büyük/küçük harf farkı gözetmeden
const planKey = (name) => String(name || '').normalize('NFKD').replace(/\p{M}/gu, '').replace(/ı/g, 'i').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();
function planEmployee(plan, name) {
  const list = Array.isArray(plan?.employees) ? plan.employees : [];
  const exact = list.filter((e) => e.name.trim() === name.trim());
  if (exact.length === 1) return exact[0];
  const k = planKey(name);
  const m = list.filter((e) => planKey(e.name) === k);
  return m.length === 1 ? m[0] : null;
}
async function planSnapshot(user, day) {
  const yesterday = addDays(day, -1);
  const rows = check(await db().from('mola_plans').select('date, data').in('date', [day, yesterday]).order('date', { ascending: false }));
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date()).split(':').map(Number);
  const now = h * 60 + m;
  const matches = rows.map((r) => ({ date: r.date, employee: planEmployee(r.data, user.name), settings: r.data.settings }));
  const overnight = matches.find(({ date, employee }) => date === yesterday && employee?.start != null && employee.end != null && employee.end <= employee.start && now < employee.end);
  const current = overnight ?? matches.find((r) => r.date === day && r.employee);
  return { name: user.name, today: day, plan: current ?? null };
}
async function planWithin(user, day, millis) {
  let t;
  const deadline = new Promise((r) => { t = setTimeout(r, millis); });
  try { return await Promise.race([planSnapshot(user, day).catch(() => undefined), deadline]); } finally { clearTimeout(t); }
}

async function maintenanceMessage() {
  const [s, portal] = await Promise.all([getSettings(), portalSetting('maintenance', { enabled: false })]);
  if (portal?.enabled) return portal.message || 'Uzman Mola bakımda.';
  if (s.maintenance) return 'Günlük Verilerim bakımda.';
  return null;
}

async function dailyLogin(req, body) {
  const username = normUsername(body.username);
  const pin = typeof body.pin === 'string' ? body.pin : '';
  if (!USERNAME_RE.test(username) || !USER_PASSWORD_RE.test(pin)) return reply({ error: 'Kullanıcı adı ve 5 haneli şifre gir.' }, 400);
  const ip = clientIp(req);
  const [lockUser, lockIp, res] = await Promise.all([
    tooMany('user', `u:${username}`, 5, 15),
    tooMany('user', `ip:${ip}`, 25, 15),
    db().from('users').select('id, username, full_name, active, password_hash, session_version').eq('username', username).eq('role', 'expert').maybeSingle(),
  ]);
  if (lockUser || lockIp) return reply({ error: 'Çok fazla deneme. 15 dakika sonra tekrar dene.' }, 429);
  const u = check(res);
  if (!(verifyPassword(pin, u?.password_hash || DUMMY_HASH) && u?.active)) {
    await Promise.all([recordAttempt('user', `u:${username}`, false), recordAttempt('user', `ip:${ip}`, false), sleep(300)]);
    return reply({ error: 'Kullanıcı adı veya şifre hatalı.' }, 401);
  }
  await recordAttempt('user', `u:${username}`, true);
  const c = cookie('uzman_daily', makeToken('daily', [u.id, u.session_version], USER_SESSION_S), USER_SESSION_S, '/api/daily/');
  if (body.includePlan !== true) return reply({ ok: true }, 200, [c]);
  const user = { id: u.id, username: u.username, name: u.full_name || u.username };
  const d = today();
  const [t, myPlan] = await Promise.all([targets(), planWithin(user, d, 1200)]);
  return reply({ ok: true, user, today: d, items: ITEM_LIST, targets: t, myPlan }, 200, [c]);
}

async function addEntry(user, d, body) {
  const { id, item, gsm, force } = body;
  if (!UUID_RE.test(String(id || '')) || !ITEMS.includes(item) || typeof gsm !== 'string' || !/^[0-9]{10}$/.test(gsm) || typeof force !== 'boolean') {
    return reply({ error: 'Geçerli bir kalem ve 10 haneli GSM numarası gir.' }, 400);
  }
  if (body.day !== d) return reply({ error: 'Gün değişti. Bugünün skorunu açıp tekrar dene.' }, 409);
  const prev = check(await db().from('entries').select('user_id, day, item, gsm, created_at, deleted_at').eq('uid', id).maybeSingle());
  if (prev) {
    if (prev.user_id === user.id && prev.day === d && prev.item === item && prev.gsm === gsm && !prev.deleted_at) {
      return reply({ id, undoUntil: ms(prev.created_at) + 10_000 });
    }
    return reply({ error: 'Bu kayıt isteği daha önce kullanılmış.' }, 409);
  }
  if (!force) {
    const { count } = await db().from('entries').select('id', { count: 'exact', head: true })
      .eq('user_id', user.id).eq('day', d).eq('gsm', gsm).is('deleted_at', null);
    if (count > 0) return reply({ duplicate: true }, 409);
  }
  const row = check(await db().from('entries')
    .insert({ uid: id, user_id: user.id, item, gsm, delta: 1, source: 'user', day: d, created_by: user.id })
    .select('created_at').single());
  await db().from('users').update({ last_entry_at: row.created_at }).eq('id', user.id);
  return reply({ id, undoUntil: ms(row.created_at) + 10_000 }, 201);
}

async function undoEntry(user, body) {
  if (!UUID_RE.test(String(body.id || ''))) return reply({ error: 'Geçersiz kayıt.' }, 400);
  const since = new Date(Date.now() - 11_000).toISOString();
  const rows = check(await db().from('entries').update({ deleted_at: new Date().toISOString(), deleted_by: user.id, gsm: null })
    .eq('uid', body.id).eq('user_id', user.id).eq('source', 'user').is('deleted_at', null).gte('created_at', since).select('id'));
  return rows.length ? reply({ ok: true }) : reply({ error: 'Kayıt geri alınamadı veya geri alma süresi doldu.' }, 409);
}

async function contestList(forExpert) {
  let q = db().from('contests').select('id, target, prize, starts_at, ends_at, cancelled_at').order('starts_at', { ascending: false }).limit(30);
  if (forExpert) q = q.is('cancelled_at', null).gt('ends_at', new Date().toISOString());
  return check(await q).map((c) => ({ id: String(c.id), target: c.target, prize: c.prize, startsAt: ms(c.starts_at), endsAt: ms(c.ends_at), cancelledAt: ms(c.cancelled_at) }));
}

async function dailyRoute(req, route, isGet, body, q) {
  if (!isGet && route === 'login') return dailyLogin(req, body);
  if (!isGet && route === 'logout') return reply({ ok: true }, 200, [cookie('uzman_daily', '', 0, '/api/daily/')]);
  if (route.startsWith('admin/')) return managerRoute(req, route.slice(6), isGet, body, q);

  const d = today();
  const user = await currentUser(req);
  if (isGet && route === 'session') {
    const [t, myPlan] = await Promise.all([targets(), user && q.plan === '1' ? planWithin(user, d, 1200) : undefined]);
    return reply({ user, today: d, items: ITEM_LIST, targets: t, myPlan });
  }
  if (!user) return reply({ error: 'Uzman oturumu gerekli.' }, 401);
  const maint = await maintenanceMessage();
  if (maint) return reply({ error: maint }, 503);
  if (isGet && route === 'my-plan') return reply(await planSnapshot(user, d));
  if (isGet && route === 'contests') return reply({ contests: await contestList(true) });
  if (isGet && route === 'entries') {
    const day = q.day ?? d;
    if (!dateOK(day) || day > d) return reply({ error: 'Geçerli bir tarih seç.' }, 400);
    const [entries, t] = await Promise.all([dayEntries(user.id, day), targets()]);
    // Uzman GSM numaralarını hiçbir zaman görmez: yalnızca kalem ve adet gönderilir
    return reply({ day, today: d, entries: entries.map((e) => ({ ...e, gsm: null })), targets: t });
  }
  if (!isGet && route === 'entries') return addEntry(user, d, body);
  if (!isGet && route === 'undo') return undoEntry(user, body);
  return reply({ error: 'İşlem bulunamadı.' }, 404);
}

// ---------------------------------------------------------------- yönetici oturumu (2637 / 7899)
// Portaldaki yönetici ekranları aynı iki hesapla açılır: yönetici ve üst yönetici (is_super).
async function adminLogin(req, password) {
  if (password.length < 4 || password.length > 100) return { error: reply({ error: 'Yönetici şifresini gir.' }, 400) };
  const ip = clientIp(req);
  const [lockIp, lockAll, res] = await Promise.all([
    tooMany('admin', `ip:${ip}`, 5, 15),
    tooMany('admin', 'all', 30, 15),
    db().from('users').select('id, username, password_hash, is_super, session_version').eq('role', 'admin').eq('active', true).order('is_super', { ascending: false }),
  ]);
  if (lockIp || lockAll) return { error: reply({ error: 'Çok fazla deneme. 15 dakika sonra tekrar dene.' }, 429) };
  const admins = check(res) || [];
  let a = null;
  for (const x of admins) if (!a && verifyPassword(password, x.password_hash)) a = x;
  if (admins.length < 2) verifyPassword(password, DUMMY_HASH);
  if (!a) {
    await Promise.all([recordAttempt('admin', `ip:${ip}`, false), recordAttempt('admin', 'all', false), sleep(500)]);
    return { error: reply({ error: 'Yönetici şifresi hatalı.' }, 401) };
  }
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  await Promise.all([
    audit(a.id, 'admin_login', { ip, portal: true }),
    db().from('admin_logins').insert({ user_id: a.id, ip, user_agent: ua }),
  ]);
  return { admin: a };
}
async function adminFromToken(kind, token) {
  const f = readToken(kind, token, 2);
  if (!f || !UUID_RE.test(f[0]) || !UUID_RE.test(f[1])) return null;
  const a = check(await db().from('users').select('id, username, is_super, active, role, session_version, password_hash').eq('id', f[0]).maybeSingle());
  if (!a || !a.active || a.role !== 'admin' || a.session_version !== f[1]) return null;
  return a;
}
async function changeAdminPassword(a, current, next, minLen) {
  if (!verifyPassword(String(current || ''), a.password_hash)) return reply({ error: 'Mevcut şifre hatalı.' }, 400);
  if (typeof next !== 'string' || next.length < minLen || next.length > 100 || next === current) {
    return reply({ error: `Yeni şifre mevcut şifreden farklı ve ${minLen}–100 karakter olmalı.` }, 400);
  }
  const version = crypto.randomUUID();
  check(await db().from('users').update({ password_hash: hashPassword(next), session_version: version, updated_at: new Date().toISOString() }).eq('id', a.id));
  await audit(a.id, 'change_own_password', { portal: true });
  return { version };
}

// ---------------------------------------------------------------- Günlük Verilerim yönetimi
// Bizim işlem adlarımız → portal ekranının tanıdığı adlar
const AUDIT_AS = {
  create_user: 'users', delete_user: 'users', set_user_password: 'users', set_count: 'adjust', delete_entry: 'remove',
  set_team: 'teams', create_team_leader: 'teams', delete_team_leader: 'teams', create_contest: 'contests', cancel_contest: 'contests',
  change_own_password: 'password', set_maintenance: 'maintenance', set_targets: 'targets', plan_names: 'plan-names',
  portal_plans: 'Mola planı yüklendi', portal_plan_delete: 'Mola planı silindi', portal_maintenance: 'Site bakım ayarı değiştirildi',
};
const managerCookie = (v) => cookie('uzman_daily_manager', v, MANAGER_SESSION_S, '/api/daily/admin/');

async function report(q, d) {
  const { day, month, user, team } = q;
  if ((day && (!dateOK(day) || day > d)) || (month && !dateOK(month + '-01')) || (!day && !month) || (day && month)
      || (user && !UUID_RE.test(user)) || (team && !UUID_RE.test(team))) {
    return reply({ error: 'Geçerli bir tarih veya ay seç.' }, 400);
  }
  const from = day || month + '-01';
  const to = day || addDays(addDays(month + '-01', 31).slice(0, 7) + '-01', -1);
  const rows = await allRows(() => db().rpc('portal_report', { p_from: from, p_to: to, p_user: user || null, p_team: team || null }));
  const totals = rows.map((r) => ({ day: r.day, userId: r.user_id, name: r.name, username: r.username, team: r.team, item: r.item, total: Number(r.total) }));
  return reply({ totals, entries: day && user ? await dayEntries(user, day) : [] });
}

async function manageUser(me, body) {
  const pin = typeof body.pin === 'string' ? body.pin : '';
  const now = new Date().toISOString();
  // Ad soyad düzenleme (mola planındaki adla eşleşir ve uzmanın ekranında görünür)
  if (body.id && typeof body.name === 'string' && !pin && body.active === undefined) {
    const name = body.name.trim().replace(/\s+/g, ' ');
    if (!UUID_RE.test(body.id) || name.length < 2 || name.length > 100) return reply({ error: 'Ad soyad 2–100 karakter olmalı.' }, 400);
    const rows = check(await db().from('users').update({ full_name: name, updated_at: now }).eq('id', body.id).eq('role', 'expert').select('username'));
    if (!rows.length) return reply({ error: 'Uzman hesabı bulunamadı.' }, 404);
    await audit(me.id, 'plan_names', { username: rows[0].username, portal: true });
    return reply({ ok: true });
  }
  if (body.id) {
    if (!UUID_RE.test(body.id) || (pin && !USER_PASSWORD_RE.test(pin)) || (!pin && typeof body.active !== 'boolean')) {
      return reply({ error: 'Yeni şifre 5 haneli olmalı.' }, 400);
    }
    const patch = { session_version: crypto.randomUUID(), updated_at: now };
    if (typeof body.active === 'boolean') patch.active = body.active;
    if (pin) patch.password_hash = hashPassword(pin);
    const rows = check(await db().from('users').update(patch).eq('id', body.id).eq('role', 'expert').select('id, username'));
    if (!rows.length) return reply({ error: 'Uzman hesabı bulunamadı.' }, 404);
    if (pin || body.active === false) check(await db().rpc('revoke_auth_sessions', { p_user: body.id }));
    await audit(me.id, pin ? 'set_user_password' : body.active ? 'create_user' : 'delete_user', { username: rows[0].username, portal: true });
    return reply({ ok: true });
  }
  const username = normUsername(body.username);
  const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
  if (!USERNAME_RE.test(username) || name.length < 2 || name.length > 100 || !USER_PASSWORD_RE.test(pin)) {
    return reply({ error: 'Ad, geçerli kullanıcı adı ve 5 haneli şifre gerekli.' }, 400);
  }
  const existing = check(await db().from('users').select('id').eq('username', username).maybeSingle());
  if (existing) return reply({ error: 'Bu kullanıcı adı zaten var.' }, 409);
  check(await db().from('users').insert({ username, full_name: name, role: 'expert', password_hash: hashPassword(pin) }));
  await audit(me.id, 'create_user', { username, portal: true });
  return reply({ ok: true }, 201);
}

async function planNames(body) {
  const { links } = body;
  if (!Array.isArray(links) || links.length < 1 || links.length > 60) return reply({ error: 'Tek seferde 1–60 uzman eşleştirilebilir.' }, 400);
  const names = new Map();
  for (const l of links) {
    const username = typeof l?.username === 'string' ? l.username.trim().toLowerCase() : '';
    const name = typeof l?.name === 'string' ? l.name.trim().replace(/\s+/g, ' ') : '';
    if (!USERNAME_RE.test(username) || name.length < 2 || name.length > 100 || names.has(username)) return reply({ error: 'Geçersiz veya yinelenen uzman eşleştirmesi.' }, 400);
    names.set(username, name);
  }
  const users = check(await db().from('users').select('username, full_name').eq('role', 'expert'));
  const existing = new Map(users.map((u) => [u.username, u.full_name || u.username]));
  if ([...names.keys()].some((u) => !existing.has(u))) return reply({ error: 'Eşleştirme listesinde sitede bulunmayan kullanıcı var.' }, 400);
  const intended = new Map();
  for (const [username, oldName] of existing) {
    const k = planKey(names.get(username) ?? oldName);
    if (intended.has(k) && (names.has(username) || names.has(intended.get(k)))) return reply({ error: 'Bir ad soyad birden fazla uzman hesabına bağlanamaz.' }, 409);
    intended.set(k, username);
  }
  const changes = [...names].filter(([u, n]) => n !== existing.get(u));
  for (const [username, full_name] of changes) check(await db().from('users').update({ full_name }).eq('username', username));
  return reply({ matched: names.size, updated: changes.length });
}

async function adjust(me, body, d) {
  const { userId, day, item, total } = body;
  if (!UUID_RE.test(String(userId || '')) || !dateOK(day) || day > d || !ITEMS.includes(item) || !Number.isInteger(total) || total < 0 || total > 10000) {
    return reply({ error: 'Geçerli bir tarih, kalem ve 0–10.000 arası adet gir.' }, 400);
  }
  const diff = check(await db().rpc('admin_set_count', { p_admin: me.id, p_user: userId, p_day: day, p_item: item, p_value: total }));
  await audit(me.id, 'set_count', { user_id: userId, day, item, value: total, diff, portal: true });
  return reply({ ok: true });
}

async function removeEntry(me, body) {
  if (!UUID_RE.test(String(body.id || ''))) return reply({ error: 'Geçersiz kayıt.' }, 400);
  const rows = check(await db().from('entries').update({ deleted_at: new Date().toISOString(), deleted_by: me.id, gsm: null })
    .eq('uid', body.id).eq('source', 'user').is('deleted_at', null).select('user_id, item, day'));
  if (!rows.length) return reply({ error: 'Kayıt silinemedi. Güncel toplamı ve kayıt durumunu kontrol et.' }, 409);
  await audit(me.id, 'delete_entry', { ...rows[0], portal: true });
  return reply({ ok: true });
}

async function manageTeam(me, body) {
  if (body.userId) {
    if (!UUID_RE.test(body.userId) || (body.teamId !== null && !UUID_RE.test(String(body.teamId)))) return reply({ error: 'Geçerli bir uzman ve takım seç.' }, 400);
    if (body.teamId && !check(await db().from('team_leaders').select('id').eq('id', body.teamId).maybeSingle())) return reply({ error: 'Uzman veya takım bulunamadı.' }, 404);
    const rows = check(await db().from('users').update({ team_leader_id: body.teamId }).eq('id', body.userId).eq('role', 'expert').select('username'));
    if (!rows.length) return reply({ error: 'Uzman veya takım bulunamadı.' }, 404);
    await audit(me.id, 'set_team', { username: rows[0].username, portal: true });
    return reply({ ok: true });
  }
  if (body.remove) {
    if (!UUID_RE.test(body.remove)) return reply({ error: 'Geçersiz takım.' }, 400);
    const rows = check(await db().from('team_leaders').delete().eq('id', body.remove).select('name'));
    if (!rows.length) return reply({ error: 'Takım bulunamadı.' }, 404);
    await audit(me.id, 'delete_team_leader', { name: rows[0].name, portal: true });
    return reply({ ok: true });
  }
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 2 || name.length > 60) return reply({ error: 'Takım lideri adı 2–60 karakter olmalı.' }, 400);
  const { error } = await db().from('team_leaders').insert({ name });
  if (error?.code === '23505') return reply({ error: 'Bu takım zaten var.' }, 409);
  if (error) throw new HttpError(500, error.message);
  await audit(me.id, 'create_team_leader', { name, portal: true });
  return reply({ ok: true }, 201);
}

const trTime = (t) => new Date(t).toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit' });
const trDate = (t) => new Date(t).toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul', day: 'numeric', month: 'long' });
async function manageContest(me, body) {
  if (body.cancel) {
    const id = Number(body.cancel);
    if (!Number.isInteger(id) || id < 1) return reply({ error: 'Geçersiz yarışma.' }, 400);
    const rows = check(await db().from('contests').update({ cancelled_at: new Date().toISOString() }).eq('id', id).is('cancelled_at', null).select('message'));
    if (!rows.length) return reply({ error: 'Yarışma bulunamadı veya iptal edilmiş.' }, 404);
    await audit(me.id, 'cancel_contest', { contest_id: id, message: rows[0].message, portal: true });
    return reply({ ok: true });
  }
  const { startsAt, endsAt, target } = body;
  const prize = typeof body.prize === 'string' ? body.prize.trim() : '';
  if (!Number.isSafeInteger(startsAt) || !Number.isSafeInteger(endsAt) || endsAt <= Date.now() || endsAt <= startsAt
      || endsAt - startsAt > 86400_000 || !Number.isInteger(target) || target < 1 || target > 10000 || !prize || prize.length > 120) {
    return reply({ error: 'Zaman aralığını, ikna hedefini ve ödülü kontrol et. Yarışma en fazla 24 saat sürer.' }, 400);
  }
  const message = `${trDate(startsAt)} ${trTime(startsAt)}–${trTime(endsAt)} arasında toplam ${target} ikna (484 İkna + 16234 İkna) yapana ${prize} verilecektir.`;
  const row = check(await db().from('contests').insert({ message, target, prize, starts_at: new Date(startsAt).toISOString(), ends_at: new Date(endsAt).toISOString(), created_by: me.id }).select('id').single());
  await audit(me.id, 'create_contest', { contest_id: row.id, message, portal: true });
  return reply({ ok: true }, 201);
}

async function contestResults(q) {
  const from = Number(q.from); const to = Number(q.to); const team = q.team;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to <= from || to - from > 86400_000 || (team && !UUID_RE.test(team))) {
    return reply({ error: 'En fazla 24 saatlik geçerli bir zaman aralığı seç.' }, 400);
  }
  const rows = check(await db().rpc('portal_contest_results', { p_from: new Date(from).toISOString(), p_to: new Date(to).toISOString(), p_team: team || null }));
  return reply({ rows: rows.map((r) => ({ name: r.name, username: r.username, team: r.team, pp: Number(r.pp), sd: Number(r.sd), total: Number(r.total) })) });
}

async function managerRoute(req, route, isGet, body, q) {
  if (!isGet && route === 'login') {
    const r = await adminLogin(req, typeof body.password === 'string' ? body.password : '');
    if (r.error) return r.error;
    const role = r.admin.is_super ? 'super' : 'admin';
    return reply({ role }, 200, [managerCookie(makeToken('manager', [r.admin.id, r.admin.session_version], MANAGER_SESSION_S))]);
  }
  if (!isGet && route === 'logout') return reply({ ok: true }, 200, [managerCookie('')]);
  const me = await adminFromToken('manager', cookieOf(req, 'uzman_daily_manager'));
  if (!me) return reply({ error: 'Yönetici oturumu gerekli.' }, 401);
  const role = me.is_super ? 'super' : 'admin';
  const d = today();

  if (isGet) {
    if (route === 'config') {
      const [users, teams, t, s, contests] = await Promise.all([
        db().from('users').select('id, username, full_name, active, team_leader_id').eq('role', 'expert'),
        db().from('team_leaders').select('id, name').order('name'),
        targets(), getSettings(), contestList(false),
      ]);
      const list = check(users).map((u) => ({ id: u.id, username: u.username, name: u.full_name || u.username, hasName: Boolean(u.full_name), active: u.active ? 1 : 0, teamId: u.team_leader_id }))
        .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
      return reply({ today: d, role, items: ITEM_LIST, targets: t, users: list, teams: check(teams), maintenance: Boolean(s.maintenance), contests });
    }
    if (route === 'report') return report(q, d);
    if (route === 'contest-results') return contestResults(q);
    if (route === 'audit') {
      const rows = check(await db().from('admin_audit').select('action, created_at, admin:users(is_super)').neq('action', 'admin_login').order('created_at', { ascending: false }).limit(50));
      return reply({ rows: rows.map((r) => ({ role: r.admin?.is_super ? 'super' : 'admin', action: AUDIT_AS[r.action] || r.action, at: ms(r.created_at) })) });
    }
    if (route === 'logins') {
      if (role !== 'super') return reply({ error: 'Bu ekran yalnızca süper yönetici içindir.' }, 403);
      const rows = check(await db().from('admin_logins').select('ip, user_agent, created_at, user:users(is_super)')
        .gte('created_at', new Date(Date.now() - 90 * 86400_000).toISOString()).order('created_at', { ascending: false }).limit(500));
      return reply({ rows: rows.map((r) => ({ role: r.user?.is_super ? 'super' : 'admin', at: ms(r.created_at), ip: r.ip, agent: r.user_agent })) });
    }
    return reply({ error: 'İşlem bulunamadı.' }, 404);
  }

  switch (route) {
    case 'users': return manageUser(me, body);
    case 'plan-names': {
      const r = await planNames(body);
      if (r.status === 200) await audit(me.id, 'plan_names', { updated: r.body.updated, portal: true });
      return r;
    }
    case 'adjust': return adjust(me, body, d);
    case 'remove': return removeEntry(me, body);
    case 'teams': return manageTeam(me, body);
    case 'contests': return manageContest(me, body);
    case 'password': {
      if (!await tooMany('admin', `change:${me.id}`, 5, 15)) {
        const r = await changeAdminPassword(me, body.current, body.next, 8);
        if (r instanceof Reply) { await recordAttempt('admin', `change:${me.id}`, false); return r; }
        return reply({ ok: true }, 200, [managerCookie(makeToken('manager', [me.id, r.version], MANAGER_SESSION_S))]);
      }
      return reply({ error: 'Çok fazla deneme. 15 dakika sonra tekrar dene.' }, 429);
    }
    case 'maintenance': {
      if (typeof body.enabled !== 'boolean') return reply({ error: 'Geçersiz bakım ayarı.' }, 400);
      check(await db().from('settings').update({ maintenance: body.enabled, updated_at: new Date().toISOString(), updated_by: me.id }).eq('id', 1));
      await audit(me.id, 'set_maintenance', { maintenance: body.enabled, portal: true });
      return reply({ ok: true });
    }
    case 'targets': {
      const { pp, sd } = body;
      if (![pp, sd].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100)) return reply({ error: 'Hedefler 0–100 arasında olmalı.' }, 400);
      const postpre_target = Math.round(pp * 100) / 10000; const savedesk_target = Math.round(sd * 100) / 10000;
      check(await db().from('settings').update({ postpre_target, savedesk_target, updated_at: new Date().toISOString(), updated_by: me.id }).eq('id', 1));
      await audit(me.id, 'set_targets', { postpre: postpre_target, savedesk: savedesk_target, portal: true });
      return reply({ ok: true });
    }
    default: return reply({ error: 'İşlem bulunamadı.' }, 404);
  }
}

// ---------------------------------------------------------------- mola planı yönetimi (/admin/)
const planAdminCookie = (v) => cookie('uzman_admin', v, PLAN_ADMIN_SESSION_S, '/');
const planAdmin = (req) => adminFromToken('plan-admin', cookieOf(req, 'uzman_admin'));

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

async function stateRoute(req) {
  const [maintenance, a] = await Promise.all([portalSetting('maintenance', { enabled: false, message: '' }), planAdmin(req)]);
  const d = today();
  if (!a) return reply({ today: d, maintenance, plan: null, isAdmin: false });
  const row = check(await db().from('mola_plans').select('date, data, filename, updated_at').lte('date', d).order('date', { ascending: false }).limit(1).maybeSingle());
  return reply({ today: d, maintenance, isAdmin: true, plan: row?.data ?? null, planDate: row?.date ?? null, filename: row?.filename ?? null, updatedAt: row?.updated_at ?? null, stale: !!row && row.date !== d });
}

async function planAdminRoute(req, route, method, body, q) {
  if (route === 'session' && method === 'GET') return reply({ authenticated: Boolean(await planAdmin(req)) });
  if (route === 'logout' && method === 'POST') return reply({ ok: true }, 200, [planAdminCookie('')]);
  if (route === 'login' && method === 'POST') {
    const r = await adminLogin(req, String(body.password || '').slice(0, 128));
    if (r.error) return r.error;
    return reply({ ok: true }, 200, [planAdminCookie(makeToken('plan-admin', [r.admin.id, r.admin.session_version], PLAN_ADMIN_SESSION_S))]);
  }
  const me = await planAdmin(req);
  if (!me) return reply({ error: 'Yönetici oturumu gerekli.' }, 401);
  if (route === 'authorize' && method === 'POST') return reply({ ok: true });
  if (route === 'password' && method === 'POST') {
    const r = await changeAdminPassword(me, body.current, body.password, 6);
    if (r instanceof Reply) return r;
    return reply({ ok: true }, 200, [planAdminCookie(makeToken('plan-admin', [me.id, r.version], PLAN_ADMIN_SESSION_S))]);
  }
  if (route === 'maintenance') {
    if (method === 'GET') return reply(await portalSetting('maintenance', { enabled: false, message: '' }));
    if (method === 'POST') {
      if (typeof body.enabled !== 'boolean') return reply({ error: 'Geçersiz bakım ayarı.' }, 400);
      const m = { enabled: body.enabled, message: String(body.message || '').slice(0, 300) };
      await putPortalSetting('maintenance', m);
      await audit(me.id, 'portal_maintenance', { enabled: m.enabled });
      return reply(m);
    }
  }
  if (route === 'plans') {
    if (method === 'GET') {
      if (q.date) {
        if (!dateOK(q.date)) return reply({ error: 'Geçersiz tarih.' }, 400);
        const row = check(await db().from('mola_plans').select('data, filename, updated_at').eq('date', q.date).maybeSingle());
        return reply({ plan: row?.data ?? null, date: q.date, filename: row?.filename, updatedAt: row?.updated_at });
      }
      const { from, to } = q;
      if (!dateOK(from) || !dateOK(to) || from > to || Date.parse(to) - Date.parse(from) > 32 * 86400_000) return reply({ error: 'Geçersiz tarih aralığı.' }, 400);
      const rows = check(await db().from('mola_plans').select('date, data, filename, updated_at').gte('date', from).lte('date', to).order('date'));
      return reply({ days: rows.map((r) => ({ date: r.date, filename: r.filename, updatedAt: r.updated_at, count: r.data.employees.length })) });
    }
    if (method === 'POST') {
      if (!Array.isArray(body.days) || !body.days.length || body.days.length > 31) throw new HttpError(400, 'Tek seferde 1–31 günlük plan yükleyebilirsin.');
      const seen = new Set();
      const time = new Date().toISOString();
      const rows = body.days.map((x) => {
        if (!dateOK(x.date) || seen.has(x.date)) throw new HttpError(400, 'Her plan için farklı ve geçerli bir tarih seç.');
        seen.add(x.date);
        return { date: x.date, filename: String(x.filename || 'Plan').slice(0, 200), data: checkedPlan(x.plan), updated_at: time };
      });
      check(await db().from('mola_plans').upsert(rows));
      await audit(me.id, 'portal_plans', { days: rows.map((r) => r.date) });
      return reply({ ok: true, count: rows.length });
    }
    if (method === 'DELETE') {
      if (!dateOK(body.date)) throw new HttpError(400, 'Geçersiz tarih.');
      check(await db().from('mola_plans').delete().eq('date', body.date));
      await audit(me.id, 'portal_plan_delete', { date: body.date });
      return reply({ ok: true });
    }
  }
  return reply({ error: 'Bulunamadı.' }, 404);
}

// ---------------------------------------------------------------- hava durumu (Elazığ, MET Norway)
let forecast; let retryAt = 0;
async function weather() {
  const now = Date.now();
  if ((!forecast || now >= forecast.expires) && now >= retryAt) {
    try {
      const r = await fetch('https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=38.6744&lon=39.2228', {
        headers: { 'User-Agent': 'UzmanMolaPortal/1.0' }, signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error('weather');
      const series = (await r.json()).properties?.timeseries;
      if (!Array.isArray(series) || !series.length) throw new Error('weather');
      forecast = { series, expires: Math.max(now + 10800_000, Date.parse(r.headers.get('Expires')) || 0) };
    } catch { retryAt = Date.now() + 300_000; }
  }
  const list = forecast?.series || [];
  const entry = list.find((x) => { const s = Date.parse(x.time); return s <= now && now < s + 3600_000; })
    || list.find((x) => { const s = Date.parse(x.time); return s > now && s - now <= 3600_000; });
  const symbol = entry?.data?.next_1_hours?.summary?.symbol_code;
  if (!symbol) return reply({ condition: null }, 503);
  let condition = 'cloudy';
  if (symbol.includes('sleet')) condition = 'sleet';
  else if (symbol.includes('snow')) condition = 'snow';
  else if (symbol.includes('rain') || symbol.includes('thunder')) condition = 'rain';
  else if (/^(clearsky|fair)_/.test(symbol)) condition = 'clear';
  const wind = entry.data.instant?.details?.wind_speed;
  return reply({ condition, windy: Number.isFinite(wind) && wind >= 6 });
}

// ---------------------------------------------------------------- bakım modunda ana sayfa ve İkna Rehberi
const PAGES = { home: 'portal-pages/index.html', ikna: 'portal-pages/ikna.html' };
const escHtml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
async function page(req, res, name) {
  const m = await portalSetting('maintenance', { enabled: false });
  if (m?.enabled && !await planAdmin(req)) {
    res.statusCode = 503;
    res.setHeader('Retry-After', '300');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(`<!doctype html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Uzman · Bakım</title><link rel="stylesheet" href="/portal/logo-stars.css"><body style="margin:0;background:#f9f7f0;color:#13426f;font:18px Arial;display:grid;place-items:center;min-height:100vh"><main style="max-width:650px;padding:35px"><span class="logo-star-mark"><img src="/img/uzman-logo-transparent.png" width="180" alt="Uzman"><span class="logo-stars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span></span><p style="color:#0254a5;margin-top:60px;letter-spacing:3px;font-size:12px">BAKIM ÇALIŞMASI</p><h1 style="font-size:48px;font-weight:500">Birazdan yeniden.</h1><p style="line-height:1.6;color:#616c8a">${escHtml(m.message || 'Kısa bir süre sonra yeniden buradayız.')}</p><a href="/admin/" style="display:inline-block;color:#13426f;margin-top:30px">Yönetici girişi ↗</a></main></body></html>`);
    return;
  }
  const html = await fs.readFile(path.join(process.cwd(), PAGES[name]), 'utf8');
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(html);
}

// ---------------------------------------------------------------- giriş noktası
export default async function portal(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = { ...(req.query || {}) };
  const route = String(q.r || '').replace(/^\/+/, '');
  delete q.r;
  const method = req.method;
  try {
    if (route.startsWith('page/')) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Yöntem desteklenmiyor');
      const name = route.slice(5);
      if (!PAGES[name]) throw new HttpError(404, 'Bulunamadı');
      return await page(req, res, name);
    }

    // Değişiklik isteklerinde yalnızca aynı siteden gelen istekler (CSRF koruması)
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = req.headers.origin;
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      if (!origin || new URL(origin).host !== host) throw new HttpError(403, 'Geçersiz istek.');
    }
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch { body = null; } }
    if (method !== 'GET' && method !== 'HEAD' && (!body || typeof body !== 'object' || Array.isArray(body))) throw new HttpError(400, 'Geçersiz veri.');
    const isGet = method === 'GET';

    let out;
    if (route.startsWith('daily/')) {
      if (!isGet && method !== 'POST') throw new HttpError(405, 'Geçersiz yöntem.');
      out = await dailyRoute(req, route.slice(6), isGet, body, q);
    } else if (route === 'state' && isGet) out = await stateRoute(req);
    else if (route.startsWith('admin/')) out = await planAdminRoute(req, route.slice(6), method, body || {}, q);
    else if (route === 'weather' && isGet) out = await weather();
    else if (route.startsWith('kpi/')) out = reply({ error: 'KPI veritabanı bağlantısı henüz yapılandırılmadı.' }, 503);
    else out = reply({ error: 'Bulunamadı.' }, 404);

    if (route === 'weather' && out.status === 200) res.setHeader('Cache-Control', 'public, max-age=300');
    if (out.cookies.length) res.setHeader('Set-Cookie', out.cookies);
    res.status(out.status).json(out.body);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error('portal', route, err);
    if (!res.headersSent) res.status(status).json({ error: status >= 500 ? 'İşlem tamamlanamadı. Tekrar dene.' : err.message });
  }
}
