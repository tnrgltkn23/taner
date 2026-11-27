import {
  requireSession, logout, unwrap, api, ITEMS, itemLabel, emptyTotals, rates, pct, rateHtml, istanbulToday, fmtShort,
  fmtLong, fmtTime, fmtDateTime, monthRange, esc, toast, modal, debounce, showEnvBadge, setLive, setupTabs,
} from './common.js';

const $ = (id) => document.getElementById(id);
const ctx = await requireSession('admin');
if (!ctx) await new Promise(() => {}); // yönlendirme sürerken dur
const { client, session, user: me } = ctx;

$('logout').addEventListener('click', logout);
showEnvBadge($('env'));

const adminApi = (action, body = {}) => api('/api/admin', { action, ...body }, { auth: true });
let tab = 'home';
let users = [];
let teams = [];
let isSuper = false;
let settings = { postpre_target: 0.65, savedesk_target: 0.75, maintenance: false };
const T = () => ({ pp: Number(settings.postpre_target), sd: Number(settings.savedesk_target) });
const uname = (id) => users.find((u) => u.id === id)?.username || '—';
const teamName = (id) => teams.find((t) => t.id === id)?.name || '';
const NO_TEAM = 'none';

// Toplam İkna ve Total Take Rate
const iknaOf = (t) => t.pp_ikna + t.sd_ikna;
const totalRate = (t) => { const all = ITEMS.reduce((s, i) => s + t[i.code], 0); return all > 0 ? iknaOf(t) / all : null; };

function fillSelect(sel, options, fallback = '') {
  const cur = sel.value;
  sel.innerHTML = options.map((o) => `<option value="${esc(o.v)}">${esc(o.l)}</option>`).join('');
  sel.value = options.some((o) => o.v === cur) ? cur : fallback;
}
const teamFilter = (teamSel) => (u) => !teamSel || (teamSel === NO_TEAM ? !u.team_leader_id : u.team_leader_id === teamSel);

function fillUserSelects() {
  const active = users.filter((x) => x.active);
  const teamOpts = [{ v: '', l: 'Tümü' }, ...teams.map((t) => ({ v: t.id, l: t.name }))];
  if (active.some((u) => !u.team_leader_id)) teamOpts.push({ v: NO_TEAM, l: '(Takımı yok)' });
  fillSelect($('d-team'), teamOpts);
  fillSelect($('q-team'), teamOpts);
  const dList = active.filter(teamFilter($('d-team').value));
  fillSelect($('d-user'), [{ v: '', l: 'Tümü' }, ...dList.map((x) => ({ v: x.id, l: x.username }))]);
  fillSelect($('h-user'), [{ v: '', l: 'Tümü' }, ...users.map((x) => ({ v: x.id, l: x.username + (x.active ? '' : ' (silinmiş)') }))]);
  fillSelect($('nu-team'), [{ v: '', l: '— Takım lideri —' }, ...teams.map((t) => ({ v: t.id, l: t.name }))]);
}

let firstLoad = true;
async function loadBase() {
  const [u, s, t, m] = await Promise.all([
    client.from('users').select('id, username, role, active, last_entry_at, created_at, team_leader_id').eq('role', 'expert').order('username'),
    client.from('settings').select('*').eq('id', 1).single(),
    client.from('team_leaders').select('id, name').order('name'),
    firstLoad ? client.from('users').select('is_super').eq('id', me.id).single() : Promise.resolve(null),
  ]);
  users = unwrap(u);
  settings = unwrap(s);
  teams = unwrap(t);
  if (m) { isSuper = Boolean(unwrap(m)?.is_super); $('tab-logins').classList.toggle('hidden', !isSuper); }
  firstLoad = false;
  $('maint-badge').classList.toggle('hidden', !settings.maintenance);
  fillUserSelects();
}

// Geçmiş skorlar tablosu başlığı ve oran hücreleri
const header = (first, extra = []) =>
  `<thead><tr>${first.map((h) => `<th class="left">${h}</th>`).join('')}${ITEMS.map((i) => `<th>${esc(i.label)}</th>`).join('')}<th>Post Pre %</th><th>Savedesk %</th>${extra.map((h) => `<th>${h}</th>`).join('')}</tr></thead>`;
const rateCells = (t) => { const r = rates(t); return `<td>${rateHtml(r.pp, T().pp)}</td><td>${rateHtml(r.sd, T().sd)}</td>`; };
const totalCells = (t) => `<td class="num"><b>${iknaOf(t)}</b></td><td><span class="rate">${pct(totalRate(t))}</span></td>`;

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

// ---------------------------------------------------------------- Ana sayfa
// Genel oran + takım lideri bazında oranlar. Dönem: bugün veya bu ay (1'inden bugüne).
// Oranlar önceki ayın tamamıyla, İkna adedi karşılaştırılabilir dönemle kıyaslanır:
// "Bu ay" → önceki ayın aynı günleri, "Bugün" → önceki ayın günlük ortalaması (veri girilen günler).
let period = 'month';
$('k-period').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-p]');
  if (!b || b.dataset.p === period) return;
  period = b.dataset.p;
  $('k-period').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
  renderHome().catch((e) => toast(e.message, 'error'));
});

