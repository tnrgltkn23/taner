import { $, api, dateText, escape, pct, rates, recordTable, status, totalsFor } from './common.js';

const roles = { admin: 'Yönetici', super: 'Süper yönetici' };
const actions = {
  users: 'Uzman hesabı güncellendi', adjust: 'Skor düzeltildi', remove: 'Kayıt silindi',
  teams: 'Takımlar güncellendi', contests: 'Yarışmalar güncellendi',
  password: 'Yönetici şifresi değiştirildi', maintenance: 'Bakım ayarı değiştirildi',
  targets: 'Hedefler değiştirildi', 'plan-names': 'Mola planı eşleştirmeleri güncellendi',
};
const timestamp = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'short', timeStyle: 'short' });
let config;
let reportGeneration = 0;
let shownDetail = null;

const management = (route, data) => api('admin/' + route, data);
const asIstanbul = value => Date.parse(value + '+03:00');

function showLogin() {
  config = null;
  reportGeneration++;
  shownDetail = null;
  $('manager').hidden = true;
  $('manager-login').hidden = false;
  $('manager-logout').hidden = true;
  $('manager-role').textContent = 'Uzman skorları, hesapları ve hedefler.';
  for (const id of ['report', 'report-summary', 'admin-entries', 'accounts', 'team-list',
    'contests-list', 'contest-results', 'audit-log', 'login-events']) $(id).replaceChildren();
  for (const id of ['manager-login-form', 'manager-password', 'account-form', 'adjust-form']) $(id).reset();
}

function showError(error) {
  if (error.status === 401) showLogin();
  status(error.message, true);
}

function teamOptions(selected = '', placeholder = 'Takımı yok') {
  return '<option value="">' + escape(placeholder) + '</option>' + config.teams.map(team =>
    `<option value="${escape(team.id)}"${selected === team.id ? ' selected' : ''}>${escape(team.name)}</option>`
  ).join('');
}

function selectOptions(select, items, label) {
  const selected = select.value;
  select.replaceChildren(new Option(label, ''));
  for (const item of items) select.add(new Option(item.name, item.id));
  select.value = items.some(item => item.id === selected) ? selected : '';
}

function filterExperts() {
  const team = $('report-team').value;
  const users = team ? config.users.filter(user => user.teamId === team) : config.users;
  selectOptions($('report-user'), users, 'Tüm uzmanlar');
}

function showAccounts() {
  $('accounts').innerHTML = config.users.map(expert => `<div class="daily-account">
    <span><strong>${expert.hasName === false ? '<em>Ad soyad girilmemiş</em>' : escape(expert.name)}</strong><br>${escape(expert.username)} · ${expert.active ? 'Aktif' : 'Kapalı'}</span>
    <button class="button secondary" type="button" data-rename="${escape(expert.id)}">Ad soyadı düzenle</button>
    <label>Takım<select data-team-user="${escape(expert.id)}">${teamOptions(expert.teamId)}</select></label>
    <form data-reset="${escape(expert.id)}">
      <label>Yeni şifre<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{5}" maxlength="5" autocomplete="new-password" required></label>
      <button class="button secondary" type="submit">Uzman şifresini değiştir</button>
    </form>
    <button class="button secondary" type="button" data-account="${escape(expert.id)}" data-active="${expert.active ? '0' : '1'}">${expert.active ? 'Hesabı kapat' : 'Hesabı aç'}</button>
  </div>`).join('') || '<p class="daily-hint">Henüz uzman hesabı yok.</p>';
}

async function loadConfig() {
  config = await management('config');
  selectOptions($('report-team'), config.teams, 'Tüm takımlar');
  selectOptions($('contest-team'), config.teams, 'Tüm takımlar');
  filterExperts();
  showAccounts();
  $('team-list').innerHTML = config.teams.map(team => `<div class="daily-account">
    <span><strong>${escape(team.name)}</strong> · ${config.users.filter(user => user.active && user.teamId === team.id).length} aktif uzman</span>
    <button type="button" class="button secondary" data-team-remove="${escape(team.id)}">Takımı kaldır</button>
  </div>`).join('') || '<p class="daily-hint">Takım eklenmedi.</p>';
  $('contests-list').innerHTML = config.contests.map(contest => `<div class="daily-account"><span>
    <strong>${escape(contest.prize)}</strong> · ${contest.target} ikna<br>
    ${timestamp.format(contest.startsAt)} – ${timestamp.format(contest.endsAt)}</span>
    ${contest.cancelledAt ? 'İptal edildi' : contest.endsAt <= Date.now() ? 'Tamamlandı' :
      `<button type="button" class="button secondary" data-contest-cancel="${escape(contest.id)}">İptal et</button>`}
  </div>`).join('') || '<p class="daily-hint">Yarışma oluşturulmadı.</p>';
}

