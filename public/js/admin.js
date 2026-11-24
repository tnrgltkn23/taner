import {
  requireSession, logout, unwrap, api, istanbulToday, fmtDay, fmtTime, fmtDateTime, esc, rate, rateHtml,
  barHtml, toast, debounce, showEnvBadge, setLive,
} from './common.js';

const $ = (id) => document.getElementById(id);
const ctx = await requireSession('admin');
if (!ctx) throw new Error('yönlendiriliyor');
const { client, profile, session } = ctx;

$('who').textContent = profile.display_name;
$('logout').addEventListener('click', logout);
showEnvBadge($('env'));

const adminApi = (action, body = {}) => api('/api/admin', { action, ...body }, { auth: true });
const S = { profiles: [], items: [], goals: [] };
let tab = 'live';

const experts = () => S.profiles.filter((p) => p.role === 'expert');
const pname = (id) => {
  const p = S.profiles.find((x) => x.id === id);
  return p ? `${p.display_name} (${p.username})` : '—';
};
const iname = (id) => S.items.find((i) => i.id === id)?.name || `#${id}`;
const goalOf = (scope, item, pid = null) => S.goals.find((g) => g.scope === scope && g.item_id === item && (g.profile_id || null) === pid);
const effTarget = (pid, item) => (goalOf('individual', item, pid) ?? goalOf('individual_default', item))?.daily_target ?? 0;

async function loadBase() {
  const [p, i, g] = await Promise.all([
    client.from('profiles').select('id, username, display_name, role, active, auth_user_id, created_at').order('display_name'),
    client.from('counter_items').select('*').order('sort_order').order('id'),
    client.from('goals').select('*'),
  ]);
  S.profiles = unwrap(p);
  S.items = unwrap(i);
  S.goals = unwrap(g);
}

// ---------------------------------------------------------------- Canlı durum
async function renderLive() {
  const day = istanbulToday();
  $('live-title').textContent = fmtDay(day);
  const [u, t] = await Promise.all([
    client.from('daily_user_totals').select('profile_id, item_id, total').eq('day', day),
    client.from('daily_team_totals').select('item_id, total').eq('day', day),
  ]);
  const ut = unwrap(u);
  const tt = unwrap(t);
  const items = S.items.filter((i) => i.active);
  const list = experts().filter((p) => p.active || ut.some((r) => r.profile_id === p.id && r.total));
  const val = (pid, item) => ut.find((r) => r.profile_id === pid && r.item_id === item)?.total ?? 0;

  if (!items.length) {
    $('live-table').innerHTML = '<tr><td class="empty">Önce "Kalemler ve Hedefler" sekmesinden sayaç kalemi ekleyin.</td></tr>';
    $('team-rate').textContent = '—';
    return;
  }
  const cell = (total, target) => {
    const r = rate(total, target);
    return `<td class="cell"><span class="num">${total}</span> <span class="muted small">/ ${target || '—'}</span> ${rateHtml(r)}<span class="sub">${barHtml(r)}</span></td>`;
  };
  let html = `<thead><tr><th>Uzman</th>${items.map((i) => `<th>${esc(i.name)}</th>`).join('')}<th>Toplam</th></tr></thead><tbody>`;
  for (const p of list) {
    let sT = 0; let sG = 0;
    const cells = items.map((i) => { const v = val(p.id, i.id); const g = effTarget(p.id, i.id); sT += v; sG += g; return cell(v, g); }).join('');
    html += `<tr><td>${esc(p.display_name)}<span class="sub muted small"> ${esc(p.username)}${p.active ? '' : ' · pasif'}</span></td>${cells}${cell(sT, sG)}</tr>`;
  }
  let tT = 0; let tG = 0;
  const teamCells = items.map((i) => {
    const v = tt.find((r) => r.item_id === i.id)?.total ?? 0;
    const g = goalOf('team', i.id)?.daily_target ?? 0;
    if (g > 0) { tT += v; tG += g; }
    return cell(v, g);
  }).join('');
  html += `<tr class="team-row"><td>EKİP</td>${teamCells}${cell(tT, tG)}</tr></tbody>`;
  if (!list.length) html = html.replace('<tbody>', '<tbody><tr><td colspan="99" class="empty">Henüz uzman yok.</td></tr>');
  $('live-table').innerHTML = html;
  const tr = rate(tT, tG);
  $('team-rate').innerHTML = tr === null ? '—' : rateHtml(tr);
}