const sumRows = (rows, keep = () => true) => {
  const t = emptyTotals();
  for (const r of rows) if (keep(r) && r.item in t) t[r.item] += Number(r.total);
  return t;
};
const fmt1 = (n) => Math.abs(n).toLocaleString('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const monthName = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('tr-TR', { month: 'long', timeZone: 'UTC' }); };
const prevYm = (ym) => { const [y, m] = ym.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };

const pointDelta = (cur, ref, pName) => {
  if (cur === null) return { cls: '', text: '' };
  if (ref === null) return { cls: '', text: `vs ${pName}: veri yok` };
  const d = (cur - ref) * 100;
  return { cls: d >= 0 ? 'up' : 'down', text: `${d >= 0 ? '▲ +' : '▼ −'}${fmt1(d)} puan vs ${pName}` };
};

// Bir grup (genel veya takım) için 4 kartın HTML'i
function kpiCards(curRows, prevRows, c) {
  const cur = sumRows(curRows);
  const prevAll = sumRows(prevRows);
  const r = rates(cur);
  const pr = rates(prevAll);
  const cls = (rate, target) => (rate === null ? '' : rate >= target ? 'ok' : 'low');

  const ikna = iknaOf(cur);
  let ref = null; let refLabel = '';
  if (period === 'month') {
    ref = iknaOf(sumRows(prevRows, (x) => x.day <= c.lastPrevDay));
    refLabel = `${c.pName} 1–${Number(c.lastPrevDay.slice(8))}`;
  } else {
    const days = new Set(prevRows.map((x) => x.day)).size;
    if (days) { ref = iknaOf(prevAll) / days; refLabel = `${c.pName} günlük ort. (${Math.round(ref).toLocaleString('tr-TR')})`; }
  }
  let iknaDelta = { cls: '', text: `vs ${c.pName}: veri yok` };
  if (ref) {
    const p = ((ikna - ref) / ref) * 100;
    iknaDelta = { cls: p >= 0 ? 'up' : 'down', text: `${p >= 0 ? '▲ +' : '▼ −'}${fmt1(p)}% vs ${refLabel}` };
  }

  const cards = [
    { lbl: 'Post Pre Take Rate', val: pct(r.pp), cls: cls(r.pp, c.tpp), d: pointDelta(r.pp, pr.pp, c.pName), hint: '484 İkna / (484 İkna + 484 Geçiş + 14271)' },
    { lbl: 'Savedesk Take Rate', val: pct(r.sd), cls: cls(r.sd, c.tsd), d: pointDelta(r.sd, pr.sd, c.pName), hint: '16234 İkna / (16234 İkna + 16234 İptal + 17891)' },
    { lbl: 'Toplam İkna', val: ikna.toLocaleString('tr-TR'), cls: '', d: iknaDelta, hint: '484 İkna + 16234 İkna' },
    { lbl: 'Total Take Rate', val: pct(totalRate(cur)), cls: '', d: pointDelta(totalRate(cur), totalRate(prevAll), c.pName), hint: 'Tüm İkna / tüm 6 kalem' },
  ];
  return { r, html: `<div class="kpis">${cards.map((k) => `<div class="kpi ${k.cls}"><span class="lbl">${k.lbl}</span><span class="val">${k.val}</span><span class="delta ${k.d.cls}">${esc(k.d.text)}</span><span class="hint">${k.hint}</span></div>`).join('')}</div>` };
}

async function renderHome() {
  const today = istanbulToday();
  const ym = today.slice(0, 7);
  const pym = prevYm(ym);
  const prev = monthRange(pym);
  const pName = monthName(pym);
  const from = period === 'month' ? `${ym}-01` : today;
  const dayNum = Number(today.slice(8));

  const [curRows, prevRows] = await Promise.all([
    client.rpc('period_totals_by_team', { p_from: from, p_to: today, p_by_day: false }).then(unwrap),
    client.rpc('period_totals_by_team', { p_from: prev.from, p_to: prev.to, p_by_day: true }).then(unwrap),
  ]);
  const { pp: tpp, sd: tsd } = T();
  const c = { pName, tpp, tsd, lastPrevDay: `${pym}-${String(Math.min(dayNum, prev.days.length)).padStart(2, '0')}` };

  $('k-title').textContent = period === 'month' ? `Bu ay — ${monthName(ym)} ${ym.slice(0, 4)}` : `Bugün — ${fmtLong(today)}`;
  $('k-sub').textContent = `${period === 'month' ? `1–${dayNum} ${monthName(ym)}` : fmtShort(today)} · Kıyas: ${pName}`;

  // Genel oran (tüm takımlar + takımı olmayanlar)
  const general = kpiCards(curRows, prevRows, c);
  $('k-general').innerHTML = general.html;

  // Hedef kartı: genel oranın hedefe uzaklığı
  $('k-tpp').textContent = pct(tpp);
  $('k-tsd').textContent = pct(tsd);
  for (const [el, rate, target] of [[$('k-tpp-d'), general.r.pp, tpp], [$('k-tsd-d'), general.r.sd, tsd]]) {
    el.className = 'delta';
    if (rate === null) { el.textContent = 'Henüz veri yok'; continue; }
    const d = (rate - target) * 100;
    el.classList.add(d >= 0 ? 'up' : 'down');
    el.textContent = d >= 0 ? `▲ +${fmt1(d)} puan hedefin üstünde` : `▼ ${fmt1(d)} puan hedefin altında`;
  }

  // Takım lideri bazlı
  const groups = teams.map((t) => ({ id: t.id, name: t.name }));
  if ([...curRows, ...prevRows].some((x) => !x.team_leader_id)) groups.push({ id: null, name: 'Takımı atanmamış' });
  $('k-teams').innerHTML = groups.map((g) => {
    const n = users.filter((u) => u.active && (u.team_leader_id || null) === g.id).length;
    const k = kpiCards(curRows.filter((x) => (x.team_leader_id || null) === g.id), prevRows.filter((x) => (x.team_leader_id || null) === g.id), c);
    return `<h2 class="section-title">${g.id ? 'Takım Lideri: ' : ''}${esc(g.name)} <span class="muted small">${n} kullanıcı</span></h2>${k.html}`;
  }).join('');
}

// ---------------------------------------------------------------- Günlük skor
// Takım lideri seçilince kullanıcı listesi o takımla sınırlanır. "Tümü"de başlıklara
// tıklayarak sıralanır; bugün son veri giren 5 kullanıcı yeşilden sarıya renklenir.
$('d-team').addEventListener('change', () => { fillUserSelects(); renderDaily().catch((e) => toast(e.message, 'error')); });
$('d-user').addEventListener('change', () => renderDaily().catch((e) => toast(e.message, 'error')));
let dSort = { key: 'name', dir: 1 };
const COLS = [
  ...ITEMS.map((i) => ({ key: i.code, label: i.label })),
  { key: 'pp', label: 'Post Pre %' }, { key: 'sd', label: 'Savedesk %' },
  { key: 'ikna', label: 'Total İkna' }, { key: 'tr', label: 'Total Take Rate' },
];
const sortVal = (row, key) => {
  if (key === 'name') return row.name;
  if (key === 'last') return row.last || '';
  if (key === 'pp') return row.r.pp ?? -1;
  if (key === 'sd') return row.r.sd ?? -1;
  if (key === 'ikna') return iknaOf(row.t);
  if (key === 'tr') return totalRate(row.t) ?? -1;
  return row.t[key];
};
const sortTh = (key, label, left = false) => {
  const on = dSort.key === key;
  return `<th class="sortable${left ? ' left' : ''}${on ? ' sorted' : ''}" data-sort="${key}" title="Sıralamak için tıklayın">${esc(label)}${on ? (dSort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
};

async function renderDaily() {
  const day = istanbulToday();
  const uid = $('d-user').value;
  const teamSel = $('d-team').value;
  $('d-title').textContent = `${fmtLong(day)} — bugüne ait skorlar`;

  if (!uid) {
    // Tümü: GSM yok, kullanıcı bazında toplam adet ve oranlar
    const inTeam = new Set(users.filter(teamFilter(teamSel)).map((u) => u.id));
    const rows = unwrap(await client.rpc('day_totals', { p_from: day, p_to: day, p_user: null }));
    const per = {};
    for (const r of rows) if (inTeam.has(r.user_id)) (per[r.user_id] ||= emptyTotals())[r.item] += Number(r.total);
    const list = Object.keys(per).map((id) => {
      const u = users.find((x) => x.id === id);
      return { id, name: uname(id), last: u?.last_entry_at || null, t: per[id], r: rates(per[id]) };
    });
    list.sort((a, b) => {
      const x = sortVal(a, dSort.key); const y = sortVal(b, dSort.key);
      const c = typeof x === 'string' ? x.localeCompare(y, 'tr') : x - y;
      return c * dSort.dir || a.name.localeCompare(b.name, 'tr');
    });

    // Bugün en son veri giren 5 kullanıcı: en yeni yeşil → 5. sarı
    const recent = list.filter((x) => x.last && new Date(x.last).toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' }) === day)
      .sort((a, b) => b.last.localeCompare(a.last)).slice(0, 5);
    const rank = new Map(recent.map((x, i) => [x.id, i]));

    const all = emptyTotals();
    let body = '';
    for (const x of list) {
      ITEMS.forEach((i) => { all[i.code] += x.t[i.code]; });
      const hl = rank.has(x.id) ? ` hl hl-${rank.get(x.id)}` : '';
      body += `<tr><td class="left${hl}"><b>${esc(x.name)}</b>${rank.has(x.id) ? ` <span class="small muted">#${rank.get(x.id) + 1}</span>` : ''}</td><td class="left small${hl}">${x.last ? fmtTime(x.last) : '—'}</td>${ITEMS.map((i) => `<td class="num">${x.t[i.code]}</td>`).join('')}${rateCells(x.t)}${totalCells(x.t)}</tr>`;
    }
    if (!list.length) body = `<tr><td colspan="12" class="empty">Bugün ${teamSel ? 'bu takımda ' : ''}henüz veri girilmedi.</td></tr>`;
    body += `<tr class="total"><td class="left">GENEL TOPLAM</td><td></td>${ITEMS.map((i) => `<td class="num">${all[i.code]}</td>`).join('')}${rateCells(all)}${totalCells(all)}</tr>`;
    $('d-table').innerHTML = `<thead><tr>${sortTh('name', 'Kullanıcı', true)}${sortTh('last', 'Son veri', true)}${COLS.map((cl) => sortTh(cl.key, cl.label)).join('')}</tr></thead><tbody>${body}</tbody>`;
    $('d-last').textContent = `${list.length} kullanıcı veri girdi`;
    $('d-hint').innerHTML = 'Başlıklara tıklayarak sıralayabilirsiniz. Bugün en son veri giren 5 kullanıcı <span class="hl hl-0" style="padding:1px 6px;border-radius:4px">yeşilden</span> <span class="hl hl-4" style="padding:1px 6px;border-radius:4px">sarıya</span> renklenir. Bir kullanıcı seçerek GSM bazında kayıtlarını görebilirsiniz.';
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
      ${ITEMS.map((i) => `<td class="num">${i.code === r.item ? (r.delta > 0 && adj ? '+' : '') + r.delta : ''}</td>`).join('')}<td></td><td></td><td></td><td></td>
      <td><button class="btn sm danger" data-del="${r.id}">Sil</button></td></tr>`;
  }
  if (!rows.length) body = '<tr><td colspan="13" class="empty">Bu kullanıcı bugün veri girmedi.</td></tr>';
  body += `<tr class="total"><td class="left" colspan="2">GENEL TOPLAM</td>${ITEMS.map((i) => `<td class="num editable" data-edit="${i.code}" data-val="${t[i.code]}" title="Düzeltmek için tıklayın">${t[i.code]}</td>`).join('')}${rateCells(t)}${totalCells(t)}<td></td></tr>`;
  $('d-table').innerHTML = `<thead><tr><th class="left">Saat</th><th class="left">Gsm No</th>${COLS.map((cl) => `<th>${esc(cl.label)}</th>`).join('')}<th></th></tr></thead><tbody>${body}</tbody>`;
  const u = users.find((x) => x.id === uid);
  $('d-last').textContent = `Son veri: ${fmtDateTime(u?.last_entry_at)}`;
  $('d-hint').textContent = 'Toplam satırındaki bir adede tıklayarak GSM girmeden düzeltebilir, "Sil" ile tek bir kaydı kaldırabilirsiniz.';
}
$('d-table').addEventListener('click', async (ev) => {
  const th = ev.target.closest('th[data-sort]');
  if (th) {
    const key = th.dataset.sort;
    dSort = dSort.key === key ? { key, dir: -dSort.dir } : { key, dir: key === 'name' || key === 'last' ? 1 : -1 };
    renderDaily().catch((e) => toast(e.message, 'error'));
    return;
  }
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
  // Kullanıcılar birleştirilmiş günlük toplamlar (Tümü'de 1000 satır sınırına takılmaz)
  const rows = unwrap(await client.rpc('period_totals', { p_from: from, p_to: to, p_user: uid, p_by_day: true }));
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

// ---------------------------------------------------------------- Resmi rapor karşılaştırması
let rPeriod = 'day';
let rSort = { key: 'uyum', dir: 1 };
let rDefaultSet = false;
$('r-period').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-p]');
  if (!b || b.dataset.p === rPeriod) return;
  rPeriod = b.dataset.p;
  $('r-period').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
  $('r-day').classList.toggle('hidden', rPeriod !== 'day');
  $('r-month').classList.toggle('hidden', rPeriod !== 'month');
  renderReport().catch((e) => toast(e.message, 'error'));
});
['r-day', 'r-month', 'r-team'].forEach((id) => $(id).addEventListener('change', () => renderReport().catch((e) => toast(e.message, 'error'))));

