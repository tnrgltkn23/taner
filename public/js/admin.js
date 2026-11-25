import {
  requireSession, logout, unwrap, api, ITEMS, itemLabel, emptyTotals, rates, pct, rateHtml, istanbulToday, fmtShort,
  fmtLong, fmtTime, fmtDateTime, monthRange, esc, toast, modal, debounce, showEnvBadge, setLive, setupTabs,
} from './common.js';

const $ = (id) => document.getElementById(id);
const ctx = await requireSession('admin');
if (!ctx) await new Promise(() => {}); // yönlendirme sürerken dur
const { client, session } = ctx;

$('logout').addEventListener('click', logout);
showEnvBadge($('env'));

const adminApi = (action, body = {}) => api('/api/admin', { action, ...body }, { auth: true });
let tab = 'daily';
let users = [];
let settings = { postpre_target: 0.65, savedesk_target: 0.75, maintenance: false };
const T = () => ({ pp: Number(settings.postpre_target), sd: Number(settings.savedesk_target) });
const uname = (id) => users.find((u) => u.id === id)?.username || '—';

async function loadBase() {
  const [u, s] = await Promise.all([
    client.from('users').select('id, username, role, active, last_entry_at, created_at').eq('role', 'expert').order('username'),
    client.from('settings').select('*').eq('id', 1).single(),
  ]);
  users = unwrap(u);
  settings = unwrap(s);
  $('maint-badge').classList.toggle('hidden', !settings.maintenance);
  for (const sel of [$('d-user'), $('h-user')]) {
    const cur = sel.value;
    const list = sel === $('h-user') ? users : users.filter((x) => x.active);
    sel.innerHTML = '<option value="">Tümü</option>' + list.map((x) => `<option value="${x.id}">${esc(x.username)}${x.active ? '' : ' (silinmiş)'}</option>`).join('');
    sel.value = list.some((x) => x.id === cur) ? cur : '';
  }
}

const header = (first, extra = []) =>
  `<thead><tr>${first.map((h) => `<th class="left">${h}</th>`).join('')}${ITEMS.map((i) => `<th>${esc(i.label)}</th>`).join('')}<th>Post Pre %</th><th>Savedesk %</th>${extra.map((h) => `<th>${h}</th>`).join('')}</tr></thead>`;
const rateCells = (t) => { const r = rates(t); return `<td>${rateHtml(r.pp, T().pp)}</td><td>${rateHtml(r.sd, T().sd)}</td>`; };

async function editCount(userId, day, item, current) {
  const v = await modal({
    title: `${uname(userId)} · ${fmtShort(day)} · ${itemLabel(item)}`,
    message: 'Yeni adedi girin. Fark kadar "yönetici düzeltmesi" kaydı eklenir.',
    input: { type: 'number', value: current, inputmode: 'numeric' }, ok: 'Kaydet',
  });
  if (v === null || v === '' || Number(v) === current) return;
  try {
    await adminApi('set_count', { user_id: userId, day, item, value: Number(v) });
    toast('Adet güncellendi', 'success');
  } catch (e) { toast(e.message, 'error'); }
  refresh();
}