// ---------------------------------------------------------------- Giriş onayları
async function loadRequestBadge() {
  const { count } = await client.from('device_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending')
    .gte('created_at', new Date(Date.now() - 10 * 60_000).toISOString());
  $('req-badge').textContent = count || 0;
  $('req-badge').classList.toggle('hidden', !count);
  document.title = count ? `(${count}) Yönetici Paneli` : 'Yönetici Paneli — Uzman Hedef Takip';
}

async function renderRequests() {
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const [pend, hist] = await Promise.all([
    client.from('device_requests').select('*').eq('status', 'pending').gte('created_at', since).order('created_at', { ascending: false }),
    client.from('device_requests').select('*').neq('status', 'pending').order('created_at', { ascending: false }).limit(30),
  ]);
  const pending = unwrap(pend);
  $('requests').innerHTML = pending.length
    ? pending.map((r) => `<div class="request">
        <div><div><b>${esc(pname(r.profile_id))}</b></div>
          <div class="small muted">${esc(r.device_label || 'Cihaz')} · IP ${esc(r.ip || '—')} · ${fmtTime(r.created_at)}</div></div>
        <div class="row"><span class="code">${esc(r.id.slice(0, 6).toUpperCase())}</span>
          <button class="btn success sm" data-approve="${r.id}">Onayla</button>
          <button class="btn danger sm" data-reject="${r.id}">Reddet</button></div>
      </div>`).join('')
    : '<div class="empty">Bekleyen istek yok.</div>';
  const statusPill = { approved: 'blue|Onaylandı', consumed: 'green|Giriş yapıldı', rejected: 'red|Reddedildi', expired: 'gray|Süresi doldu' };
  $('requests-history').innerHTML = `<thead><tr><th>Zaman</th><th>Uzman</th><th>Cihaz</th><th>IP</th><th>Durum</th></tr></thead><tbody>${
    unwrap(hist).map((r) => { const [c, t] = (statusPill[r.status] || 'gray|' + r.status).split('|');
      return `<tr><td>${fmtDateTime(r.created_at)}</td><td>${esc(pname(r.profile_id))}</td><td>${esc(r.device_label || '')}</td><td>${esc(r.ip || '')}</td><td><span class="pill ${c}">${t}</span></td></tr>`; }).join('')
    || '<tr><td colspan="5" class="empty">Kayıt yok.</td></tr>'}</tbody>`;
}
$('requests').addEventListener('click', async (ev) => {
  const a = ev.target.closest('[data-approve]'); const r = ev.target.closest('[data-reject]');
  if (!a && !r) return;
  ev.target.disabled = true;
  try {
    await adminApi(a ? 'approve_request' : 'reject_request', { id: (a || r).dataset[a ? 'approve' : 'reject'] });
    toast(a ? 'Giriş onaylandı' : 'İstek reddedildi', 'success');
  } catch (e) { toast(e.message, 'error'); }
  refreshAll();
});