$('r-upload').addEventListener('click', async () => {
  const file = $('r-file').files[0];
  if (!file) return toast('Önce rapor dosyasını seçin', 'error');
  const btn = $('r-upload');
  btn.disabled = true;
  try {
    $('r-status').textContent = 'Dosya okunuyor…';
    const { parseChurnReport } = await import('./report.js');
    const { rows, days } = await parseChurnReport(file);
    if (!rows.length) throw new Error('Raporda 484/16234/14271/17891 kaydı bulunamadı');
    $('r-status').textContent = `${days.length} gün, ${rows.length} satır gönderiliyor…`;
    const { result } = await adminApi('upload_official', { filename: file.name, rows });
    $('r-status').textContent = '';
    toast(`Resmi rapor yüklendi: ${fmtShort(result.day_from)}–${fmtShort(result.day_to)}, ${result.matched} uzman eşleşti`, 'success');
    $('r-day').value = result.day_to; $('r-month').value = result.day_to.slice(0, 7);
    $('r-file').value = '';
    await renderReport();
  } catch (e) { $('r-status').textContent = ''; toast(e.message, 'error'); }
  finally { btn.disabled = false; }
});

const R_COLS = [
  ...ITEMS.map((i) => ({ key: i.code, label: i.label })),
  { key: 'pp', label: 'Post Pre %' }, { key: 'sd', label: 'Savedesk %' }, { key: 'uyum', label: 'Uyum' },
];
const ptDiff = (a, b) => (a === null || b === null ? '' : `${a - b >= 0 ? '+' : '−'}${fmt1((a - b) * 100)}`);