function table(headers, rows, empty) {
  if (!rows.length) return `<p class="daily-hint">${escape(empty)}</p>`;
  return `<div class="daily-table-wrap"><table class="daily-table"><thead><tr>
    ${headers.map(label => '<th scope="col">' + escape(label) + '</th>').join('')}</tr></thead><tbody>
    ${rows.map(row => '<tr>' + row.map(value => '<td>' + escape(value) + '</td>').join('') + '</tr>').join('')}</tbody></table></div>`;
}

function summaryRows(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = row.day + ':' + row.userId;
    if (!grouped.has(key)) grouped.set(key, { ...row, items: [] });
    grouped.get(key).items.push(row);
  }
  return [...grouped.values()];
}

function showReportSummary(rows) {
  const total = rates(totalsFor(config.items, rows));
  $('report-summary').innerHTML = Object.entries({ pp: 'Post Pre', sd: 'Savedesk' }).map(([key, label]) =>
    `<article class="daily-score"><h3>${label}</h3><strong>${pct(total[key])}</strong>
      <small>Toplam oran · Hedef ${pct(config.targets[key])}</small></article>`
  ).join('');
}

async function loadReport() {
  const generation = ++reportGeneration;
  const dayView = $('period').value === 'day';
  const user = $('report-user').value;
  const team = $('report-team').value;
  const date = dayView ? $('report-day').value : $('report-month').value;
  if (!date) return;
  const params = new URLSearchParams({ [dayView ? 'day' : 'month']: date });
  if (user) params.set('user', user);
  if (team) params.set('team', team);
  const result = await management('report?' + params);
  if (generation !== reportGeneration) return;
  const headers = ['Tarih', 'Uzman', 'Takım', ...config.items.map(item => item.label), 'Post Pre', 'Savedesk'];
  const rows = summaryRows(result.totals).map(row => {
    const totals = totalsFor(config.items, row.items);
    const percentages = rates(totals);
    return [dateText(row.day), row.name + ' · ' + row.username, row.team || '—',
      ...config.items.map(item => totals[item.code]), pct(percentages.pp), pct(percentages.sd)];
  });
  showReportSummary(result.totals);
  $('report').innerHTML = table(headers, rows, 'Bu seçim için kayıt yok.');
  shownDetail = dayView && user ? { userId: user, day: date } : null;
  $('detail').hidden = !shownDetail;
  if (shownDetail) $('admin-entries').innerHTML = recordTable(result.entries, config.items, true);
  else $('admin-entries').replaceChildren();
}

async function loadAudit() {
  const data = await management('audit');
  $('audit-log').innerHTML = table(['Tarih', 'Rol', 'İşlem'], data.rows.map(row =>
    [timestamp.format(row.at), roles[row.role], actions[row.action] ?? row.action]), 'İşlem kaydı yok.');
}

async function loadLogins() {
  if (config?.role !== 'super') return;
  const data = await management('logins');
  $('login-events').innerHTML = table(['Tarih', 'Rol', 'IP', 'Tarayıcı'], data.rows.map(row =>
    [timestamp.format(row.at), roles[row.role], row.ip || '—', row.agent || '—']), 'Giriş kaydı yok.');
}

async function run(button, task) {
  if (button) button.disabled = true;
  status();
  try {
    await task();
  } catch (error) {
    showError(error);
  } finally {
    if (button) button.disabled = false;
  }
}
function listen(id, task) {
  $(id).addEventListener('submit', event => {
    event.preventDefault();
    const form = event.target;
    const data = new FormData(form);
    run(event.submitter, () => task(form, data));
  });
}
function delegatedClick(id, selector, task) {
  $(id).addEventListener('click', event => {
    const button = event.target.closest(selector);
    if (button) run(button, () => task(button));
  });
}

