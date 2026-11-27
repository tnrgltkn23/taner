// Ortak istemci yardımcıları. Tarayıcı yalnızca GİZLİ OLMAYAN anahtarı (publishable) bilir;
// tüm veri erişimi Supabase RLS politikalarıyla sınırlandırılır.
const STORAGE_KEY = 'uht2-auth';
let _cfg;
let _client;

export const ITEMS = [
  { code: 'pp_ikna', label: '484 İkna', group: 'pp' },
  { code: 'pp_gecis', label: '484 Geçiş', group: 'pp' },
  { code: 'pp_14271', label: '14271', group: 'pp' },
  { code: 'sd_ikna', label: '16234 İkna', group: 'sd' },
  { code: 'sd_iptal', label: '16234 İptal', group: 'sd' },
  { code: 'sd_17891', label: '17891', group: 'sd' },
];
export const itemLabel = (code) => ITEMS.find((i) => i.code === code)?.label || code;
export const emptyTotals = () => Object.fromEntries(ITEMS.map((i) => [i.code, 0]));

// Post Pre % = 484 İkna / (484 İkna + 484 Geçiş + 14271)
// Savedesk % = 16234 İkna / (16234 İkna + 16234 İptal + 17891)
export function rates(t) {
  const pd = t.pp_ikna + t.pp_gecis + t.pp_14271;
  const sd = t.sd_ikna + t.sd_iptal + t.sd_17891;
  return { pp: pd > 0 ? t.pp_ikna / pd : null, sd: sd > 0 ? t.sd_ikna / sd : null };
}
export const pct = (r) => (r === null || r === undefined ? '—' : `%${(Math.round(r * 1000) / 10).toLocaleString('tr-TR')}`);
export const rateClass = (r, target) => (r === null || r === undefined ? '' : r >= target ? 'ok' : 'low');
export const rateHtml = (r, target) => `<span class="rate ${rateClass(r, target)}">${pct(r)}</span>`;

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

export function unwrap({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

// ---- Tarih (Europe/Istanbul)
export function istanbulToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export const fmtShort = (d) => d.split('-').reverse().join('.');
export const fmtLong = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('tr-TR', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' });
export const fmtTime = (iso) => new Date(iso).toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days = Array.from({ length: last }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`);
  return { from: days[0], to: days[days.length - 1], days };
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---- Bildirim
export function toast(msg, type = '', { ms, action } = {}) {
  let box = document.getElementById('toast');
  if (!box) { box = document.createElement('div'); box.id = 'toast'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  const span = document.createElement('span');
  span.textContent = msg;
  t.appendChild(span);
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn sm';
    b.textContent = action.label;
    b.onclick = () => action.onClick(b, t);
    t.appendChild(b);
  }
  box.appendChild(t);
  const life = ms ?? (type === 'error' ? 5000 : 2500);
  if (life > 0) setTimeout(() => t.remove(), life);
  return t;
}

// ---- Modal (onay / değer girişi)
export function modal({ title, message = '', input = null, ok = 'Tamam', cancel = 'Vazgeç', danger = false }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <h3>${esc(title)}</h3>${message ? `<p>${esc(message)}</p>` : ''}
      ${input ? `<input type="${input.type || 'text'}" ${input.inputmode ? `inputmode="${input.inputmode}"` : ''} ${input.maxlength ? `maxlength="${input.maxlength}"` : ''} placeholder="${esc(input.placeholder || '')}" value="${esc(input.value ?? '')}">` : ''}
      <div class="actions"><button class="btn" data-x="0">${esc(cancel)}</button><button class="btn ${danger ? 'danger' : 'green'}" data-x="1">${esc(ok)}</button></div>
    </div>`;
    document.body.appendChild(back);
    const inp = back.querySelector('input');
    const done = (v) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') done(null); if (e.key === 'Enter') done(inp ? inp.value : true); };
    document.addEventListener('keydown', onKey);
    back.addEventListener('click', (e) => {
      const b = e.target.closest('[data-x]');
      if (b) done(b.dataset.x === '1' ? (inp ? inp.value : true) : null);
      else if (e.target === back) done(null);
    });
    (inp || back.querySelector('[data-x="1"]')).focus();
    if (inp) inp.select();
  });
}

// ---- Oturum
export async function requireSession(role) {
  const client = await getClient();
  const { data } = await client.auth.getSession();
  if (!data.session) { location.replace('/giris'); return null; }
  const { data: user, error } = await client.from('users')
    .select('id, username, role, active').eq('id', await myId(client)).maybeSingle();
  if (error || !user) {
    await client.auth.signOut({ scope: 'local' });
    location.replace('/giris?e=oturum');
    return null;
  }
  if (user.role !== role) { location.replace(user.role === 'admin' ? '/yonetici' : '/uzman'); return null; }
  client.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') location.replace('/giris'); });
  return { client, user, session: data.session };
}
async function myId(client) {
  const { data } = await client.rpc('current_user_id');
  return data || '00000000-0000-0000-0000-000000000000';
}

export async function logout() {
  const client = await getClient();
  await client.auth.signOut({ scope: 'local' });
  location.replace('/giris');
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
  el.querySelector('.txt').textContent = status === 'SUBSCRIBED' ? 'Canlı' : 'Bağlanıyor…';
}

export function setupTabs(nav, onChange) {
  nav.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-tab]');
    if (!b) return;
    nav.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== b.dataset.tab));
    onChange(b.dataset.tab);
  });
}