// ---------------------------------------------------------------- Uzmanlar
function renderUsers() {
  const list = experts();
  $('users-table').innerHTML = `<thead><tr><th>Ad Soyad</th><th>Kullanıcı adı</th><th>Durum</th><th>Cihaz</th><th>Eklenme</th><th></th></tr></thead><tbody>${
    list.map((p) => `<tr>
      <td>${esc(p.display_name)}</td><td>${esc(p.username)}</td>
      <td>${p.active ? '<span class="pill green">Aktif</span>' : '<span class="pill gray">Pasif</span>'}</td>
      <td>${p.auth_user_id ? '<span class="pill blue">Giriş yapmış</span>' : '<span class="muted small">Henüz girmedi</span>'}</td>
      <td class="small muted">${fmtDateTime(p.created_at)}</td>
      <td style="text-align:right" class="row">
        <button class="btn sm" data-rename="${p.id}">Adı düzenle</button>
        <button class="btn sm" data-revoke="${p.id}">Oturumları kapat</button>
        <button class="btn sm ${p.active ? 'danger' : ''}" data-toggle="${p.id}" data-active="${p.active}">${p.active ? 'Pasif yap' : 'Aktif yap'}</button>
      </td></tr>`).join('') || '<tr><td colspan="6" class="empty">Henüz uzman eklenmedi.</td></tr>'}</tbody>`;
}
$('user-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await adminApi('create_user', { username: $('u-username').value, display_name: $('u-name').value });
    $('u-username').value = ''; $('u-name').value = '';
    toast('Uzman eklendi', 'success');
  } catch (e) { toast(e.message, 'error'); }
  refreshAll();
});
$('users-table').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  try {
    if (b.dataset.rename) {
      const p = S.profiles.find((x) => x.id === b.dataset.rename);
      const name = prompt('Yeni ad soyad:', p.display_name);
      if (!name) return;
      await adminApi('update_user', { id: p.id, display_name: name });
    } else if (b.dataset.revoke) {
      if (!confirm('Bu uzmanın tüm cihazlardaki oturumları kapatılsın mı? Tekrar girişte yeni onay gerekir.')) return;
      await adminApi('revoke_sessions', { id: b.dataset.revoke });
    } else if (b.dataset.toggle) {
      const makeActive = b.dataset.active !== 'true';
      if (!makeActive && !confirm('Uzman pasif yapılsın mı? Tüm oturumları kapanır.')) return;
      await adminApi('update_user', { id: b.dataset.toggle, active: makeActive });
    } else return;
    toast('Kaydedildi', 'success');
  } catch (e) { toast(e.message, 'error'); }
  refreshAll();
});