$('period').addEventListener('change', () => {
  const daily = $('period').value === 'day';
  $('day-label').hidden = !daily;
  $('report-day').disabled = !daily;
  $('month-label').hidden = daily;
  $('report-month').disabled = daily;
  $('detail').hidden = true;
  shownDetail = null;
});
$('report-team').addEventListener('change', () => filterExperts());
listen('report-form', loadReport);
listen('manager-login-form', async (form, data) => {
  await management('login', Object.fromEntries(data));
  form.reset();
  await initialize();
});
$('manager-logout').addEventListener('click', event => run(event.currentTarget, async () => {
  await management('logout', {});
  showLogin();
  status('Çıkış yapıldı.');
}));
listen('account-form', async (form, data) => {
  await management('users', Object.fromEntries(data));
  form.reset();
  await loadConfig();
  status('Uzman hesabı oluşturuldu.');
});
listen('accounts', async (form, data) => {
  await management('users', { id: form.dataset.reset, pin: data.get('pin') });
  form.reset();
  status('Uzman şifresi değiştirildi.');
});
$('accounts').addEventListener('change', event => {
  const select = event.target.closest('[data-team-user]');
  if (!select) return;
  run(select, async () => {
    try {
      await management('teams', { userId: select.dataset.teamUser, teamId: select.value || null });
      await loadConfig();
      status('Uzmanın takımı güncellendi.');
    } catch (error) {
      select.value = config?.users.find(user => user.id === select.dataset.teamUser)?.teamId || '';
      throw error;
    }
  });
});
delegatedClick('accounts', '[data-rename]', async button => {
  const expert = config.users.find(user => user.id === button.dataset.rename);
  const name = prompt(`${expert?.username} için ad soyad (mola planındaki yazımla):`, expert?.hasName ? expert.name : '');
  if (name === null || !name.trim()) return;
  await management('users', { id: button.dataset.rename, name: name.trim() });
  await loadConfig();
  status('Ad soyad güncellendi.');
});
delegatedClick('accounts', '[data-account]', async button => {
  const active = button.dataset.active === '1';
  await management('users', { id: button.dataset.account, active });
  await loadConfig();
  status(active ? 'Uzman hesabı açıldı.' : 'Uzman hesabı kapatıldı.');
});
listen('target-form', async (form, data) => {
  const targets = { pp: Number(data.get('pp')), sd: Number(data.get('sd')) };
  await management('targets', targets);
  config.targets = targets;
  await loadReport();
  status('Hedefler kaydedildi.');
});
listen('adjust-form', async (form, data) => {
  if (!shownDetail) return;
  await management('adjust', { ...shownDetail, item: data.get('item'), total: Number(data.get('total')) });
  form.reset();
  await loadReport();
  status('Toplam düzeltildi.');
});
delegatedClick('admin-entries', '[data-remove]', async button => {
  if (!confirm('Bu GSM kaydını silmek istiyor musun?')) return;
  await management('remove', { id: button.dataset.remove });
  await loadReport();
  status('Kayıt silindi.');
});
listen('team-form', async (form, data) => {
  await management('teams', { name: data.get('name') });
  form.reset();
  await loadConfig();
  status('Takım eklendi.');
});
delegatedClick('team-list', '[data-team-remove]', async button => {
  if (!confirm('Takım kaldırılsın mı? Uzman kayıtları korunur.')) return;
  await management('teams', { remove: button.dataset.teamRemove });
  await loadConfig();
  await loadReport();
  status('Takım kaldırıldı.');
});
listen('contest-form', async (form, data) => {
  await management('contests', { startsAt: asIstanbul(data.get('start')), endsAt: asIstanbul(data.get('end')),
    target: Number(data.get('target')), prize: data.get('prize') });
  form.reset();
  await loadConfig();
  status('Yarışma oluşturuldu.');
});
delegatedClick('contests-list', '[data-contest-cancel]', async button => {
  if (!confirm('Bu yarışma iptal edilsin mi?')) return;
  await management('contests', { cancel: button.dataset.contestCancel });
  await loadConfig();
  status('Yarışma iptal edildi.');
});
listen('contest-result-form', async (form, data) => {
  const params = new URLSearchParams({ from: asIstanbul(data.get('start')), to: asIstanbul(data.get('end')) });
  if (data.get('team')) params.set('team', data.get('team'));
  const response = await management('contest-results?' + params);
  $('contest-results').innerHTML = table(['Uzman', 'Takım', '484 İkna', '16234 İkna', 'Toplam'], response.rows.map(row =>
    [row.name + ' · ' + row.username, row.team || '—', row.pp, row.sd, row.total]), 'Bu aralıkta ikna kaydı yok.');
});
listen('maintenance-form', async (form, data) => {
  await management('maintenance', { enabled: data.has('enabled') });
  status('Bakım ayarı kaydedildi.');
});
listen('manager-password', async (form, data) => {
  await management('password', Object.fromEntries(data));
  form.reset();
  status('Yönetici şifresi değiştirildi.');
});
$('audit-refresh').addEventListener('click', event => run(event.currentTarget, loadAudit));
$('logins-refresh').addEventListener('click', event => run(event.currentTarget, loadLogins));

async function initialize() {
  await loadConfig();
  $('report-day').value = config.today;
  $('report-day').max = config.today;
  $('report-month').value = config.today.slice(0, 7);
  $('report-month').max = config.today.slice(0, 7);
  $('target-form').elements.pp.value = config.targets.pp;
  $('target-form').elements.sd.value = config.targets.sd;
  $('maintenance-form').elements.enabled.checked = config.maintenance;
  $('adjust-item').replaceChildren(...config.items.map(item => new Option(item.label, item.code)));
  $('manager-role').textContent = roles[config.role];
  $('manager-login').hidden = true;
  $('manager').hidden = false;
  $('manager-logout').hidden = false;
  $('login-history').hidden = config.role !== 'super';
  $('login-history-link').hidden = config.role !== 'super';
  await Promise.all([loadReport(), loadAudit(), loadLogins()]);
}

initialize().catch(error => error.status === 401 ? showLogin() : showError(error));
