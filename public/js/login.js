import { api, getClient, showEnvBadge } from './common.js';

const $ = (id) => document.getElementById(id);
const PENDING_KEY = 'uht-pending-request';
const msg = (t) => { $('msg').textContent = t || ''; };
let pollTimer = null;

showEnvBadge($('env'));
if (new URLSearchParams(location.search).get('e') === 'oturum') msg('Oturumunuz sonlandırıldı. Lütfen tekrar giriş yapın.');

// Zaten oturum varsa role göre yönlendir
(async () => {
  try {
    const client = await getClient();
    const { data } = await client.auth.getSession();
    if (data.session) {
      const { data: p } = await client.from('profiles').select('role').eq('auth_user_id', data.session.user.id).maybeSingle();
      if (p) return location.replace(p.role === 'admin' ? '/yonetici' : '/uzman');
      await client.auth.signOut({ scope: 'local' });
    }
    const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
    if (pending) startWaiting(pending);
  } catch (e) {
    msg(e.message);
  }
})();

// Sekmeler
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  const admin = b.dataset.tab === 'admin';
  $('admin-form').classList.toggle('hidden', !admin);
  const waiting = Boolean(sessionStorage.getItem(PENDING_KEY));
  $('expert-form').classList.toggle('hidden', admin || waiting);
  $('expert-wait').classList.toggle('hidden', admin || !waiting);
  msg('');
}));

function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Cihaz';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Tarayıcı';
  return `${os} · ${br}`;
}

async function finish(session, role) {
  const client = await getClient();
  const { error } = await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  if (error) throw new Error(error.message);
  location.replace(role === 'admin' ? '/yonetici' : '/uzman');
}

// ---- Uzman girişi ----
$('expert-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  msg('');
  $('ex-submit').disabled = true;
  try {
    const r = await api('/api/login/request', { username: $('ex-username').value, device_label: deviceLabel() });
    const pending = { request_id: r.request_id, secret: r.secret, started: Date.now() };
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    startWaiting(pending);
  } catch (e) {
    msg(e.message);
  } finally {
    $('ex-submit').disabled = false;
  }
});

function startWaiting(p) {
  $('expert-form').classList.add('hidden');
  $('expert-wait').classList.remove('hidden');
  $('wait-code').textContent = p.request_id.slice(0, 6).toUpperCase();
  clearInterval(pollTimer);
  const tick = async () => {
    if (Date.now() - p.started > 10 * 60_000) return stopWaiting('İsteğin süresi doldu. Lütfen tekrar deneyin.');
    try {
      const r = await api('/api/login/status', { request_id: p.request_id, secret: p.secret });
      if (r.status === 'approved') {
        clearInterval(pollTimer);
        sessionStorage.removeItem(PENDING_KEY);
        $('wait-text').textContent = 'Onaylandı, giriş yapılıyor…';
        await finish(r.session, 'expert');
      } else if (r.status === 'rejected') {
        stopWaiting('Giriş isteğiniz reddedildi.');
      } else if (r.status === 'expired' || r.status === 'consumed') {
        stopWaiting('İsteğin süresi doldu. Lütfen tekrar deneyin.');
      }
    } catch (e) {
      $('wait-text').textContent = `Bağlantı sorunu, yeniden deneniyor… (${e.message})`;
    }
  };
  tick();
  pollTimer = setInterval(tick, 3000);
}

function stopWaiting(text) {
  clearInterval(pollTimer);
  sessionStorage.removeItem(PENDING_KEY);
  $('expert-wait').classList.add('hidden');
  $('expert-form').classList.remove('hidden');
  msg(text);
}
$('wait-cancel').addEventListener('click', () => stopWaiting(''));

// ---- Yönetici girişi ----
$('admin-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  msg('');
  $('ad-submit').disabled = true;
  try {
    const r = await api('/api/login/admin', { username: $('ad-username').value, password: $('ad-password').value });
    $('ad-password').value = '';
    await finish(r.session, 'admin');
  } catch (e) {
    msg(e.message);
  } finally {
    $('ad-submit').disabled = false;
  }
});