// ---------------------------------------------------------------- Kalemler ve hedefler
function renderGoals() {
  $('items-table').innerHTML = `<thead><tr><th>Kalem</th><th>Sıra</th><th>Durum</th><th></th></tr></thead><tbody>${
    S.items.map((i) => `<tr data-row="${i.id}">
      <td><input type="text" class="i-name" value="${esc(i.name)}" maxlength="60"></td>
      <td><input type="number" class="i-sort" value="${i.sort_order}" style="width:80px"></td>
      <td><label class="row small"><input type="checkbox" class="i-active" ${i.active ? 'checked' : ''}> Aktif</label></td>
      <td style="text-align:right"><button class="btn sm" data-save-item="${i.id}">Kaydet</button></td>
    </tr>`).join('') || '<tr><td colspan="4" class="empty">Kalem yok. Yukarıdan ekleyin.</td></tr>'}</tbody>`;

  const items = S.items.filter((i) => i.active);
  if (!items.length) { $('goals-table').innerHTML = '<tr><td class="empty">Önce aktif bir kalem ekleyin.</td></tr>'; return; }
  const input = (scope, item, pid, value, placeholder = '') =>
    `<input type="number" min="0" class="goal" data-scope="${scope}" data-item="${item}" data-profile="${pid || ''}" value="${value ?? ''}" placeholder="${placeholder}">`;
  let html = `<thead><tr><th>Hedef</th>${items.map((i) => `<th>${esc(i.name)}</th>`).join('')}</tr></thead><tbody>`;
  html += `<tr class="team-row"><td>Ekip günlük hedefi</td>${items.map((i) => `<td>${input('team', i.id, null, goalOf('team', i.id)?.daily_target)}</td>`).join('')}</tr>`;
  html += `<tr><td><b>Varsayılan uzman hedefi</b><div class="small muted">Özel hedefi olmayan herkes</div></td>${items.map((i) => `<td>${input('individual_default', i.id, null, goalOf('individual_default', i.id)?.daily_target)}</td>`).join('')}</tr>`;
  for (const p of experts().filter((x) => x.active)) {
    html += `<tr><td>${esc(p.display_name)}<div class="small muted">bireysel hedef</div></td>${items.map((i) => {
      const def = goalOf('individual_default', i.id)?.daily_target;
      return `<td>${input('individual', i.id, p.id, goalOf('individual', i.id, p.id)?.daily_target, def ?? '')}</td>`;
    }).join('')}</tr>`;
  }
  $('goals-table').innerHTML = html + '</tbody>';
}
$('item-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await adminApi('upsert_item', { name: $('i-name').value, sort_order: Number($('i-sort').value || 0) });
    $('i-name').value = '';
    toast('Kalem eklendi', 'success');
  } catch (e) { toast(e.message, 'error'); }
  refreshAll();
});
$('items-table').addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-save-item]'); if (!b) return;
  const tr = b.closest('tr');
  try {
    await adminApi('upsert_item', {
      id: Number(b.dataset.saveItem), name: tr.querySelector('.i-name').value,
      sort_order: Number(tr.querySelector('.i-sort').value || 0), active: tr.querySelector('.i-active').checked,
    });
    toast('Kalem kaydedildi', 'success');
  } catch (e) { toast(e.message, 'error'); }
  refreshAll();
});
$('goals-table').addEventListener('change', async (ev) => {
  const inp = ev.target.closest('input.goal'); if (!inp) return;
  const v = inp.value.trim();
  const body = { scope: inp.dataset.scope, item_id: Number(inp.dataset.item), profile_id: inp.dataset.profile || null, target: v === '' ? null : Number(v) };
  if (v === '' && body.scope !== 'individual') body.target = 0;
  inp.disabled = true;
  try { await adminApi('set_goal', body); toast('Hedef kaydedildi', 'success'); } catch (e) { toast(e.message, 'error'); }
  refreshAll();
});

// ---------------------------------------------------------------- İşlem geçmişi
$('ev-day').value = istanbulToday();
['ev-day', 'ev-user', 'ev-status'].forEach((id) => $(id).addEventListener('change', () => renderEvents().catch((e) => toast(e.message, 'error'))));
async function renderEvents() {
  const sel = $('ev-user');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Tüm uzmanlar</option>' + experts().map((p) => `<option value="${p.id}">${esc(p.display_name)}</option>`).join('');
  sel.value = cur;
  const day = $('ev-day').value || istanbulToday();
  let q = client.from('counter_events').select('*').eq('day', day).order('created_at', { ascending: false }).limit(500);
  if (sel.value) q = q.eq('profile_id', sel.value);
  if ($('ev-status').value === 'valid') q = q.is('undone_at', null);
  if ($('ev-status').value === 'undone') q = q.not('undone_at', 'is', null);
  const [ev, rep] = await Promise.all([q, client.from('daily_reports').select('day').eq('day', day).maybeSingle()]);
  const rows = unwrap(ev);
  const closed = Boolean(rep.data);
  $('events-table').innerHTML = `<thead><tr><th>Saat</th><th>Uzman</th><th>Kalem</th><th>Durum</th><th></th></tr></thead><tbody>${
    rows.map((e) => `<tr class="${e.undone_at ? 'undone' : ''}">
      <td class="num">${fmtTime(e.created_at)}</td><td>${esc(pname(e.profile_id))}</td><td>${esc(iname(e.item_id))}</td>
      <td class="no-strike">${e.undone_at ? `<span class="pill gray">Geri alındı</span> <span class="small muted">${fmtTime(e.undone_at)} · ${esc(pname(e.undone_by))}${e.undo_reason ? ' · ' + esc(e.undo_reason) : ''}</span>` : '<span class="pill green">Geçerli</span>'}</td>
      <td class="no-strike" style="text-align:right">${!e.undone_at && !closed ? `<button class="btn sm danger" data-undo="${e.id}">Geri al</button>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty">Bu gün için işlem yok.</td></tr>'}</tbody>`
    + (closed ? '<caption class="small muted" style="caption-side:bottom;padding:8px">Bu günün kapanışı yapıldığı için işlemler değiştirilemez.</caption>' : '');
}
$('events-table').addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-undo]'); if (!b) return;
  const reason = prompt('Geri alma nedeni (isteğe bağlı):', '');
  if (reason === null) return;
  try { await adminApi('undo_event', { event_id: Number(b.dataset.undo), reason }); toast('İşlem geri alındı', 'success'); } catch (e) { toast(e.message, 'error'); }
  refreshAll();
});

