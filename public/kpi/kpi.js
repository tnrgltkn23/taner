const API = "/api/kpi/public";
const REFRESH_MS = 60_000;
const CACHE_KEY = 'kpi:last-bootstrap';

const KPI_TARGETS = { post_pre: 65, savedesk: 75, take_rate: 65 };
const DASHBOARD_TARGETS = { post_pre: 65, savedesk: 75 };
const BONUS_TARGETS = { post_pre: 68, savedesk: 76, working_hours: 135 };
const SENIORITY_GROUPS = ['0-3 Ay', '4-11 Ay', '12 Ay Üzeri'];
const COLORS = { primary: 'var(--violet)', violet: 'var(--orchid)', amber: 'var(--kpi-amber)', target: '#c9d3e3', low: 'var(--kpi-low)' };

const SECTIONS = [
  { id: '', label: 'Ana Sayfa', render: renderHome },
  { id: 'uzmanlar', label: 'Uzmanlar', render: renderEmployees },
  { id: 'gunluk', label: 'Günlük', render: renderDaily },
  { id: 'takimlar', label: 'Takımlar', render: renderTeams },
  { id: 'vardiya', label: 'Vardiya', render: renderShifts },
  { id: 'siralama', label: 'Sıralama', render: renderRanking },
  { id: 'prim-hakedisleri', label: 'Prim Hakedişleri', render: renderBonus },
  { id: 'onceki-aylar', label: 'Önceki Aylar', render: renderHistory },
  { id: 'kidem', label: 'Kıdem', render: renderSeniority },
  { id: 'duyurular', label: 'Duyurular', render: renderAnnouncements }
];

const $ = (selector, root = document) => root.querySelector(selector);
const view = $('#kpi-view');
const tabs = $('#kpi-tabs');
const dialog = $('#kpi-dialog');
const dialogBody = $('#kpi-dialog-body');
const collator = new Intl.Collator('tr-TR', { sensitivity: 'base' });

let data = null;
let signature = '';
let route = '';
const filters = {};
const cache = new Map();