async function renderReport() {
  const { agreement, flags } = await import('./report.js');
  if (!rDefaultSet) {
    rDefaultSet = true;
    const last = unwrap(await client.from('official_uploads').select('filename, day_to, uploaded_at').order('uploaded_at', { ascending: false }).limit(1));
    const d = last[0]?.day_to || istanbulToday();
    $('r-day').value = d; $('r-month').value = d.slice(0, 7);
    $('r-last').textContent = last[0] ? `Son yükleme: ${last[0].filename} · ${fmtDateTime(last[0].uploaded_at)}` : 'Henüz rapor yüklenmedi';
  }
  fillSelect($('r-team'), [{ v: '', l: 'Tümü' }, ...teams.map((t) => ({ v: t.id, l: t.name })), { v: NO_TEAM, l: '(Takımı yok)' }]);
  let from; let to;
  if (rPeriod === 'day') { from = to = $('r-day').value || istanbulToday(); } else { ({ from, to } = monthRange($('r-month').value || istanbulToday().slice(0, 7))); }

  const rows = unwrap(await client.rpc('report_compare', { p_from: from, p_to: to }));
  const days = rows[0]?.days_count ?? 0;
  $('r-sub').textContent = days ? `${rPeriod === 'day' ? fmtLong(from) : `${fmtShort(from)}–${fmtShort(to)}`} · resmi raporu olan ${days} gün karşılaştırıldı` : 'Bu dönem için resmi rapor yüklenmemiş';
  const keep = teamFilter($('r-team').value);
  const per = new Map();
  for (const r of rows) {
    const u = users.find((x) => x.id === r.user_id);
    if (!u || !keep(u)) continue;
    const p = per.get(r.user_id) || { u, site: emptyTotals(), off: emptyTotals() };
    p.site[r.item] += Number(r.site_total); p.off[r.item] += Number(r.official_total);
    per.set(r.user_id, p);
  }
  const list = [...per.values()].map((p) => ({ ...p, rs: rates(p.site), ro: rates(p.off), uyum: agreement(p.site, p.off), fl: flags(p.site, p.off) }));
  rLast = { list, from, to, days, team: $('r-team').value };

  // Özet kartları
  const S = emptyTotals(); const O = emptyTotals();
  for (const p of list) ITEMS.forEach((i) => { S[i.code] += p.site[i.code]; O[i.code] += p.off[i.code]; });
  const rs = rates(S); const ro = rates(O);
  const sumUyum = agreement(S, O);
  const card = (lbl, siteVal, offVal, diff, hint, cls = '') => `<div class="kpi ${cls}"><span class="lbl">${lbl}</span><span class="val" style="font-size:28px">${siteVal} <span class="muted" style="font-size:18px">/ ${offVal}</span></span><span class="delta ${diff.startsWith('+') ? 'down' : diff ? 'up' : ''}">${diff ? `${diff} puan site − resmi` : ''}</span><span class="hint">${hint}</span></div>`;
  $('r-kpis').innerHTML = days ? [
    card('Post Pre %', pct(rs.pp), pct(ro.pp), ptDiff(rs.pp, ro.pp), 'site / resmi'),
    card('Savedesk %', pct(rs.sd), pct(ro.sd), ptDiff(rs.sd, ro.sd), 'site / resmi'),
    card('Olumsuz kayıt (14271+17891)', S.pp_14271 + S.sd_17891, O.pp_14271 + O.sd_17891, '', 'site / resmi — eksik girilen olumsuzlar oranı şişirir'),
    `<div class="kpi ${sumUyum !== null && sumUyum < 0.9 ? 'low' : 'ok'}"><span class="lbl">Genel uyum</span><span class="val">${sumUyum === null ? '—' : '%' + Math.round(sumUyum * 100)}</span><span class="delta"></span><span class="hint">Toplam adetlerin resmiyle örtüşmesi</span></div>`,
  ].join('') : '';

  // Tablo
  const val = (p, k) => (k === 'pp' ? (p.rs.pp ?? -1) - (p.ro.pp ?? -1) : k === 'sd' ? (p.rs.sd ?? -1) - (p.ro.sd ?? -1) : k === 'uyum' ? (p.uyum ?? 2) : k === 'name' ? p.u.username : p.site[k] - p.off[k]);
  list.sort((a, b) => { const x = val(a, rSort.key); const y = val(b, rSort.key); return (typeof x === 'string' ? x.localeCompare(y, 'tr') : x - y) * rSort.dir || a.u.username.localeCompare(b.u.username, 'tr'); });
  const th = (key, label, left = false) => `<th class="sortable${left ? ' left' : ''}${rSort.key === key ? ' sorted' : ''}" data-rsort="${key}">${esc(label)}${rSort.key === key ? (rSort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  const cell = (s, o) => `<td class="num${s < o ? ' gap-low' : s > o ? ' gap-high' : ''}" title="site ${s} · resmi ${o}">${s} <span class="muted">/ ${o}</span></td>`;
  const rateCell = (s, o) => `<td class="small"><b>${pct(s)}</b> <span class="muted">/ ${pct(o)}</span>${s !== null && o !== null && Math.abs(s - o) >= 0.005 ? `<br><span class="delta ${s > o ? 'down' : 'up'}">${ptDiff(s, o)}</span>` : ''}</td>`;
  const body = list.map((p) => `<tr><td class="left"><b>${esc(p.u.username)}</b><br><span class="small muted">${esc(teamName(p.u.team_leader_id) || '—')}</span></td>
    ${ITEMS.map((i) => cell(p.site[i.code], p.off[i.code])).join('')}${rateCell(p.rs.pp, p.ro.pp)}${rateCell(p.rs.sd, p.ro.sd)}
    <td><span class="rate ${p.uyum === null ? '' : p.uyum >= 0.9 ? 'ok' : 'low'}">${p.uyum === null ? '—' : '%' + Math.round(p.uyum * 100)}</span></td>
    <td class="left">${p.fl.map(([c, t]) => `<span class="pill ${c}">${esc(t)}</span>`).join(' ')}</td></tr>`).join('')
    || `<tr><td colspan="11" class="empty">${days ? 'Bu dönemde karşılaştırılacak uzman yok.' : 'Önce resmi raporu yükleyin.'}</td></tr>`;
  $('r-table').innerHTML = `<thead><tr>${th('name', 'Kullanıcı', true)}${R_COLS.map((c) => th(c.key, c.label)).join('')}<th class="left">Uyarılar</th></tr></thead><tbody>${body}</tbody>`;
}
// Excel çıktısı: sitedeki tabloyla aynı düzen ve renkler (ExcelJS ile biçimli dosya).
// Her kalem hücresi "site / resmi": site adedi turuncu, resmi adet koyu gri.
let rLast = null;
function loadExcelJs() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/exceljs.min.js?v=4.4.0';
    s.onload = () => resolve(window.ExcelJS);
    s.onerror = () => reject(new Error('Excel oluşturucu yüklenemedi'));
    document.head.appendChild(s);
  });
}
$('r-export').addEventListener('click', async () => {
  if (!rLast || !rLast.days || !rLast.list.length) return toast('Dışa aktarılacak karşılaştırma yok', 'error');
  const btn = $('r-export');
  btn.disabled = true;
  try {
    const [ExcelJS, { agreement }] = await Promise.all([loadExcelJs(), import('./report.js')]);
    const { list, from, to, days, team } = rLast;
    const C = {
      site: 'FFE67E22', off: 'FF555555', navy: 'FF464646', brand: 'FF52BAAA', brandSoft: 'FFE6F5F2',
      redSoft: 'FFFDE4E4', red: 'FFC62828', amberSoft: 'FFFFF4D6', amber: 'FF8A5A00', ok: 'FF1E8E3E', border: 'FFDFE6E4', muted: 'FF6B7472',
    };
    const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
    const thin = { style: 'thin', color: { argb: C.border } };
    const box = { top: thin, left: thin, bottom: thin, right: thin };
    const pairText = (s, o, fmt = (v) => String(v)) => ({ richText: [
      { text: fmt(s), font: { bold: true, color: { argb: C.site }, size: 11 } },
      { text: ' / ', font: { color: { argb: C.muted }, size: 10 } },
      { text: fmt(o), font: { color: { argb: C.off }, size: 10 } },
    ] });
    const pctTxt = (r) => (r === null ? '—' : '%' + (Math.round(r * 1000) / 10).toLocaleString('tr-TR'));
    const ptsTxt = (a, b) => (a === null || b === null || Math.abs(a - b) < 0.0005 ? '' : `${a - b > 0 ? '+' : '−'}${(Math.abs(a - b) * 100).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} puan`);
    const rateCell = (s, o) => {
      const v = pairText(s, o, pctTxt);
      const d = ptsTxt(s, o);
      if (d) v.richText.push({ text: '\n' + d, font: { bold: true, size: 9, color: { argb: s > o ? C.red : C.ok } } });
      return v;
    };
    const teamLabel = !team ? 'Tümü' : team === NO_TEAM ? 'Takımı yok' : teamName(team);
    const period = from === to ? fmtLong(from) : `${fmtShort(from)} – ${fmtShort(to)}`;

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Uzman Hedef Takip';
    const ws = wb.addWorksheet('Karşılaştırma', { views: [{ state: 'frozen', ySplit: 6 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    const head = ['Kullanıcı', 'Takım lideri', ...ITEMS.map((i) => i.label), 'Post Pre %', 'Savedesk %', 'Uyum', 'Uyarılar'];
    ws.columns = head.map((h, i) => ({ width: i === 0 ? 22 : i === 1 ? 18 : i === head.length - 1 ? 34 : i >= 8 && i <= 9 ? 17 : 13 }));
    const last = head.length;

    // Başlık ve açıklama
    ws.mergeCells(1, 1, 1, last);
    Object.assign(ws.getCell(1, 1), { value: 'Resmi Rapor Karşılaştırması', font: { bold: true, size: 15, color: { argb: C.navy } } });
    ws.mergeCells(2, 1, 2, last);
    Object.assign(ws.getCell(2, 1), { value: `${period} · Takım lideri: ${teamLabel} · Resmi raporu olan ${days} gün · Oluşturulma: ${fmtDateTime(new Date().toISOString())}`, font: { size: 10, color: { argb: C.muted } } });
    ws.mergeCells(3, 1, 3, last);
    ws.getCell(3, 1).value = { richText: [
      { text: 'Her hücrede ', font: { size: 10, color: { argb: C.muted } } },
      { text: 'site', font: { bold: true, size: 10, color: { argb: C.site } } },
      { text: ' / ', font: { size: 10, color: { argb: C.muted } } },
      { text: 'resmi', font: { size: 10, color: { argb: C.off } } },
      { text: '.  Kırmızı zemin: uzman resmide olandan az girmiş.  Turuncu zemin: fazla girmiş.  Uyum: girilenlerin resmi rapora yakınlığı (100 = birebir).', font: { size: 10, color: { argb: C.muted } } },
    ] };

    // Özet satırı (sitedeki kartlar)
    const S = emptyTotals(); const O = emptyTotals();
    for (const p of list) ITEMS.forEach((i) => { S[i.code] += p.site[i.code]; O[i.code] += p.off[i.code]; });
    const rs = rates(S); const ro = rates(O); const su = agreement(S, O);
    const summary = [
      ['Post Pre %', rateCell(rs.pp, ro.pp)], ['Savedesk %', rateCell(rs.sd, ro.sd)],
      ['Olumsuz kayıt (14271+17891)', pairText(S.pp_14271 + S.sd_17891, O.pp_14271 + O.sd_17891)],
      ['Genel uyum', { richText: [{ text: su === null ? '—' : '%' + Math.round(su * 100), font: { bold: true, size: 12, color: { argb: su !== null && su < 0.9 ? C.red : C.ok } } }] }],
    ];
    summary.forEach(([label, value], k) => {
      const col = 1 + k * 2;
      ws.mergeCells(4, col, 4, col + 1); ws.mergeCells(5, col, 5, col + 1);
      Object.assign(ws.getCell(4, col), { value: label.toLocaleUpperCase('tr-TR'), font: { bold: true, size: 9, color: { argb: C.navy } }, alignment: { horizontal: 'center' }, fill: fill(C.brandSoft), border: box });
      Object.assign(ws.getCell(5, col), { value, alignment: { horizontal: 'center', vertical: 'middle', wrapText: true }, border: box });
    });
    ws.getRow(5).height = 32;

    // Tablo başlığı
    const hr = ws.getRow(6);
    head.forEach((h, i) => Object.assign(hr.getCell(i + 1), {
      value: h, font: { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }, fill: fill(C.navy), border: box,
      alignment: { horizontal: i < 2 || i === last - 1 ? 'left' : 'center', vertical: 'middle', wrapText: true },
    }));
    hr.height = 22;

    // Uzman satırları
    const addRow = (name, tl, site, off, uyum, flagsText, isTotal = false) => {
      const r = ws.addRow([]);
      const rs2 = rates(site); const ro2 = rates(off);
      Object.assign(r.getCell(1), { value: name, font: { bold: true, color: { argb: C.navy } } });
      Object.assign(r.getCell(2), { value: tl, font: { size: 10, color: { argb: C.muted } } });
      ITEMS.forEach((i, k) => {
        const c = r.getCell(3 + k);
        c.value = pairText(site[i.code], off[i.code]);
        c.alignment = { horizontal: 'center', vertical: 'middle' };
        if (site[i.code] < off[i.code]) c.fill = fill(C.redSoft);
        else if (site[i.code] > off[i.code]) c.fill = fill(C.amberSoft);
      });
      Object.assign(r.getCell(9), { value: rateCell(rs2.pp, ro2.pp), alignment: { horizontal: 'center', vertical: 'middle', wrapText: true } });
      Object.assign(r.getCell(10), { value: rateCell(rs2.sd, ro2.sd), alignment: { horizontal: 'center', vertical: 'middle', wrapText: true } });
      Object.assign(r.getCell(11), {
        value: uyum === null ? '—' : '%' + Math.round(uyum * 100), alignment: { horizontal: 'center', vertical: 'middle' },
        font: { bold: true, color: { argb: uyum === null ? C.muted : uyum >= 0.9 ? C.ok : C.red } },
      });
      Object.assign(r.getCell(12), { value: flagsText, font: { size: 10, color: { argb: C.red } }, alignment: { wrapText: true, vertical: 'middle' } });
      for (let k = 1; k <= last; k++) {
        const c = r.getCell(k);
        c.border = box;
        if (isTotal) { c.fill = c.fill?.fgColor?.argb === C.redSoft || c.fill?.fgColor?.argb === C.amberSoft ? c.fill : fill(C.brandSoft); }
        if (k <= 2) c.alignment = { ...(c.alignment || {}), vertical: 'middle' };
      }
      if (isTotal) r.getCell(1).border = { ...box, top: { style: 'medium', color: { argb: C.brand } } };
      r.height = 30;
    };
    for (const p of list) addRow(p.u.username, teamName(p.u.team_leader_id) || '—', p.site, p.off, p.uyum, p.fl.map((f) => f[1]).join(' · '));
    addRow('GENEL TOPLAM', '', S, O, su, '', true);

    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    a.download = `Resmi-Rapor-Karsilastirma_${from}${from === to ? '' : '_' + to}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
});