// ---------------------------------------------------------------- Kapanış raporları
let reports = [];
async function renderReports() {
  reports = unwrap(await client.from('daily_reports').select('*').order('day', { ascending: false }).limit(120));
  const closedBy = (s) => s === 'cron' ? 'Vercel Cron' : s === 'pg_cron' ? 'Veritabanı zamanlayıcı' : s === 'catchup' ? 'Otomatik telafi' : s.replace('admin:', 'Yönetici: ');
  $('reports-table').innerHTML = `<thead><tr><th>Gün</th><th>Geçerli işlem</th><th>Geri alınan</th><th>Ekip KPI</th><th>Kapanış</th><th></th></tr></thead><tbody>${
    reports.map((r) => {
      const team = r.summary.team || [];
      const withT = team.filter((t) => t.target > 0);
      const kr = rate(withT.reduce((s, t) => s + t.total, 0), withT.reduce((s, t) => s + t.target, 0));
      return `<tr><td>${fmtDay(r.day)}</td><td class="num">${r.summary.event_count ?? 0}</td><td class="num">${r.summary.undone_count ?? 0}</td>
        <td>${rateHtml(kr)}</td><td class="small muted">${fmtDateTime(r.closed_at)} · ${esc(closedBy(r.closed_by))}</td>
        <td style="text-align:right" class="row"><button class="btn sm" data-view="${r.day}">Görüntüle</button><button class="btn sm" data-csv="${r.day}">CSV</button></td></tr>`;
    }).join('') || '<tr><td colspan="6" class="empty">Henüz kapanış yok. İlk kapanış, ilk işlem gününden sonraki gece yapılır.</td></tr>'}</tbody>`;
}
function reportTable(r) {
  const s = r.summary;
  const items = s.items || [];
  const c = (x) => x ? `<td class="cell">${x.total} <span class="muted small">/ ${x.target || '—'}</span> ${rateHtml(x.rate ?? null)}</td>` : '<td>—</td>';
  let html = `<thead><tr><th>Uzman</th>${items.map((i) => `<th>${esc(i.name)}</th>`).join('')}<th>Toplam</th></tr></thead><tbody>`;
  for (const e of s.experts || []) {
    html += `<tr><td>${esc(e.display_name)}<span class="sub muted small"> ${esc(e.username)}</span></td>${items.map((i) => c((e.items || []).find((x) => x.item_id === i.id))).join('')}${c({ total: e.total, target: e.target, rate: rate(e.total, e.target) })}</tr>`;
  }
  const team = s.team || [];
  const wt = team.filter((t) => t.target > 0);
  html += `<tr class="team-row"><td>EKİP</td>${items.map((i) => c(team.find((x) => x.item_id === i.id))).join('')}${c({ total: wt.reduce((a, t) => a + t.total, 0), target: wt.reduce((a, t) => a + t.target, 0), rate: rate(wt.reduce((a, t) => a + t.total, 0), wt.reduce((a, t) => a + t.target, 0)) })}</tr></tbody>`;
  return html;
}
function downloadCsv(r) {
  const s = r.summary; const items = s.items || [];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Gün', 'Uzman', 'Kullanıcı adı', 'Kalem', 'Gerçekleşen', 'Hedef', 'Oran %'].map(q).join(';')];
  for (const e of s.experts || []) for (const i of items) {
    const x = (e.items || []).find((y) => y.item_id === i.id) || {};
    lines.push([r.day, e.display_name, e.username, i.name, x.total ?? 0, x.target ?? 0, x.rate ?? ''].map(q).join(';'));
  }
  for (const i of items) {
    const x = (s.team || []).find((y) => y.item_id === i.id) || {};
    lines.push([r.day, 'EKİP', '', i.name, x.total ?? 0, x.target ?? 0, x.rate ?? ''].map(q).join(';'));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `kapanis-${r.day}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('reports-table').addEventListener('click', (ev) => {
  const v = ev.target.closest('[data-view]'); const c = ev.target.closest('[data-csv]');
  const r = reports.find((x) => x.day === (v || c)?.dataset[v ? 'view' : 'csv']);
  if (!r) return;
  if (c) return downloadCsv(r);
  const box = $('report-detail');
  box.innerHTML = `<div class="card-head"><h2>${fmtDay(r.day)} kapanış raporu</h2><button class="btn sm" id="close-detail">Kapat</button></div><div class="table-wrap"><table>${reportTable(r)}</table></div>`;
  box.classList.remove('hidden');
  $('close-detail').onclick = () => box.classList.add('hidden');
  box.scrollIntoView({ behavior: 'smooth' });
});
$('catchup').addEventListener('click', async () => {
  try { const r = await adminApi('catch_up'); toast(`${r.result.closed_days} gün kapatıldı`, 'success'); } catch (e) { toast(e.message, 'error'); }
  refreshAll();
});

// ---------------------------------------------------------------- Hedef geçmişi
async function renderGoalHist() {
  const rows = unwrap(await client.from('goal_history').select('*').order('changed_at', { ascending: false }).limit(300));
  const scopeName = { team: 'Ekip', individual_default: 'Varsayılan uzman', individual: 'Bireysel' };
  $('goalhist-table').innerHTML = `<thead><tr><th>Zaman</th><th>Tür</th><th>Uzman</th><th>Kalem</th><th>Eski</th><th>Yeni</th><th>Değiştiren</th></tr></thead><tbody>${
    rows.map((h) => `<tr><td>${fmtDateTime(h.changed_at)}</td><td>${scopeName[h.scope] || h.scope}</td><td>${h.profile_id ? esc(pname(h.profile_id)) : '—'}</td>
      <td>${esc(iname(h.item_id))}</td><td class="num">${h.old_target ?? '—'}</td><td class="num">${h.new_target ?? '<span class="muted">kaldırıldı</span>'}</td><td>${esc(pname(h.changed_by))}</td></tr>`).join('')
    || '<tr><td colspan="7" class="empty">Kayıt yok.</td></tr>'}</tbody>`;
}

// ---------------------------------------------------------------- Yönetici kayıtları
const actionNames = {
  admin_login: 'Yönetici girişi', approve_request: 'Cihaz onayı', reject_request: 'Cihaz reddi', create_user: 'Uzman ekleme',
  update_user: 'Uzman güncelleme', revoke_sessions: 'Oturum kapatma', upsert_item: 'Kalem kaydı', set_goal: 'Hedef değişikliği',
  undo_event: 'İşlem geri alma', close_day: 'Elle kapanış', catch_up: 'Kapanış telafisi', change_password: 'Şifre değişikliği',
};
async function renderAudit() {
  const rows = unwrap(await client.from('admin_audit').select('*').order('created_at', { ascending: false }).limit(300));
  const detail = (d) => {
    const x = { ...d };
    if (x.profile_id) x.profile_id = pname(x.profile_id);
    if (x.item_id) x.item_id = iname(x.item_id);
    return Object.entries(x).map(([k, v]) => `${esc(k)}: ${esc(typeof v === 'object' ? JSON.stringify(v) : v)}`).join(' · ');
  };
  $('audit-table').innerHTML = `<thead><tr><th>Zaman</th><th>Yönetici</th><th>İşlem</th><th>Ayrıntı</th></tr></thead><tbody>${
    rows.map((a) => `<tr><td>${fmtDateTime(a.created_at)}</td><td>${esc(pname(a.admin_id))}</td><td>${actionNames[a.action] || esc(a.action)}</td><td class="small muted">${detail(a.details || {})}</td></tr>`).join('')
    || '<tr><td colspan="4" class="empty">Kayıt yok.</td></tr>'}</tbody>`;
}

// ---------------------------------------------------------------- Ayarlar
$('pw-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if ($('pw-next').value !== $('pw-next2').value) return toast('Yeni şifreler eşleşmiyor', 'error');
  try {
    await adminApi('change_password', { current: $('pw-current').value, next: $('pw-next').value });
    ev.target.reset();
    toast('Şifre değiştirildi', 'success');
  } catch (e) { toast(e.message, 'error'); }
});
async function renderHealth() {
  const res = await fetch('/api/health', { cache: 'no-store' });
  const h = await res.json();
  const label = { environment: 'Ortam', commit: 'Sürüm', database: 'Veritabanı', schema_ready: 'Şema kurulu', last_closed_day: 'Son kapanan gün', cron_secret_set: 'Cron anahtarı tanımlı', latency_ms: 'Gecikme (ms)', server_time_istanbul: 'Sunucu saati (İstanbul)' };
  $('health').innerHTML = `<table>${Object.entries(label).map(([k, l]) => `<tr><td class="muted">${l}</td><td>${esc(typeof h[k] === 'boolean' ? (h[k] ? 'Evet' : 'HAYIR') : h[k] ?? '—')}</td></tr>`).join('')}</table>`;
}
$('health-btn').addEventListener('click', () => renderHealth().catch((e) => toast(e.message, 'error')));

// ---------------------------------------------------------------- Sekmeler ve senkronizasyon
const renderers = {
  live: renderLive, requests: renderRequests, users: renderUsers, goals: renderGoals, events: renderEvents,
  reports: renderReports, goalhist: renderGoalHist, audit: renderAudit, settings: renderHealth,
};
$('nav').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-tab]'); if (!b) return;
  tab = b.dataset.tab;
  document.querySelectorAll('#nav button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab));
  Promise.resolve(renderers[tab]()).catch((e) => toast(e.message, 'error'));
});

let refreshing = false; let again = false;
async function refreshAll() {
  if (refreshing) { again = true; return; }
  refreshing = true;
  try {
    await loadBase();
    // Hedef tablosunda yazılırken tabloyu yeniden çizmeyelim
    const typing = tab === 'goals' && document.activeElement?.matches?.('#goals-table input, #items-table input');
    await Promise.all([loadRequestBadge(), typing ? null : renderers[tab]()]);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    refreshing = false;
    if (again) { again = false; refreshAll(); }
  }
}
const refreshSoon = debounce(refreshAll, 300);

await client.realtime.setAuth(session.access_token);
const ch = client.channel('yonetici');
for (const table of ['counter_events', 'daily_user_totals', 'daily_team_totals', 'goals', 'counter_items', 'device_requests', 'daily_reports', 'profiles']) {
  ch.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
    if (table === 'device_requests' && payload.eventType === 'INSERT') toast('Yeni cihaz giriş isteği', 'success');
    refreshSoon();
  });
}
ch.subscribe((status) => { setLive($('live'), status); if (status === 'SUBSCRIBED') refreshSoon(); });

let lastDay = istanbulToday();
setInterval(() => { if (istanbulToday() !== lastDay) { lastDay = istanbulToday(); $('ev-day').value = lastDay; refreshSoon(); } }, 30_000);
setInterval(loadRequestBadge, 60_000); // 10 dk'yı aşan istekler rozetten düşsün
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshSoon(); });

await refreshAll();