// ---------------------------------------------------------------- Günlük skor
$('d-user').addEventListener('change', () => renderDaily().catch((e) => toast(e.message, 'error')));
async function renderDaily() {
  const day = istanbulToday();
  const uid = $('d-user').value;
  $('d-title').textContent = `${fmtLong(day)} — bugüne ait skorlar`;

  if (!uid) {
    // Tümü: GSM yok, kullanıcı bazında toplam adet ve oranlar
    const rows = unwrap(await client.rpc('day_totals', { p_from: day, p_to: day, p_user: null }));
    const per = {};
    for (const r of rows) { (per[r.user_id] ||= emptyTotals())[r.item] += Number(r.total); }
    const ids = Object.keys(per).sort((a, b) => uname(a).localeCompare(uname(b), 'tr'));
    const all = emptyTotals();
    let body = '';
    for (const id of ids) {
      const t = per[id];
      ITEMS.forEach((i) => { all[i.code] += t[i.code]; });
      const u = users.find((x) => x.id === id);
      body += `<tr><td class="left"><b>${esc(uname(id))}</b></td><td class="left small muted">${u?.last_entry_at ? fmtTime(u.last_entry_at) : '—'}</td>${ITEMS.map((i) => `<td class="num">${t[i.code]}</td>`).join('')}${rateCells(t)}</tr>`;
    }
    if (!ids.length) body = '<tr><td colspan="10" class="empty">Bugün henüz veri girilmedi.</td></tr>';
    body += `<tr class="total"><td class="left">GENEL TOPLAM</td><td></td>${ITEMS.map((i) => `<td class="num">${all[i.code]}</td>`).join('')}${rateCells(all)}</tr>`;
    $('d-table').innerHTML = header(['Kullanıcı', 'Son veri']) + `<tbody>${body}</tbody>`;
    $('d-last').textContent = `${ids.length} kullanıcı veri girdi`;
    $('d-hint').textContent = 'Bir kullanıcı seçerek GSM bazında kayıtlarını görebilir ve düzeltme yapabilirsiniz.';
    return;
  }

  // Tek kullanıcı: her kayıt bir satır, altta genel toplam ve oranlar
  const rows = unwrap(await client.from('entries').select('id, item, gsm, delta, source, created_at')
    .eq('user_id', uid).eq('day', day).is('deleted_at', null).order('created_at'));
  const t = emptyTotals();
  let body = '';
  for (const r of rows) {
    t[r.item] += r.delta;
    const adj = r.source === 'admin';
    body += `<tr class="${adj ? 'adjust' : ''}"><td class="left num">${fmtTime(r.created_at)}</td><td class="left num">${adj ? 'Yönetici düzeltmesi' : esc(r.gsm || '(silindi)')}</td>
      ${ITEMS.map((i) => `<td class="num">${i.code === r.item ? (r.delta > 0 && adj ? '+' : '') + r.delta : ''}</td>`).join('')}<td></td><td></td>
      <td><button class="btn sm danger" data-del="${r.id}">Sil</button></td></tr>`;
  }
  if (!rows.length) body = '<tr><td colspan="11" class="empty">Bu kullanıcı bugün veri girmedi.</td></tr>';
  body += `<tr class="total"><td class="left" colspan="2">GENEL TOPLAM</td>${ITEMS.map((i) => `<td class="num editable" data-edit="${i.code}" data-val="${t[i.code]}" title="Düzeltmek için tıklayın">${t[i.code]}</td>`).join('')}${rateCells(t)}<td></td></tr>`;
  $('d-table').innerHTML = header(['Saat', 'Gsm No'], ['']) + `<tbody>${body}</tbody>`;
  const u = users.find((x) => x.id === uid);
  $('d-last').textContent = `Son veri: ${fmtDateTime(u?.last_entry_at)}`;
  $('d-hint').textContent = 'Toplam satırındaki bir adede tıklayarak GSM girmeden düzeltebilir, "Sil" ile tek bir kaydı kaldırabilirsiniz.';
}
$('d-table').addEventListener('click', async (ev) => {
  const del = ev.target.closest('[data-del]');
  const ed = ev.target.closest('[data-edit]');
  const uid = $('d-user').value;
  if (del) {
    if (!await modal({ title: 'Kaydı sil', message: 'Bu kayıt silinsin mi?', ok: 'Sil', danger: true })) return;
    try { await adminApi('delete_entry', { id: Number(del.dataset.del) }); toast('Kayıt silindi', 'success'); } catch (e) { toast(e.message, 'error'); }
    refresh();
  } else if (ed && uid) {
    editCount(uid, istanbulToday(), ed.dataset.edit, Number(ed.dataset.val));
  }
});