// ---------- biçimlendirme ----------
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pct = (v) => isNum(v) ? `${v.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%` : '—';
const num = (v, d = 0) => isNum(v) ? v.toLocaleString('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
const avg = (values) => { const v = values.filter(isNum); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const sum = (values) => values.filter(isNum).reduce((s, x) => s + x, 0);
const lower = (s) => String(s ?? '').toLocaleLowerCase('tr-TR');
const initials = (name) => String(name ?? '').trim().split(/\s+/).slice(0, 2).map((p) => p[0] ?? '').join('').toLocaleUpperCase('tr-TR');
const dateTime = (v) => { if (!v) return '—'; const d = new Date(v); return Number.isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul' }).format(d); };
const dateOnly = (v) => { if (!v) return '—'; const d = new Date(v.length === 10 ? `${v}T00:00:00` : v); return Number.isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(d); };
const utcDate = (v, opts) => new Intl.DateTimeFormat('tr-TR', { ...opts, timeZone: 'UTC' }).format(new Date(`${v}T00:00:00Z`));
const teamKey = (v) => String(v ?? '').trim().normalize('NFKD').replace(/\p{M}/gu, '').replace(/ı/g, 'i').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const sortTr = (a, b) => collator.compare(a, b);

function kpiStatus(kpi, value) {
  if (!isNum(value)) return 'veri-yok';
  const diff = value - KPI_TARGETS[kpi];
  if (diff >= 0) return 'hedefte';
  if (diff >= -2) return 'yakın';
  return 'hedef-alti';
}
function badge(kpi, value) {
  const s = kpiStatus(kpi, value);
  if (s === 'hedefte') return '<span class="kpi-badge ok">Hedefte</span>';
  if (s === 'yakın') return '<span class="kpi-badge near">Hedefe Yakın</span>';
  if (s === 'hedef-alti') return '<span class="kpi-badge low">Hedef Altı</span>';
  return '<span class="kpi-badge">Veri Yok</span>';
}
const statusBadge = (e) => e.special_status ? `<span class="kpi-badge">Durum: ${esc(e.special_status)}</span>` : badge('take_rate', e.take_rate);
const isDashboardTarget = (e) => !e.special_status && isNum(e.post_pre) && isNum(e.savedesk) && e.post_pre >= DASHBOARD_TARGETS.post_pre && e.savedesk >= DASHBOARD_TARGETS.savedesk;

function seniority(start, now = new Date()) {
  if (!start) return null;
  const s = new Date(`${start}T00:00:00`);
  if (Number.isNaN(s.getTime()) || s > now) return null;
  let total = (now.getFullYear() - s.getFullYear()) * 12 + now.getMonth() - s.getMonth();
  if (now.getDate() < s.getDate()) total -= 1;
  total = Math.max(0, total);
  const years = Math.floor(total / 12), months = total % 12;
  return { total, label: years > 0 ? `${years} Yıl${months ? ` ${months} Ay` : ''}` : `${months} Ay`, group: total <= 3 ? '0-3 Ay' : total <= 11 ? '4-11 Ay' : '12 Ay Üzeri' };
}
const seniorityGroup = (e) => seniority(e.employment_start_date)?.group ?? 'Kıdem Bilgisi Yok';

function evaluateBonus(e) {
  const metric = (key, label, value, target, unit) => ({ key, label, value, target, unit, met: isNum(value) && value >= target, remaining: isNum(value) ? Math.max(0, target - value) : null });
  const metrics = [
    metric('post_pre', 'Post Pre', e.post_pre, BONUS_TARGETS.post_pre, 'percent'),
    metric('savedesk', 'Savedesk', e.savedesk, BONUS_TARGETS.savedesk, 'percent'),
    metric('working_hours', 'Çalışma Saati', e.eksik_sure, BONUS_TARGETS.working_hours, 'hours')
  ];
  const unmet = metrics.filter((m) => !m.met);
  return { metrics, unmet, eligible: !e.special_status && unmet.length === 0 };
}

function richText(value) {
  return String(value ?? '').split('\n').map((line) => esc(line)
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\+\+([^+\n]+?)\+\+/g, '<u>$1</u>')
    .replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>')).join('<br>');
}

const teams = (list) => [...new Set(list.map((e) => e.team_leader).filter(Boolean))].sort(sortTr);
const options = (values, selected, all = 'Tümü') => [all, ...values].map((v) => {
  const [value, label] = Array.isArray(v) ? v : [v, v];
  return `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
}).join('');
const sectionHead = (title, text) => `<div class="kpi-section-head"><h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}</div>`;
const stat = (label, value, note = '', cls = '') => `<div class="kpi-stat ${cls}"><span>${esc(label)}</span><strong>${value}</strong>${note ? `<small>${note}</small>` : ''}</div>`;
const message = (title, text, action = '') => `<div class="kpi-message"><h4>${esc(title)}</h4><p>${text}</p>${action}</div>`;
const nameCell = (e, sub) => `<span class="kpi-name"><span class="initials">${esc(initials(e.full_name))}</span><span>${esc(e.full_name)}<small>${esc(sub)}</small></span></span>`;

function state(id, defaults) { filters[id] ??= { ...defaults }; return filters[id]; }
function bindFilters(root, id, update) {
  root.querySelectorAll('[data-f]').forEach((el) => el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', () => { filters[id][el.dataset.f] = el.value; update(); }));
}

// ---------- grafikler (bağımsız SVG) ----------
function chartBars(items) {
  if (!items.length) return '<div class="kpi-empty">Grafik için yeterli veri bulunmuyor.</div>';
  const W = 560, H = 280, L = 34, B = 30, T = 18, R = 8, ih = H - T - B, iw = W - L - R;
  const y = (v) => T + ih - (Math.max(0, Math.min(100, v)) / 100) * ih;
  const group = iw / items.length, bw = Math.min(46, group / 3.2);
  let out = '';
  for (const t of [0, 25, 50, 75, 100]) out += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>`;
  items.forEach((it, i) => {
    const cx = L + group * i + group / 2;
    const bar = (v, x, color, label) => `<rect x="${x}" y="${y(v)}" width="${bw}" height="${T + ih - y(v)}" rx="7" fill="${color}"><title>${esc(label)}: ${pct(v)}</title></rect><text class="val" x="${x + bw / 2}" y="${y(v) - 6}" text-anchor="middle">${num(v, 1)}</text>`;
    out += bar(it.actual, cx - bw - 3, COLORS.primary, `${it.name} gerçekleşen`) + bar(it.target, cx + 3, COLORS.target, `${it.name} hedef`);
    out += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${esc(it.name)}</text>`;
  });
  return `<div class="kpi-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="KPI gerçekleşen ve hedef karşılaştırması">${out}</svg></div><div class="kpi-legend"><span style="--c:${COLORS.primary}"><i></i>Gerçekleşen</span><span style="--c:${COLORS.target}"><i></i>Hedef</span></div>`;
}

function chartDonut(target, below) {
  const total = target + below;
  if (!total) return '<div class="kpi-empty">Grafik için yeterli veri bulunmuyor.</div>';
  const r = 82, c = 2 * Math.PI * r, share = target / total;
  return `<div class="kpi-chart"><svg viewBox="0 0 560 280" role="img" aria-label="Hedefte ${target}, hedef altı ${below} uzman">
    <g transform="translate(280 140) rotate(-90)"><circle r="${r}" fill="none" stroke="${COLORS.low}" stroke-width="30"/><circle r="${r}" fill="none" stroke="${COLORS.primary}" stroke-width="30" stroke-dasharray="${c * share} ${c}" stroke-linecap="${share > 0 && share < 1 ? 'round' : 'butt'}"/></g>
    <text x="280" y="134" text-anchor="middle" class="val" style="font:400 40px var(--display);fill:var(--ink)">${Math.round(share * 100)}%</text><text x="280" y="160" text-anchor="middle">hedefte</text></svg></div>
    <div class="kpi-legend"><span style="--c:${COLORS.primary}"><i></i>Hedefte · ${target}</span><span style="--c:${COLORS.low}"><i></i>Hedef Altı · ${below}</span></div>`;
}

function chartTeams(items) {
  if (!items.length) return '<div class="kpi-empty">Grafik için yeterli veri bulunmuyor.</div>';
  const W = 560, rowH = 44, L = 150, R = 56, T = 8, H = T + items.length * rowH + 22, iw = W - L - R;
  let out = '';
  for (const t of [0, 25, 50, 75, 100]) { const x = L + (t / 100) * iw; out += `<line class="grid" x1="${x}" x2="${x}" y1="${T}" y2="${H - 22}"/><text x="${x}" y="${H - 6}" text-anchor="middle">${t}</text>`; }
  items.forEach((it, i) => {
    const yy = T + i * rowH + 9, w = Math.max(2, (Math.min(100, it.value) / 100) * iw);
    out += `<text x="${L - 10}" y="${yy + 17}" text-anchor="end" style="fill:var(--ink)">${esc(it.name)}</text><rect x="${L}" y="${yy}" width="${w}" height="26" rx="8" fill="${i === 0 ? COLORS.primary : COLORS.violet}"><title>${esc(it.name)}: ${pct(it.value)}</title></rect><text class="val" x="${L + w + 8}" y="${yy + 17}">${num(it.value, 2)}%</text>`;
  });
  return `<div class="kpi-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Takım bazında Take Rate">${out}</svg></div>`;
}

function chartTrend(points) {
  if (points.length < 2) return '<div class="kpi-empty">Trend için en az iki veri sürümü gerekir.</div>';
  const W = 560, H = 280, L = 34, R = 12, T = 14, B = 30, iw = W - L - R, ih = H - T - B;
  const x = (i) => L + (iw * i) / (points.length - 1), y = (v) => T + ih - (Math.max(0, Math.min(100, v)) / 100) * ih;
  const series = [['post_pre', 'Post Pre', COLORS.primary], ['savedesk', 'Savedesk', COLORS.violet], ['take_rate', 'Take Rate', COLORS.amber]];
  let out = '';
  for (const t of [0, 25, 50, 75, 100]) out += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>`;
  const step = Math.ceil(points.length / 12);
  points.forEach((p, i) => { if (i % step === 0 || i === points.length - 1) out += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">V${esc(p.version)}</text>`; });
  for (const [key, label, color] of series) {
    const d = points.map((p, i) => isNum(p[key]) ? `${x(i).toFixed(1)},${y(p[key]).toFixed(1)}` : null).filter(Boolean);
    if (d.length > 1) out += `<polyline points="${d.join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"><title>${label}</title></polyline>`;
    const lastIndex = points.map((p) => isNum(p[key])).lastIndexOf(true);
    if (lastIndex >= 0) out += `<circle cx="${x(lastIndex)}" cy="${y(points[lastIndex][key])}" r="4" fill="${color}"><title>${label} V${points[lastIndex].version}: ${pct(points[lastIndex][key])}</title></circle>`;
  }
  return `<div class="kpi-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Sürümler arası KPI trendi">${out}</svg></div><div class="kpi-legend">${series.map(([, l, c]) => `<span style="--c:${c}"><i></i>${l}</span>`).join('')}</div>`;
}

// ---------- bölümler ----------
function renderHome(root) {
  const employees = data.employees, valid = employees.filter((e) => !e.special_status), overall = data.teamSummary?.overall;
  const postPre = overall?.post_pre ?? avg(valid.map((e) => e.post_pre));
  const savedesk = overall?.savedesk ?? avg(valid.map((e) => e.savedesk));
  const takeRate = overall?.take_rate ?? avg(valid.map((e) => e.take_rate));
  const target = valid.filter(isDashboardTarget).length;
  const fromEmployees = teams(employees).map((leader) => ({ name: leader, value: avg(employees.filter((e) => e.team_leader === leader && !e.special_status).map((e) => e.take_rate)) ?? 0 }));
  const teamRows = (data.teamSummary?.teams?.length
    ? data.teamSummary.teams.map((t) => ({ name: t.team_leader, value: t.take_rate ?? fromEmployees.find((x) => teamKey(x.name) === teamKey(t.team_leader))?.value ?? 0 }))
    : fromEmployees).sort((a, b) => b.value - a.value);
  const bars = [['Post Pre', postPre, KPI_TARGETS.post_pre], ['Savedesk', savedesk, KPI_TARGETS.savedesk], ['Take Rate', takeRate, KPI_TARGETS.take_rate]]
    .filter(([, v]) => isNum(v)).map(([name, actual, t]) => ({ name, actual, target: t }));
  root.innerHTML = `${sectionHead('Ana Sayfa', 'Operasyonun güncel KPI görünümü ve takım karşılaştırmaları.')}
  <div class="kpi-stats">
    ${stat('Toplam Uzman', num(employees.length), 'aktif kayıt', 'is-feature')}
    ${stat('Hedefte Olan Uzman', num(target), `Post Pre %${DASHBOARD_TARGETS.post_pre} + Savedesk %${DASHBOARD_TARGETS.savedesk}`, 'is-accent')}
    ${stat('Post Pre Ortalaması', pct(postPre), `Hedef %${KPI_TARGETS.post_pre}`)}
    ${stat('Savedesk Ortalaması', pct(savedesk), `Hedef %${KPI_TARGETS.savedesk}`)}
    ${stat('Take Rate Ortalaması', pct(takeRate), `Hedef %${KPI_TARGETS.take_rate}`)}
    ${stat('Total İkna', num(sum(valid.map((e) => e.total_ikna))))}
    ${stat('Çalışma Saati Ortalaması', num(avg(valid.map((e) => e.eksik_sure)), 2))}
  </div>
  <div class="kpi-grid-2">
    <div class="kpi-card"><h4>KPI Genel Durum</h4><p class="kpi-card-sub">Gerçekleşen ortalamalar ve sabit hedefler</p>${chartBars(bars)}</div>
    <div class="kpi-card"><h4>Hedefte / Hedef Altı</h4><p class="kpi-card-sub">Post Pre %${DASHBOARD_TARGETS.post_pre} ve Savedesk %${DASHBOARD_TARGETS.savedesk} hedeflerini birlikte karşılayanlar</p>${chartDonut(target, valid.length - target)}</div>
    <div class="kpi-card"><h4>Takım Performansı</h4><p class="kpi-card-sub">${data.teamSummary ? 'GENEL / TL tablosundaki Take Rate ortalamaları' : 'TAKIM LİDERİ bazında Take Rate ortalaması'}</p>${chartTeams(teamRows)}</div>
    <div class="kpi-card"><h4>KPI Trend</h4><p class="kpi-card-sub">Yayınlanmış veri sürümleri arasındaki değişim</p>${chartTrend(data.trends ?? [])}</div>
  </div>`;
}

function renderEmployees(root) {
  const f = state('uzmanlar', { q: '', team: 'Tümü', sen: 'Tümü', status: 'Tümü', sort: 'Adı Soyadı' });
  const employees = data.employees;
  root.innerHTML = `${sectionHead('Uzmanlar', '<span id="emp-count"></span> · Detay için isme tıkla.')}
  <div class="kpi-filters">
    <label>Ara<span class="search"><span>⌕</span><input data-f="q" value="${esc(f.q)}" placeholder="Adı Soyadı veya Username"></span></label>
    <label>Takım Lideri<select data-f="team">${options(teams(employees), f.team)}</select></label>
    <label>Kıdem<select data-f="sen">${options(SENIORITY_GROUPS, f.sen)}</select></label>
    <label>Hedef Durumu<select data-f="status">${options([['hedefte', 'Hedefte'], ['hedef-alti', 'Hedef Altı'], ['yakın', 'Hedefe Yakın'], ['Özel Durum', 'Özel Durum']], f.status)}</select></label>
    <label>Sırala<select data-f="sort">${options(['Take Rate', 'Total İkna'], f.sort, 'Adı Soyadı')}</select></label>
  </div><div id="emp-results"></div>`;
  const update = () => {
    const q = lower(f.q);
    const list = employees.filter((e) => (lower(e.full_name).includes(q) || lower(e.username).includes(q))
      && (f.team === 'Tümü' || e.team_leader === f.team) && (f.sen === 'Tümü' || seniorityGroup(e) === f.sen)
      && (f.status === 'Tümü' || f.status === kpiStatus('take_rate', e.take_rate) || (f.status === 'Özel Durum' && Boolean(e.special_status))))
      .sort((a, b) => f.sort === 'Take Rate' ? (b.take_rate ?? -Infinity) - (a.take_rate ?? -Infinity) : f.sort === 'Total İkna' ? (b.total_ikna ?? -Infinity) - (a.total_ikna ?? -Infinity) : sortTr(a.full_name, b.full_name));
    $('#emp-count', root).textContent = `${list.length} uzman gösteriliyor`;
    $('#emp-results', root).innerHTML = !list.length ? message('Sonuç yok', 'Filtrelere uygun uzman bulunamadı.') : `
    <div class="table-card kpi-only-desktop"><div class="table-toolbar"><span><i></i> Uzman KPI listesi</span><span>İsme tıkla, uzman kartını gör ↗</span></div><div class="table-scroll"><table><thead><tr><th>ADI SOYADI</th><th>POST PRE</th><th>SAVEDESK</th><th>TAKE RATE</th><th>TOTAL İKNA</th><th>KIDEM</th><th>ÇALIŞMA SAATİ</th><th>TAKIM LİDERİ</th><th>DURUM</th></tr></thead><tbody>
    ${list.map((e) => `<tr data-user="${esc(e.username)}" tabindex="0"><td>${nameCell(e, e.username)}</td><td class="num">${pct(e.post_pre)}</td><td class="num">${pct(e.savedesk)}</td><td class="num">${pct(e.take_rate)}</td><td class="num">${num(e.total_ikna)}</td><td>${esc(seniority(e.employment_start_date)?.label ?? 'Kıdem Bilgisi Yok')}</td><td class="num">${num(e.eksik_sure, 2)}</td><td>${esc(e.team_leader)}</td><td>${statusBadge(e)}</td></tr>`).join('')}
    </tbody></table></div><div class="table-bottom"><span>${list.length} uzmandan ${list.length} kişi gösteriliyor</span><span><i></i> Take Rate hedefi %${KPI_TARGETS.take_rate}</span></div></div>
    <div class="kpi-list kpi-only-mobile">${list.map((e) => `<button type="button" class="kpi-row-card" data-user="${esc(e.username)}"><span class="initials">${esc(initials(e.full_name))}</span><span><strong>${esc(e.full_name)}</strong><small>${esc(e.team_leader)}</small></span>${statusBadge(e)}<span class="kpi-row-metrics"><div><span>Post Pre</span><b>${pct(e.post_pre)}</b></div><div><span>Savedesk</span><b>${pct(e.savedesk)}</b></div><div><span>Take Rate</span><b>${pct(e.take_rate)}</b></div></span></button>`).join('')}</div>`;
  };
  bindFilters(root, 'uzmanlar', update);
  update();
}

function renderDaily(root) {
  const f = state('gunluk', { q: '', team: 'Tümü' });
  const all = data.employees.filter((e) => e.active !== false).sort((a, b) => sortTr(a.full_name, b.full_name));
  const entries = all.flatMap((e) => e.daily_entries ?? []);
  const dates = [...new Set(entries.map((x) => x.date))].sort();
  root.innerHTML = `${sectionHead('Günlük Veriler', 'Excel dosyasındaki “Günlük” sayfasından alınan adet ve oranları görmek için MT adına tıkla.')}
  <div class="kpi-stats">${stat('MT', num(all.length), '', 'is-feature')}${stat('Günlük Kayıt', num(entries.length))}${stat('Tarih', num(dates.length))}${stat('Veri Dönemi', dates.length ? `${utcDate(dates[0], { day: '2-digit', month: 'short' })} – ${utcDate(dates.at(-1), { day: '2-digit', month: 'short' })}` : '—', '', 'is-accent')}</div>
  ${entries.length ? '' : message('Henüz günlük veri yok', 'Günlük sayfasını içeren Excel yönetici panelinden yayınlandığında bu alan otomatik dolar.')}
  <div class="kpi-filters"><label>MT Ara<span class="search"><span>⌕</span><input data-f="q" value="${esc(f.q)}" placeholder="Adı soyadı veya username"></span></label><label>Takım Lideri<select data-f="team">${options(teams(all), f.team)}</select></label></div>
  <div id="daily-results" class="kpi-accordion"></div>`;
  const update = () => {
    const q = lower(f.q);
    const list = all.filter((e) => lower(`${e.full_name} ${e.username}`).includes(q) && (f.team === 'Tümü' || e.team_leader === f.team));
    $('#daily-results', root).innerHTML = !list.length ? message('Sonuç yok', 'Filtrelere uygun MT bulunamadı.') : list.map((e) => {
      const rows = [...(e.daily_entries ?? [])].sort((a, b) => b.date.localeCompare(a.date));
      return `<details class="kpi-acc"><summary><span class="kpi-acc-id"><span class="initials">${esc(initials(e.full_name))}</span><span><strong>${esc(e.full_name)}</strong><small>${esc(e.username)} · ${esc(e.team_leader)}</small></span></span><span class="kpi-acc-side"><span class="kpi-badge ${rows.length ? 'ok' : ''}">${rows.length ? `${rows.length} gün` : 'Günlük veri yok'}</span></span></summary>
      <div class="kpi-acc-body">${rows.length ? `<div class="kpi-inner-table"><table><thead><tr><th>TARİH</th><th>484 İKNA</th><th>484 GEÇİŞ</th><th>14271</th><th>16234 İKNA</th><th>16234 İPTAL</th><th>17891</th><th>GRAND TOTAL</th><th>P2P ORAN</th><th>SV ORAN</th><th>TAKE RATE</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td><strong>${esc(utcDate(r.date, { weekday: 'long', day: '2-digit', month: 'long' }))}</strong></td><td>${num(r.post_pre?.ikna_484)}</td><td>${num(r.post_pre?.gecis_484)}</td><td>${num(r.post_pre?.adet_14271)}</td><td>${num(r.savedesk?.ikna_16234)}</td><td>${num(r.savedesk?.iptal_16234)}</td><td>${num(r.savedesk?.adet_17891)}</td><td><strong>${num(r.grand_total)}</strong></td><td>${pct(r.post_pre?.rate)}</td><td>${pct(r.savedesk?.rate)}</td><td><strong>${pct(r.take_rate)}</strong></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="kpi-card-sub">Bu MT için Günlük sayfasında kayıt bulunamadı.</p>'}</div></details>`;
    }).join('');
  };
  bindFilters(root, 'gunluk', update);
  update();
}

function renderTeams(root) {
  const employees = data.employees, summaries = data.teamSummary?.teams ?? [];
  const leaders = new Map();
  employees.forEach((e) => leaders.set(teamKey(e.team_leader), e.team_leader));
  summaries.forEach((s) => leaders.set(teamKey(s.team_leader), s.team_leader));
  const list = [...leaders.values()].sort(sortTr).map((leader) => {
    const members = employees.filter((e) => teamKey(e.team_leader) === teamKey(leader)).sort((a, b) => sortTr(a.full_name, b.full_name));
    const valid = members.filter((e) => !e.special_status);
    const imported = summaries.find((s) => teamKey(s.team_leader) === teamKey(leader));
    return { leader, members,
      postPre: imported?.post_pre ?? avg(valid.map((e) => e.post_pre)), savedesk: imported?.savedesk ?? avg(valid.map((e) => e.savedesk)),
      takeRate: imported?.take_rate ?? avg(valid.map((e) => e.take_rate)),
      totalIkna: sum(valid.map((e) => e.total_ikna)), below: valid.filter((e) => kpiStatus('take_rate', e.take_rate) === 'hedef-alti').length };
  });
  root.innerHTML = `${sectionHead('Takımlar', `${list.length} takım, ${employees.length} uzman${data.teamSummary ? ' · KPI ortalamaları GENEL / TL tablosundan' : ''}.`)}
  <div class="kpi-accordion">${list.map((t) => `<details class="kpi-acc"><summary><span class="kpi-acc-id"><span class="initials">${esc(initials(t.leader))}</span><span><strong>${esc(t.leader)}</strong><small>${t.members.length} uzman</small></span></span><span class="kpi-acc-side">${badge('take_rate', t.takeRate)}</span></summary>
  <div class="kpi-mini-stats">${[['Post Pre', pct(t.postPre)], ['Savedesk', pct(t.savedesk)], ['Take Rate', pct(t.takeRate)], ['Total İkna', num(t.totalIkna)], ['Hedef Altı', num(t.below)]].map(([l, v]) => `<div><span>${l}</span><b>${v}</b></div>`).join('')}</div>
  <div class="kpi-acc-body"><div class="kpi-inner-table"><table><thead><tr><th>ADI SOYADI</th><th>USERNAME</th><th>POST PRE</th><th>SAVEDESK</th><th>TAKE RATE</th><th>TOTAL İKNA</th></tr></thead><tbody>${t.members.map((e) => `<tr data-user="${esc(e.username)}" style="cursor:pointer"><td><strong>${esc(e.full_name)}</strong></td><td>${esc(e.username)}</td><td>${pct(e.post_pre)}</td><td>${pct(e.savedesk)}</td><td>${pct(e.take_rate)}</td><td>${num(e.total_ikna)}</td></tr>`).join('')}</tbody></table></div></div></details>`).join('')}</div>`;
}

function renderRanking(root) {
  const f = state('siralama', { metric: 'Take Rate', dir: 'En Yüksek', team: 'Tümü', sen: 'Tümü', target: 'Tümü' });
  const keys = { 'Post Pre': 'post_pre', Savedesk: 'savedesk', 'Take Rate': 'take_rate', 'Total İkna': 'total_ikna' };
  root.innerHTML = `${sectionHead('Sıralama', 'Özel durum ve sayısal olmayan KPI değerleri sıralamaya alınmaz.')}
  <div class="kpi-filters"><label>KPI<select data-f="metric">${options(Object.keys(keys).filter((k) => k !== 'Post Pre'), f.metric, 'Post Pre')}</select></label><label>Sıralama<select data-f="dir">${options(['En Düşük'], f.dir, 'En Yüksek')}</select></label><label>Takım Lideri<select data-f="team">${options(teams(data.employees), f.team)}</select></label><label>Kıdem<select data-f="sen">${options(SENIORITY_GROUPS, f.sen)}</select></label><label>Hedef Durumu<select data-f="target">${options([['hedefte', 'Hedefte'], ['hedef-alti', 'Hedef Altı'], ['yakın', 'Hedefe Yakın']], f.target)}</select></label></div>
  <div id="rank-results" class="kpi-list"></div>`;
  const update = () => {
    const key = keys[f.metric];
    const list = data.employees.filter((e) => !e.special_status && isNum(e[key]) && (f.team === 'Tümü' || e.team_leader === f.team) && (f.sen === 'Tümü' || seniorityGroup(e) === f.sen) && (f.target === 'Tümü' || key === 'total_ikna' || kpiStatus(key, e[key]) === f.target))
      .sort((a, b) => (b[key] - a[key]) * (f.dir === 'En Yüksek' ? 1 : -1));
    $('#rank-results', root).innerHTML = !list.length ? message('Sonuç yok', 'Sıralama için uygun sayısal kayıt bulunamadı.') : list.map((e, i) => `<button type="button" class="kpi-row-card" data-user="${esc(e.username)}"><span class="kpi-rank ${i < 3 ? 'top' : ''}">${i < 3 ? ['①', '②', '③'][i] : i + 1}</span><span><strong>${esc(e.full_name)}</strong><small>${esc(e.username)} · ${esc(e.team_leader)}</small></span><span class="kpi-rank-value">${key === 'total_ikna' ? num(e[key]) : pct(e[key])}</span></button>`).join('');
  };
  bindFilters(root, 'siralama', update);
  update();
}

function bonusMetric(m) {
  const cur = m.unit === 'percent' ? pct(m.value) : isNum(m.value) ? `${num(m.value, 2)} saat` : '—';
  const tgt = m.unit === 'percent' ? `%${m.target}` : `${m.target} saat`;
  const rem = m.remaining == null ? 'Veri yok' : m.met ? 'Hedef tamam ✓' : m.unit === 'percent' ? `%${num(m.remaining, 2)} kaldı` : `${num(m.remaining, 2)} saat kaldı`;
  return `<div class="kpi-bonus-metric ${m.met ? 'met' : ''}"><header><strong>${m.label}</strong><span>${cur} / ${tgt}</span></header><progress max="100" value="${Math.min(100, Math.max(0, ((m.value ?? 0) / m.target) * 100))}"></progress><p>${rem}</p></div>`;
}

function renderBonus(root) {
  const f = state('prim', { q: '', team: 'Tümü', status: 'Tümü' });
  const evaluated = data.employees.map((e) => ({ e, r: evaluateBonus(e) }));
  const eligible = evaluated.filter((x) => x.r.eligible).length;
  root.innerHTML = `${sectionHead('Prim Hakedişleri', 'Prim hedeflerini ve hedefe kalan değerleri görmek için çalışan adına tıkla.')}
  <div class="kpi-stats">${stat('Prim Hak Eden', num(eligible), 'üç hedefin tamamı', 'is-feature')}${stat('Eksik Hedefi Olan', num(evaluated.length - eligible))}${stat('Post Pre Hedefi', `%${BONUS_TARGETS.post_pre}`)}${stat('Savedesk / Çalışma', `%${BONUS_TARGETS.savedesk} · ${BONUS_TARGETS.working_hours} sa.`, '', 'is-accent')}</div>
  <div class="kpi-filters"><label>Ara<span class="search"><span>⌕</span><input data-f="q" value="${esc(f.q)}" placeholder="Adı Soyadı veya Username"></span></label><label>Takım Lideri<select data-f="team">${options(teams(data.employees), f.team)}</select></label><label>Hakediş Durumu<select data-f="status">${options(['Hak Etti', 'Eksik Hedef'], f.status)}</select></label></div>
  <div id="bonus-results" class="kpi-accordion"></div>`;
  const update = () => {
    const q = lower(f.q);
    const list = evaluated.filter(({ e, r }) => (lower(e.full_name).includes(q) || lower(e.username).includes(q)) && (f.team === 'Tümü' || e.team_leader === f.team) && (f.status === 'Tümü' || (f.status === 'Hak Etti' ? r.eligible : !r.eligible)))
      .sort((a, b) => sortTr(a.e.full_name, b.e.full_name));
    $('#bonus-results', root).innerHTML = !list.length ? message('Sonuç yok', 'Filtrelere uygun müşteri temsilcisi bulunamadı.') : list.map(({ e, r }) => `<details class="kpi-acc"><summary><span class="kpi-acc-id"><span class="initials">${esc(initials(e.full_name))}</span><span><strong>${esc(e.full_name)}</strong><small>${esc(e.username)} · ${esc(e.team_leader)}</small></span></span><span class="kpi-acc-side">${e.special_status ? `<span class="kpi-badge">Özel Durum: ${esc(e.special_status)}</span>` : r.eligible ? '<span class="kpi-badge ok">Prim Hak Etti</span>' : `<span class="kpi-badge low">${r.unmet.length} Hedef Eksik</span>`}</span></summary>
    <div class="kpi-acc-body"><div class="kpi-bonus">${r.metrics.map(bonusMetric).join('')}</div>${!r.eligible && !e.special_status ? `<p class="kpi-bonus-note"><strong>Tamamlanması gerekenler:</strong> ${r.unmet.map((m) => m.remaining == null ? `${m.label}: veri yok` : m.unit === 'percent' ? `${m.label}: %${num(m.remaining, 2)}` : `${m.label}: ${num(m.remaining, 2)} saat`).join(' · ')}</p>` : ''}</div></details>`).join('');
  };
  bindFilters(root, 'prim', update);
  update();
}

function renderSeniority(root) {
  const groups = SENIORITY_GROUPS.map((g) => {
    const members = data.employees.filter((e) => seniorityGroup(e) === g), valid = members.filter((e) => !e.special_status);
    return { g, count: members.length, postPre: avg(valid.map((e) => e.post_pre)), savedesk: avg(valid.map((e) => e.savedesk)), takeRate: avg(valid.map((e) => e.take_rate)), ikna: sum(valid.map((e) => e.total_ikna)) };
  });
  root.innerHTML = `${sectionHead('Kıdem', 'KIDEM, İŞE BAŞLANGIÇ tarihine göre bugün için otomatik hesaplanır.')}
  <div class="kpi-grid-2" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))">${groups.map((x, i) => `<div class="kpi-stat ${i === 0 ? 'is-feature' : i === 1 ? 'is-accent' : ''}"><span>Kıdem Grubu · ${esc(x.g)}</span><strong>${x.count} <small style="font:400 14px var(--ui)">uzman</small></strong><div class="kpi-row-metrics" style="grid-template-columns:1fr 1fr">${[['Post Pre', pct(x.postPre)], ['Savedesk', pct(x.savedesk)], ['Take Rate', pct(x.takeRate)], ['Total İkna', num(x.ikna)]].map(([l, v]) => `<div><span>${l}</span><b>${v}</b></div>`).join('')}</div></div>`).join('')}</div>`;
}

function renderAnnouncements(root) {
  const list = data.announcements ?? [];
  root.innerHTML = `${sectionHead('Duyurular', 'Yönetici tarafından yayınlanan güncel operasyon duyuruları.')}
  <div class="kpi-accordion">${list.length ? list.map((a) => { const accent = a.priority === 'Kritik' ? COLORS.low : a.priority === 'Önemli' ? COLORS.amber : COLORS.primary; const cls = a.priority === 'Kritik' ? 'low' : a.priority === 'Önemli' ? 'near' : 'ok';
    return `<article class="kpi-announce" style="--accent:${accent}"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><h4>${esc(a.title)}</h4><span class="kpi-badge ${cls}">${esc(a.priority)}</span></div>${a.image_url && /^https:\/\//.test(a.image_url) ? `<img src="${esc(a.image_url)}" alt="${esc(a.title)} duyuru görseli" loading="lazy">` : ''}<div class="kpi-announce-text">${richText(a.description)}</div><footer>Yayın: ${dateTime(a.published_at)}${a.expires_at ? ` · Bitiş: ${dateTime(a.expires_at)}` : ''}</footer></article>`; }).join('')
    : message('Henüz duyuru bulunmuyor.', 'Yönetici yeni bir duyuru yayınladığında burada görünür.')}</div>`;
}

async function fetchJson(path) {
  const response = await fetch(`${API}${path}`, { cache: 'no-store' });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? 'Veri alınamadı.');
  return response.json();
}
async function cached(key, path, maxAge = REFRESH_MS) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < maxAge) return hit.value;
  const value = await fetchJson(path);
  cache.set(key, { at: Date.now(), value });
  return value;
}
const loading = (text) => `<div class="kpi-message"><p>${esc(text)}</p></div>`;

async function renderShifts(root) {
  root.innerHTML = sectionHead('Vardiya', 'Tarih ve gün bazında vardiya programı.') + loading('Vardiya programı yükleniyor…');
  let schedule;
  try { schedule = (await cached('shifts', '/shifts')).schedule; } catch { root.innerHTML = sectionHead('Vardiya', '') + message('Vardiya programına ulaşılamadı', 'İnternet bağlantını kontrol edip yeniden dene.'); return; }
  if (!root.isConnected) return;
  if (!schedule) { root.innerHTML = sectionHead('Vardiya', '') + message('Henüz vardiya yayınlanmadı', 'Yönetici panelindeki “Vardiya Yükle” bölümünden yayınlandığında burada görünür.'); return; }
  const f = state('vardiya', { q: '', team: 'Tümü' });
  const cls = (v) => !v ? '' : v.includes(':') ? 'working' : v === 'OFF' ? 'off' : v === 'RAPOR' ? 'report' : 'leave';
  const short = (d) => utcDate(d, { day: 'numeric', month: 'short' });
  root.innerHTML = `${sectionHead('Vardiya', 'Tarih ve gün bazındaki vardiya bilgilerini görmek için çalışan adına tıkla.')}
  <div class="kpi-stats">${stat('Çalışan', num(schedule.employees.length), '', 'is-feature')}${stat('Takvim Günü', num(schedule.days.length))}${stat('Vardiya Dönemi', `${short(schedule.period_start)} – ${short(schedule.period_end)}`, '', 'is-accent')}${stat('Son Yükleme', dateTime(schedule.uploaded_at), esc(schedule.source_filename))}</div>
  <div class="kpi-filters"><label>Çalışan Ara<span class="search"><span>⌕</span><input data-f="q" value="${esc(f.q)}" placeholder="Çalışan adı veya Login ID"></span></label><label>Takım Lideri<select data-f="team">${options(teams(schedule.employees), f.team)}</select></label></div>
  <div class="kpi-shift-legend"><span class="kpi-chip working">Çalışma</span><span class="kpi-chip off">OFF</span><span class="kpi-chip leave">İzin</span><span class="kpi-chip report">Rapor</span></div>
  <div id="shift-results" class="kpi-accordion"></div>`;
  const update = () => {
    const q = lower(f.q);
    const list = schedule.employees.filter((e) => lower(`${e.full_name} ${e.login_id}`).includes(q) && (f.team === 'Tümü' || e.team_leader === f.team)).sort((a, b) => sortTr(a.full_name, b.full_name));
    $('#shift-results', root).innerHTML = !list.length ? message('Sonuç yok', 'Filtrelere uygun çalışan bulunamadı.') : list.map((e) => `<details class="kpi-acc"><summary><span class="kpi-acc-id"><span class="initials">${esc(initials(e.full_name))}</span><span><strong>${esc(e.full_name)}</strong><small>${esc(e.login_id)} · ${esc(e.team_leader)}</small></span></span><span class="kpi-acc-side"><span class="kpi-card-sub">Vardiyayı gör</span></span></summary><div class="kpi-acc-body"><div class="kpi-shift-days">${schedule.days.map((d, i) => { const v = e.shifts?.[i] ?? null; return `<div class="kpi-shift-day"><strong>${esc(d.day_name)}</strong><small>${esc(short(d.date))}</small><span class="kpi-chip ${cls(v)}">${esc(v ?? '—')}</span></div>`; }).join('')}</div></div></details>`).join('');
  };
  bindFilters(root, 'vardiya', update);
  update();
}

async function renderHistory(root) {
  root.innerHTML = sectionHead('Önceki Aylar', 'Yeni ay yayınlandığında bir önceki ayın son veri sürümü otomatik olarak arşivlenir.') + loading('Önceki aylar yükleniyor…');
  let months;
  try { months = (await cached('history', '/history', 10 * 60_000)).months ?? []; } catch { root.innerHTML = sectionHead('Önceki Aylar', '') + message('Önceki aylara ulaşılamadı', 'İnternet bağlantını kontrol edip yeniden dene.'); return; }
  if (!root.isConnected) return;
  if (!months.length) { root.innerHTML = sectionHead('Önceki Aylar', '') + message('Henüz önceki ay bulunmuyor', 'Farklı bir aya ait yeni Excel verisi yayınlandığında mevcut ay otomatik olarak buraya taşınır.'); return; }
  const f = state('onceki', { month: months[0].version_id, q: '', team: 'Tümü' });
  if (!months.some((m) => m.version_id === f.month)) f.month = months[0].version_id;
  root.innerHTML = `${sectionHead('Önceki Aylar', `${months.length} arşivlenmiş ay · Ay seçerek o dönemdeki çalışan ve KPI değerlerini görüntüle.`)}
  <div class="kpi-filters"><label>Ay<select data-f="month">${months.map((m) => `<option value="${esc(m.version_id)}"${m.version_id === f.month ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}</select></label><label>Çalışan Ara<span class="search"><span>⌕</span><input data-f="q" value="${esc(f.q)}" placeholder="Adı Soyadı veya Username"></span></label><label>Takım Lideri<select data-f="team" id="hist-team"></select></label></div>
  <div id="hist-results"></div>`;
  let token = 0;
  const update = async () => {
    const mine = ++token, out = $('#hist-results', root);
    let month;
    try { month = await cached(`history:${f.month}`, `/history/${encodeURIComponent(f.month)}`, 10 * 60_000); }
    catch (error) { if (mine === token) out.innerHTML = message('Seçilen ayın verileri alınamadı', esc(error.message)); return; }
    if (mine !== token || !root.isConnected) return;
    const employees = month.employees ?? [], meta = month.month ?? months.find((m) => m.version_id === f.month);
    const teamSelect = $('#hist-team', root), teamList = teams(employees);
    if (!teamList.includes(f.team)) f.team = 'Tümü';
    teamSelect.innerHTML = options(teamList, f.team);
    const q = lower(f.q);
    const list = employees.filter((e) => lower(`${e.full_name} ${e.username}`).includes(q) && (f.team === 'Tümü' || e.team_leader === f.team)).sort((a, b) => sortTr(a.full_name, b.full_name));
    out.innerHTML = `<div class="kpi-stats">${stat('Çalışan', num(employees.length), '', 'is-feature')}${stat('Ortalama Post Pre', pct(avg(employees.map((e) => e.post_pre))))}${stat('Ortalama Savedesk', pct(avg(employees.map((e) => e.savedesk))))}${stat('Arşiv Dönemi', esc(meta?.label ?? '—'), `${esc(meta?.source_filename ?? '')} · ${dateTime(meta?.published_at)}`, 'is-accent')}</div>
    ${!list.length ? message('Sonuç yok', 'Filtrelere uygun geçmiş çalışan verisi bulunamadı.') : `<div class="table-card"><div class="table-toolbar"><span><i></i> ${esc(meta?.label ?? '')} arşivi</span><span>${list.length} çalışan gösteriliyor</span></div><div class="table-scroll"><table><thead><tr><th>ADI SOYADI</th><th>POST PRE</th><th>SAVEDESK</th><th>TAKE RATE</th><th>TOTAL İKNA</th><th>ÇALIŞMA SAATİ</th><th>TAKIM LİDERİ</th></tr></thead><tbody>${list.map((e) => `<tr style="cursor:default"><td>${nameCell(e, e.special_status ? `${e.username} · ${e.special_status}` : e.username)}</td><td class="num">${pct(e.post_pre)}</td><td class="num">${pct(e.savedesk)}</td><td class="num">${pct(e.take_rate)}</td><td class="num">${num(e.total_ikna)}</td><td class="num">${num(e.eksik_sure, 2)}</td><td>${esc(e.team_leader)}</td></tr>`).join('')}</tbody></table></div></div>`}`;
  };
  root.querySelectorAll('[data-f]').forEach((el) => el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', () => { f[el.dataset.f] = el.value; if (el.dataset.f === 'month') f.team = 'Tümü'; update(); }));
  update();
}

// ---------- uzman kartı ----------
function openEmployee(username) {
  const e = data?.employees.find((x) => x.username === username);
  if (!e) return;
  const sen = seniority(e.employment_start_date);
  const cc = e.channel_counts;
  const cards = [
    { label: 'Post Pre', key: 'post_pre', value: e.post_pre, percent: true, details: [['484 İkna', cc?.post_pre?.ikna_484], ['484 Geçiş', cc?.post_pre?.gecis_484], ['14271 Adet', cc?.post_pre?.adet_14271]] },
    { label: 'Savedesk', key: 'savedesk', value: e.savedesk, percent: true, details: [['16234 İkna', cc?.savedesk?.ikna_16234], ['16234 İptal', cc?.savedesk?.iptal_16234], ['17891 Adet', cc?.savedesk?.adet_17891]] },
    { label: 'Take Rate', key: 'take_rate', value: e.take_rate, percent: true },
    { label: 'Total İkna', value: e.total_ikna, digits: 0 },
    { label: 'Çalışma Saati', value: e.eksik_sure }
  ];
  dialogBody.innerHTML = `<div class="dialog-heading"><span class="panel-eyebrow">UZMAN KARTI</span><h2 id="kpi-dialog-title">${esc(e.full_name)}</h2><p>${esc(e.username)} · ${esc(e.team_leader)}${e.special_status ? ` · Durum: ${esc(e.special_status)}` : ''}</p></div>
  <div class="kpi-profile-meta"><div><span>İşe Başlangıç</span><b>${dateOnly(e.employment_start_date)}</b></div><div><span>Kıdem</span><b>${esc(sen?.label ?? 'Kıdem Bilgisi Yok')}</b></div><div><span>Kıdem Grubu</span><b>${esc(sen?.group ?? '—')}</b></div><div><span>Prim</span><b>${evaluateBonus(e).eligible ? 'Hak etti' : `${evaluateBonus(e).unmet.length} hedef eksik`}</b></div></div>
  <div class="kpi-detail-grid">${cards.map((c) => { const target = c.key ? KPI_TARGETS[c.key] : null; const diff = target != null && isNum(c.value) ? c.value - target : null;
    return `<div class="kpi-detail"><header><strong>${c.label}</strong>${c.key ? badge(c.key, c.value) : ''}</header><div class="big">${c.percent ? pct(c.value) : num(c.value, c.digits ?? 2)}</div>${target != null ? `<dl><div><dt>Hedef</dt><dd>${c.percent ? `${target}%` : target}</dd></div><div><dt>Fark</dt><dd class="${diff != null && diff < 0 ? 'neg' : ''}">${diff == null ? '—' : `${diff > 0 ? '+' : ''}${diff.toFixed(2)}${c.percent ? ' puan' : ''}`}</dd></div></dl>` : ''}${c.details ? `<table><thead><tr>${c.details.map(([l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody><tr>${c.details.map(([, v]) => `<td>${num(v)}</td>`).join('')}</tr></tbody></table>` : ''}</div>`; }).join('')}</div>`;
  if (!dialog.open) dialog.showModal();
}

// ---------- yönlendirme ve veri ----------
function visibleSections() {
  const hidden = data?.settings?.hidden_modules ?? [];
  return SECTIONS.filter((s) => !hidden.includes(s.label));
}
function readRoute() {
  const hash = location.hash;
  if (!hash.startsWith('#/')) return route;
  return decodeURIComponent(hash.slice(2)).replace(/\/$/, '');
}
function renderTabs() {
  tabs.innerHTML = visibleSections().map((s) => `<a href="#/${s.id}"${s.id === route ? ' aria-current="page"' : ''}>${esc(s.label)}</a>`).join('');
  tabs.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function renderHeader() {
  const s = data.settings ?? {};
  $('#kpi-version').textContent = data.activeVersion ? `V${data.activeVersion.version_number}` : '';
  $('#kpi-updated').textContent = dateTime(s.last_published_at);
  const banner = $('#kpi-banner');
  banner.hidden = !s.global_banner;
  banner.textContent = s.global_banner ?? '';
  const names = (data.birthdaysToday ?? []).map((p) => p.full_name).filter(Boolean);
  const bday = $('#kpi-birthday');
  bday.hidden = !names.length;
  bday.textContent = names.length ? `🎂 ${names.join(', ')} · Doğum günün kutlu olsun!` : '';
}
function render() {
  if (!data) return;
  renderHeader();
  if (data.settings?.maintenance_mode) {
    tabs.innerHTML = '';
    view.innerHTML = message('Birazdan yeniden.', esc(data.settings.maintenance_message || 'KPI paneli bakımda.'));
    return;
  }
  const sections = visibleSections();
  let section = sections.find((s) => s.id === route);
  if (!section) { section = sections[0]; route = section.id; }
  renderTabs();
  view.replaceChildren();
  const root = document.createElement('div');
  view.append(root);
  section.render(root);
}

function signatureOf(d) {
  return JSON.stringify([d.activeVersion?.id, d.settings?.updated_at, d.settings?.force_reload_token, d.announcements?.length, d.birthdaysToday?.length]);
}
async function load({ silent = false } = {}) {
  try {
    const next = await fetchJson('/bootstrap');
    const sig = signatureOf(next);
    const changed = signature && sig !== signature;
    data = next;
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(next)); } catch { /* depolama kapalı olabilir */ }
    if (!signature || changed || !silent) { signature = sig; if (changed) cache.clear(); render(); }
    if (changed) toast('KPI verileri güncellendi.');
  } catch {
    if (!data) {
      try { data = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null'); } catch { data = null; }
      if (data) { signature = signatureOf(data); render(); toast('Bağlantı yok — son kaydedilen KPI verileri gösteriliyor.'); }
      else view.innerHTML = message('Bağlantı kurulamadı', 'KPI verilerine şu anda ulaşılamıyor. İnternet bağlantını kontrol edip tekrar dene.', '<button class="button" type="button" id="kpi-retry">Tekrar dene</button>');
    } else if (!silent) toast('KPI verileri yenilenemedi.');
  }
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

// ---------- olaylar ----------
window.addEventListener('hashchange', () => {
  if (!location.hash.startsWith('#/')) return;
  const next = readRoute();
  if (next === route && view.childElementCount) return;
  route = next;
  render();
  $('#kpi-tabs').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
});
document.addEventListener('click', (event) => {
  const row = event.target.closest('[data-user]');
  if (row && view.contains(row)) openEmployee(row.dataset.user);
  if (event.target.closest('#kpi-retry')) { view.innerHTML = loading('Yeniden bağlanılıyor…'); load(); }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.matches?.('tr[data-user]')) openEmployee(event.target.dataset.user);
});
dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
$('#kpi-refresh').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  cache.clear();
  await load();
  button.disabled = false;
  toast('KPI verileri yenilendi.');
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) load({ silent: true }); });
window.addEventListener('online', () => load({ silent: true }));
setInterval(() => { if (!document.hidden) load({ silent: true }); }, REFRESH_MS);

const year = $('#year');
if (year) year.textContent = new Date().getFullYear();
route = readRoute();
load();
