import { api, getClient, showEnvBadge } from './common.js';

const $ = (id) => document.getElementById(id);
const msg = (t) => { $('msg').textContent = t || ''; };
showEnvBadge($('env'));
if (new URLSearchParams(location.search).get('e') === 'oturum') msg('Oturumunuz sonlandırıldı. Lütfen tekrar giriş yapın.');

// Açık oturum varsa ilgili sayfaya geç
(async () => {
  try {
    const client = await getClient();
    const { data } = await client.auth.getSession();
    if (!data.session) return;
    const { data: id } = await client.rpc('current_user_id');
    const { data: u } = id ? await client.from('users').select('role').eq('id', id).maybeSingle() : { data: null };
    if (u) return location.replace(u.role === 'admin' ? '/yonetici' : '/uzman');
    await client.auth.signOut({ scope: 'local' });
  } catch (e) { msg(e.message); }
})();

document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('active', x === b));
  const admin = b.dataset.mode === 'admin';
  $('user-form').classList.toggle('hidden', admin);
  $('admin-form').classList.toggle('hidden', !admin);
  msg('');
  (admin ? $('a-pass') : $('u-name')).focus();
}));

// Kullanıcı adı: küçük harf, Türkçe karakter yok
$('u-name').addEventListener('input', (e) => {
  const before = e.target.value;
  const clean = before.toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (clean !== before) {
    e.target.value = clean;
    msg(/[çğıöşüÇĞİÖŞÜ]/.test(before) ? 'Kullanıcı adında Türkçe karakter kullanılamaz' : '');
  }
});
$('u-pass').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 5); });

async function finish(session, role) {
  const client = await getClient();
  const { error } = await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  if (error) throw new Error(error.message);
  location.replace(role === 'admin' ? '/yonetici' : '/uzman');
}

$('user-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  msg('');
  if (!/^\d{5}$/.test($('u-pass').value)) return msg('Şifre 5 haneli rakam olmalıdır');
  $('u-submit').disabled = true;
  try {
    const r = await api('/api/login/user', { username: $('u-name').value, password: $('u-pass').value });
    await finish(r.session, 'expert');
  } catch (e) {
    msg(e.message);
    $('u-pass').value = '';
  } finally { $('u-submit').disabled = false; }
});

$('admin-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  msg('');
  $('a-submit').disabled = true;
  try {
    const r = await api('/api/login/admin', { password: $('a-pass').value });
    await finish(r.session, 'admin');
  } catch (e) {
    msg(e.message);
    $('a-pass').value = '';
  } finally { $('a-submit').disabled = false; }
});