// ---------------------------------------------------------------- Geçmiş skorlar
$('h-month').value = istanbulToday().slice(0, 7);
['h-user', 'h-month'].forEach((id) => $(id).addEventListener('change', () => renderHistory().catch((e) => toast(e.message, 'error'))));
async function renderHistory() {
  const uid = $('h-user').value || null;
  const ym = $('h-month').value || istanbulToday().slice(0, 7);
  const { from, to, days } = monthRange(ym);
  const rows = unwrap(await client.rpc('day_totals', { p_from: from, p_to: to, p_user: uid }));
  const byDay = {};
  for (const r of rows) { (byDay[r.day] ||= emptyTotals())[r.item] += Number(r.total); }
  const today = istanbulToday();
  const all = emptyTotals();
  let body = '';
  for (const d of days) {
    const t = byDay[d] || emptyTotals();
    ITEMS.forEach((i) => { all[i.code] += t[i.code]; });
    const future = d > today;
    body += `<tr${future ? ' style="opacity:.4"' : ''}><td class="left num">${fmtShort(d)}</td>${ITEMS.map((i) =>
      `<td class="num${uid && !future ? ' editable' : ''}" ${uid && !future ? `data-day="${d}" data-item="${i.code}" data-val="${t[i.code]}"` : ''}>${t[i.code]}</td>`).join('')}${rateCells(t)}</tr>`;
  }
  body += `<tr class="total"><td class="left">TOPLAM</td>${ITEMS.map((i) => `<td class="num">${all[i.code]}</td>`).join('')}${rateCells(all)}</tr>`;
  $('h-table').innerHTML = header(['Tarih']) + `<tbody>${body}</tbody>`;
  $('h-hint').textContent = uid ? 'Bir adede tıklayarak düzeltebilirsiniz.' : 'Düzeltme yapmak için bir kullanıcı seçin.';
}
$('h-table').addEventListener('click', (ev) => {
  const c = ev.target.closest('[data-day]');
  const uid = $('h-user').value;
  if (c && uid) editCount(uid, c.dataset.day, c.dataset.item, Number(c.dataset.val));
});

// ---------------------------------------------------------------- Yönetici paneli
async function renderPanel() {
  $('tg-pp').value = Math.round(Number(settings.postpre_target) * 1000) / 10;
  $('tg-sd').value = Math.round(Number(settings.savedesk_target) * 1000) / 10;
  $('maint').checked = settings.maintenance;
  $('maint-text').textContent = settings.maintenance ? 'Açık — uzmanlar siteyi kullanamıyor' : 'Kapalı';
  const active = users.filter((u) => u.active);
  $('u-count').textContent = `${active.length} aktif kullanıcı`;
  $('u-table').innerHTML = `<thead><tr><th class="left">Kullanıcı adı</th><th>Son veri</th><th>Eklenme</th><th></th></tr></thead><tbody>${
    active.map((u) => `<tr><td class="left"><b>${esc(u.username)}</b></td><td class="small">${fmtDateTime(u.last_entry_at)}</td><td class="small muted">${fmtDateTime(u.created_at)}</td>
      <td class="row" style="justify-content:flex-end"><button class="btn sm" data-pw="${u.id}">Şifre değiştir</button><button class="btn sm danger" data-rm="${u.id}">Sil</button></td></tr>`).join('')
    || '<tr><td colspan="4" class="empty">Kullanıcı yok.</td></tr>'}</tbody>`;
  const audit = unwrap(await client.from('admin_audit').select('action, details, created_at').order('created_at', { ascending: false }).limit(50));
  const names = { admin_login: 'Yönetici girişi', create_user: 'Kullanıcı ekleme', delete_user: 'Kullanıcı silme', set_user_password: 'Kullanıcı şifresi', set_targets: 'Hedef kartı', set_maintenance: 'Bakım modu', change_own_password: 'Yönetici şifresi', set_count: 'Adet düzeltme', delete_entry: 'Kayıt silme' };
  const detail = (a) => {
    const d = a.details || {};
    if (a.action === 'set_count') return `${d.username} · ${fmtShort(d.day)} · ${itemLabel(d.item)} = ${d.value}`;
    if (a.action === 'set_targets') return `Post Pre ${pct(d.postpre)} · Savedesk ${pct(d.savedesk)}`;
    if (a.action === 'set_maintenance') return d.maintenance ? 'Açıldı' : 'Kapatıldı';
    if (a.action === 'delete_entry') return `${uname(d.user_id)} · ${itemLabel(d.item)}`;
    return d.username || '';
  };
  $('audit-table').innerHTML = `<tbody>${audit.map((a) => `<tr><td class="left small muted">${fmtDateTime(a.created_at)}</td><td class="left">${names[a.action] || esc(a.action)}</td><td class="left small">${esc(detail(a))}</td></tr>`).join('') || '<tr><td class="empty">Kayıt yok.</td></tr>'}</tbody>`;
}