$('r-table').addEventListener('click', (ev) => {
  const t = ev.target.closest('th[data-rsort]');
  if (!t) return;
  const key = t.dataset.rsort;
  rSort = rSort.key === key ? { key, dir: -rSort.dir } : { key, dir: key === 'uyum' || key === 'name' ? 1 : -1 };
  renderReport().catch((e) => toast(e.message, 'error'));
});

// ---------------------------------------------------------------- Yönetici paneli
const AUDIT_NAMES = {
  admin_login: 'Yönetici girişi', create_user: 'Kullanıcı ekleme', delete_user: 'Kullanıcı silme', set_user_password: 'Kullanıcı şifresi',
  set_targets: 'Hedef kartı', set_maintenance: 'Bakım modu', change_own_password: 'Yönetici şifresi', set_count: 'Adet düzeltme',
  delete_entry: 'Kayıt silme', set_team: 'Takım değişikliği', create_team_leader: 'Takım lideri ekleme', delete_team_leader: 'Takım lideri silme',
  create_contest: 'Yarışma oluşturma', cancel_contest: 'Yarışma iptali', upload_official: 'Resmi rapor yükleme',
};
const auditDetail = (a) => {
  const d = a.details || {};
  if (a.action === 'set_count') return `${d.username} · ${fmtShort(d.day)} · ${itemLabel(d.item)} = ${d.value}`;
  if (a.action === 'set_targets') return `Post Pre ${pct(d.postpre)} · Savedesk ${pct(d.savedesk)}`;
  if (a.action === 'set_maintenance') return d.maintenance ? 'Açıldı' : 'Kapatıldı';
  if (a.action === 'delete_entry') return `${uname(d.user_id)} · ${itemLabel(d.item)}`;
  if (a.action === 'set_team') return `${d.username} → ${d.team || 'takımsız'}`;
  if (a.action === 'create_team_leader' || a.action === 'delete_team_leader') return d.name || '';
  if (a.action === 'create_contest' || a.action === 'cancel_contest') return d.message || '';
  if (a.action === 'upload_official') return `${d.filename || ''} · ${d.day_from ? fmtShort(d.day_from) : ''}–${d.day_to ? fmtShort(d.day_to) : ''} · ${d.matched ?? 0} uzman`;
  return d.username || '';
};

