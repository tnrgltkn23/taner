// Ortak istemci yardımcıları. Tarayıcı yalnızca GİZLİ OLMAYAN anahtarı (publishable) bilir;
// tüm veri erişimi Supabase RLS politikalarıyla sınırlandırılır.
const STORAGE_KEY = 'uht-auth';
let _cfg;
let _client;

export async function getConfig() {
  if (!_cfg) {
    const res = await fetch('/api/config', { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Yapılandırma alınamadı');
    _cfg = data;
  }
  return _cfg;
}

export async function getClient() {
  if (!_client) {
    const cfg = await getConfig();
    _client = window.supabase.createClient(cfg.supabaseUrl, cfg.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: STORAGE_KEY },
    });
  }
  return _client;
}

export async function api(path, body, { auth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const client = await getClient();
    const { data } = await client.auth.getSession();
    if (!data.session) throw new Error('Oturum süresi doldu, lütfen tekrar giriş yapın');
    headers.Authorization = `Bearer ${data.session.access_token}`;
  }
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `İstek başarısız (${res.status})`);
  return data;
}

// Supabase sorgu sonucunu açar, hatada istisna fırlatır
export function unwrap({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

export function istanbulToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const fmtTime = (iso) => new Date(iso).toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const fmtDateTime = (iso) => new Date(iso).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const fmtDay = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('tr-TR', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' });

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function rate(total, target) {
  return target > 0 ? Math.round((total * 1000) / target) / 10 : null;
}
export function rateClass(r) {
  if (r === null) return '';
  return r >= 100 ? 'ok' : r >= 70 ? 'warn' : 'low';
}
export function rateHtml(r) {
  return r === null ? '<span class="muted">—</span>' : `<span class="rate ${rateClass(r)}">%${r.toLocaleString('tr-TR')}</span>`;
}
export function barHtml(r) {
  const w = r === null ? 0 : Math.min(100, r);
  return `<div class="bar ${rateClass(r)}"><span style="width:${w}%"></span></div>`;
}

export function toast(msg, type = '') {
  let box = document.getElementById('toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), type === 'error' ? 5000 : 2500);
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Oturumu doğrular ve profili döndürür; yetkisizse giriş sayfasına yönlendirir
export async function requireSession(role) {
  const client = await getClient();
  const { data } = await client.auth.getSession();
  if (!data.session) { location.replace('/'); return null; }
  const { data: profile, error } = await client.from('profiles')
    .select('id, username, display_name, role, active')
    .eq('auth_user_id', data.session.user.id).maybeSingle();
  if (error || !profile) {
    await client.auth.signOut({ scope: 'local' });
    location.replace('/?e=oturum');
    return null;
  }
  if (profile.role !== role) {
    location.replace(profile.role === 'admin' ? '/yonetici' : '/uzman');
    return null;
  }
  // Oturum başka yerden sonlandırılırsa (yönetici iptal ederse) girişe dön
  client.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') location.replace('/');
  });
  return { client, profile, session: data.session };
}

export async function logout() {
  const client = await getClient();
  await client.auth.signOut({ scope: 'local' });
  location.replace('/');
}

export async function showEnvBadge(el) {
  try {
    const cfg = await getConfig();
    if (cfg.environment !== 'production') {
      el.textContent = cfg.environment === 'preview' ? 'TEST ORTAMI' : 'GELİŞTİRME';
      el.classList.remove('hidden');
    }
  } catch { /* yok say */ }
}

export function setLive(el, status) {
  el.classList.toggle('on', status === 'SUBSCRIBED');
  el.classList.toggle('off', status !== 'SUBSCRIBED');
  el.querySelector('.txt').textContent = status === 'SUBSCRIBED' ? 'Canlı' : 'Bağlanıyor…';
}