$('targets-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try { await adminApi('set_targets', { postpre: Number($('tg-pp').value), savedesk: Number($('tg-sd').value) }); toast('Hedef kartı güncellendi', 'success'); } catch (e) { toast(e.message, 'error'); }
  refresh();
});
$('maint').addEventListener('change', async (ev) => {
  const on = ev.target.checked;
  if (!await modal({ title: on ? 'Bakım modunu aç' : 'Bakım modunu kapat', message: on ? 'Uzmanlar siteyi kullanamayacak. Devam edilsin mi?' : 'Uzmanlar siteyi yeniden kullanabilecek.', ok: on ? 'Aç' : 'Kapat', danger: on })) { ev.target.checked = !on; return; }
  try { await adminApi('set_maintenance', { on }); toast(on ? 'Bakım modu açıldı' : 'Bakım modu kapatıldı', 'success'); } catch (e) { toast(e.message, 'error'); ev.target.checked = !on; }
  refresh();
});
$('nu-name').addEventListener('input', (e) => { e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''); });
$('nu-pass').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 5); });
$('user-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await adminApi('create_user', { username: $('nu-name').value, password: $('nu-pass').value });
    toast(`${$('nu-name').value} eklendi`, 'success');
    ev.target.reset();
  } catch (e) { toast(e.message, 'error'); }
  refresh();
});
$('u-table').addEventListener('click', async (ev) => {
  const pw = ev.target.closest('[data-pw]');
  const rm = ev.target.closest('[data-rm]');
  try {
    if (pw) {
      const v = await modal({ title: `${uname(pw.dataset.pw)} — yeni şifre`, message: '5 haneli rakam girin. Kullanıcının açık oturumları kapatılır.', input: { type: 'text', inputmode: 'numeric', maxlength: 5 }, ok: 'Kaydet' });
      if (v === null) return;
      await adminApi('set_user_password', { id: pw.dataset.pw, password: v });
      toast('Şifre değiştirildi', 'success');
    } else if (rm) {
      if (!await modal({ title: 'Kullanıcıyı sil', message: `${uname(rm.dataset.rm)} silinsin mi? Giriş yapamaz; geçmiş verileri raporlarda kalır.`, ok: 'Sil', danger: true })) return;
      await adminApi('delete_user', { id: rm.dataset.rm });
      toast('Kullanıcı silindi', 'success');
    } else return;
  } catch (e) { toast(e.message, 'error'); }
  refresh();
});
$('pw-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if ($('pw-new').value !== $('pw-new2').value) return toast('Yeni şifreler eşleşmiyor', 'error');
  try { await adminApi('change_own_password', { current: $('pw-cur').value, next: $('pw-new').value }); ev.target.reset(); toast('Yönetici şifresi değiştirildi', 'success'); } catch (e) { toast(e.message, 'error'); }
});

// ---------------------------------------------------------------- Sekmeler ve senkronizasyon
const renderers = { daily: renderDaily, history: renderHistory, panel: renderPanel };
setupTabs($('nav'), (t) => { tab = t; refresh(); });

let running = false; let again = false;
async function refreshNow() {
  if (running) { again = true; return; }
  running = true;
  try {
    await loadBase();
    const typing = document.activeElement?.matches?.('#panel input, form input');
    if (!(tab === 'panel' && typing)) await renderers[tab]();
  } catch (e) { toast(e.message, 'error'); }
  finally { running = false; if (again) { again = false; refreshNow(); } }
}
const refresh = debounce(refreshNow, 250);

await client.realtime.setAuth(session.access_token);
client.channel('yonetici')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'entries' }, refresh)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, refresh)
  .subscribe((status) => { setLive($('live'), status); if (status === 'SUBSCRIBED') refresh(); });

let lastDay = istanbulToday();
setInterval(() => { if (istanbulToday() !== lastDay) { lastDay = istanbulToday(); refresh(); } }, 30_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

await refreshNow();