const ISTANBUL_OFFSET = '+03:00'; // Türkiye yıl boyu UTC+3
const at = (day, time) => `${day}T${time}:00${ISTANBUL_OFFSET}`;
const hm = (iso) => new Date(iso).toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit' });
let lastQuery = null;

async function renderPanel() {
  $('tg-pp').value = Math.round(Number(settings.postpre_target) * 1000) / 10;
  $('tg-sd').value = Math.round(Number(settings.savedesk_target) * 1000) / 10;
  $('maint').checked = settings.maintenance;
  $('maint-text').textContent = settings.maintenance ? 'Açık — uzmanlar siteyi kullanamıyor' : 'Kapalı';

  // Kullanıcılar (takım lideri seçimi ile)
  const active = users.filter((u) => u.active);
  $('u-count').textContent = `${active.length} aktif kullanıcı`;
  const teamOptions = (sel) => `<option value="">— Takımı yok —</option>${teams.map((t) => `<option value="${t.id}"${t.id === sel ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}`;
  $('u-table').innerHTML = `<thead><tr><th class="left">Kullanıcı adı</th><th class="left">Takım lideri</th><th>Son veri</th><th>İşlemler</th></tr></thead><tbody>${
    active.map((u) => `<tr><td class="left" title="Eklenme: ${fmtDateTime(u.created_at)}"><b>${esc(u.username)}</b></td><td class="left"><select class="team-sel" data-team="${u.id}">${teamOptions(u.team_leader_id)}</select></td><td class="small nowrap">${fmtDateTime(u.last_entry_at)}</td>
      <td><div class="actions"><button class="btn sm" data-pw="${u.id}">Şifre</button><button class="btn sm danger" data-rm="${u.id}">Sil</button></div></td></tr>`).join('')
    || '<tr><td colspan="4" class="empty">Kullanıcı yok.</td></tr>'}</tbody>`;

  // Takım liderleri
  $('t-table').innerHTML = `<thead><tr><th class="left">Takım lideri</th><th>Kullanıcı</th><th></th></tr></thead><tbody>${
    teams.map((t) => `<tr><td class="left"><b>${esc(t.name)}</b></td><td class="num">${active.filter((u) => u.team_leader_id === t.id).length}</td><td style="text-align:right"><button class="btn sm danger" data-tdel="${t.id}">Sil</button></td></tr>`).join('')
    || '<tr><td colspan="3" class="empty">Takım lideri yok.</td></tr>'}</tbody>`;

  // Yarışmalar
  const contests = unwrap(await client.from('contests').select('id, message, target, prize, starts_at, ends_at, cancelled_at').order('starts_at', { ascending: false }).limit(30));
  const now = Date.now();
  const state = (c) => (c.cancelled_at ? ['İptal', 'gray'] : now < Date.parse(c.starts_at) ? ['Bekliyor', 'amber'] : now < Date.parse(c.ends_at) ? ['Devam ediyor', 'green'] : ['Bitti', 'gray']);
  $('c-table').innerHTML = `<thead><tr><th class="left">Tarih / saat</th><th class="left">Duyuru</th><th>Durum</th><th></th></tr></thead><tbody>${
    contests.map((c) => {
      const [label, color] = state(c);
      const dayIso = new Date(c.starts_at).toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });
      return `<tr><td class="left num small">${fmtShort(dayIso)} ${hm(c.starts_at)}–${hm(c.ends_at)}</td><td class="left small">${esc(c.message)}</td><td><span class="pill ${color}">${label}</span></td>
        <td class="row" style="justify-content:flex-end"><button class="btn sm" data-cq="${c.id}" data-day="${dayIso}" data-from="${hm(c.starts_at)}" data-to="${hm(c.ends_at)}">Sorgula</button>${label === 'Bekliyor' || label === 'Devam ediyor' ? `<button class="btn sm danger" data-cx="${c.id}">İptal</button>` : ''}</td></tr>`;
    }).join('') || '<tr><td colspan="4" class="empty">Henüz yarışma yok.</td></tr>'}</tbody>`;

  if (lastQuery) await runQuery(lastQuery, false);

  const audit = unwrap(await client.from('admin_audit').select('action, details, created_at').order('created_at', { ascending: false }).limit(50));
  $('audit-table').innerHTML = `<tbody>${audit.map((a) => `<tr><td class="left small muted">${fmtDateTime(a.created_at)}</td><td class="left">${AUDIT_NAMES[a.action] || esc(a.action)}</td><td class="left small">${esc(auditDetail(a))}</td></tr>`).join('') || '<tr><td class="empty">Kayıt yok.</td></tr>'}</tbody>`;
}

// Yarışma sorgusu: saat aralığında ikna adetleri (yalnızca uzmanın kendi girdiği kayıtlar)
async function runQuery(q, scroll = true) {
  if (q.from >= q.to) { toast('Bitiş saati başlangıçtan sonra olmalı', 'error'); return; }
  lastQuery = q;
  const rows = unwrap(await client.rpc('ikna_between', { p_from: at(q.day, q.from), p_to: at(q.day, q.to) }));
  const keep = teamFilter(q.team);
  const list = rows.map((r) => ({ ...r, u: users.find((x) => x.id === r.user_id), total: Number(r.pp_ikna) + Number(r.sd_ikna) }))
    .filter((r) => r.u && keep(r.u))
    .sort((a, b) => b.total - a.total || a.u.username.localeCompare(b.u.username, 'tr'));
  $('q-table').innerHTML = `<thead><tr><th>#</th><th class="left">Kullanıcı</th><th class="left">Takım lideri</th><th>484 İkna</th><th>16234 İkna</th><th>Toplam İkna</th></tr></thead><tbody>${
    list.map((r, i) => `<tr><td class="num">${i + 1}</td><td class="left"><b>${esc(r.u.username)}</b></td><td class="left small">${esc(teamName(r.u.team_leader_id) || '—')}</td><td class="num">${r.pp_ikna}</td><td class="num">${r.sd_ikna}</td><td class="num"><b>${r.total}</b></td></tr>`).join('')
    || '<tr><td colspan="6" class="empty">Bu aralıkta ikna girilmemiş.</td></tr>'}</tbody>
    <tfoot><tr><td colspan="6" class="left small muted">${fmtShort(q.day)} ${q.from}–${q.to}${q.team ? ` · ${esc(q.team === NO_TEAM ? 'Takımı yok' : teamName(q.team))}` : ''} · ${list.length} kullanıcı</td></tr></tfoot>`;
  if (scroll) $('q-table').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
$('q-day').value = istanbulToday();
$('q-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  runQuery({ day: $('q-day').value, from: $('q-start').value, to: $('q-end').value, team: $('q-team').value }).catch((e) => toast(e.message, 'error'));
});

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
    await adminApi('create_user', { username: $('nu-name').value, password: $('nu-pass').value, team_leader_id: $('nu-team').value || null });
    toast(`${$('nu-name').value} eklendi`, 'success');
    ev.target.reset();
  } catch (e) { toast(e.message, 'error'); }
  refresh();
});
$('u-table').addEventListener('change', async (ev) => {
  const sel = ev.target.closest('select[data-team]');
  if (!sel) return;
  try {
    await adminApi('set_team', { user_id: sel.dataset.team, team_leader_id: sel.value || null });
    toast(`${uname(sel.dataset.team)} → ${teamName(sel.value) || 'takımsız'}`, 'success');
  } catch (e) { toast(e.message, 'error'); }
  sel.blur();
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
$('team-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try { await adminApi('create_team_leader', { name: $('nt-name').value }); toast('Takım lideri eklendi', 'success'); ev.target.reset(); } catch (e) { toast(e.message, 'error'); }
  refresh();
});
$('t-table').addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-tdel]');
  if (!b) return;
  const name = teamName(b.dataset.tdel);
  if (!await modal({ title: 'Takım liderini sil', message: `${name} silinsin mi? Bu takımdaki kullanıcılar "takımsız" kalır.`, ok: 'Sil', danger: true })) return;
  try { await adminApi('delete_team_leader', { id: b.dataset.tdel }); toast('Takım lideri silindi', 'success'); } catch (e) { toast(e.message, 'error'); }
  refresh();
});

// Mini yarışma
$('c-day').value = istanbulToday();
function contestPreview() {
  const s = $('c-start').value; const e = $('c-end').value; const t = $('c-target').value; const p = $('c-prize').value.trim();
  $('c-preview').textContent = s && e && t && p
    ? `Uzmanlara görünecek duyuru: "${fmtShort($('c-day').value)} ${s}–${e} arasında toplam ${t} ikna (484 İkna + 16234 İkna) yapana ${p} verilecektir."`
    : '';
}
['c-day', 'c-start', 'c-end', 'c-target', 'c-prize'].forEach((id) => $(id).addEventListener('input', contestPreview));
$('contest-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const day = $('c-day').value;
  try {
    await adminApi('create_contest', {
      starts_at: at(day, $('c-start').value), ends_at: at(day, $('c-end').value),
      target: Number($('c-target').value), prize: $('c-prize').value,
    });
    toast('Yarışma yayınlandı', 'success');
    ev.target.reset(); $('c-day').value = istanbulToday(); contestPreview();
  } catch (e) { toast(e.message, 'error'); }
  refresh();
});
$('c-table').addEventListener('click', async (ev) => {
  const q = ev.target.closest('[data-cq]');
  const x = ev.target.closest('[data-cx]');
  if (q) {
    $('q-day').value = q.dataset.day; $('q-start').value = q.dataset.from; $('q-end').value = q.dataset.to; $('q-team').value = '';
    runQuery({ day: q.dataset.day, from: q.dataset.from, to: q.dataset.to, team: '' }).catch((e) => toast(e.message, 'error'));
  } else if (x) {
    if (!await modal({ title: 'Yarışmayı iptal et', message: 'Yarışma iptal edilsin mi? Henüz başlamadıysa uzmanlara duyuru çıkmaz.', ok: 'İptal et', danger: true })) return;
    try { await adminApi('cancel_contest', { id: Number(x.dataset.cx) }); toast('Yarışma iptal edildi', 'success'); } catch (e) { toast(e.message, 'error'); }
    refresh();
  }
});

$('pw-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if ($('pw-new').value !== $('pw-new2').value) return toast('Yeni şifreler eşleşmiyor', 'error');
  try { await adminApi('change_own_password', { current: $('pw-cur').value, next: $('pw-new').value }); ev.target.reset(); toast('Yönetici şifresi değiştirildi', 'success'); } catch (e) { toast(e.message, 'error'); }
});

// ---------------------------------------------------------------- Gizli ekran (üst yönetici)
const shortUa = (ua) => {
  const s = String(ua || '');
  const br = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : 'Diğer';
  const os = /Windows/.test(s) ? 'Windows' : /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iOS' : /Mac OS/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : '';
  return `${br}${os ? ' · ' + os : ''}`;
};
async function renderLogins() {
  if (!isSuper) return;
  const { result: rows } = await adminApi('list_admin_logins');
  $('l-table').innerHTML = `<thead><tr><th class="left">Tarih / saat</th><th class="left">Hesap</th><th class="left">IP adresi</th><th class="left">Tarayıcı</th></tr></thead><tbody>${
    rows.map((r) => `<tr><td class="left num small">${fmtDateTime(r.created_at)}</td><td class="left">${r.user?.is_super ? '<span class="pill gray">Üst yönetici</span>' : '<span class="pill amber">Yönetici</span>'}</td><td class="left num"><b>${esc(r.ip || '—')}</b></td><td class="left small" title="${esc(r.user_agent || '')}">${esc(shortUa(r.user_agent))}</td></tr>`).join('')
    || '<tr><td colspan="4" class="empty">Kayıt yok.</td></tr>'}</tbody>`;
}

// ---------------------------------------------------------------- Sekmeler ve senkronizasyon
const showMola = (v) => async () => {
  const f = document.querySelector(`section[data-panel="mola-${v}"] iframe`);
  if (f && !f.src) f.src = f.dataset.src;
};
const renderers = { 'mola-live': showMola('live'), 'mola-stats': showMola('stats'), 'mola-day-plan': showMola('day-plan'), 'mola-week': showMola('week'), home: renderHome, daily: renderDaily, history: renderHistory, report: renderReport, panel: renderPanel, logins: renderLogins };
setupTabs($('nav'), (t) => { tab = t; refresh(); });

let running = false; let again = false;
async function refreshNow() {
  if (running) { again = true; return; }
  running = true;
  try {
    await loadBase();
    const typing = document.activeElement?.matches?.('form input, form select, #u-table select');
    if (!(tab === 'panel' && typing)) await renderers[tab]();
  } catch (e) { toast(e.message, 'error'); }
  finally { running = false; if (again) { again = false; refreshNow(); } }
}
const refresh = debounce(refreshNow, 250);

await client.realtime.setAuth(session.access_token);
client.channel('yonetici')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'entries' }, refresh)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, refresh)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'contests' }, refresh)
  .subscribe((status) => { setLive($('live'), status); if (status === 'SUBSCRIBED') refresh(); });

let lastDay = istanbulToday();
setInterval(() => { if (istanbulToday() !== lastDay) { lastDay = istanbulToday(); refresh(); } }, 30_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

await refreshNow();
