import { $, api, dateText, escape, groups, pct, rates, recordTable, status, totalsFor } from './common.js?v=2';
import { showMyPlan, clearMyPlan } from './my-plan.js?v=3';

let config;
let history = false;
let generation = 0;
let saving = false;
let retry = null;
const undoActions = new Map();
const undo = document.createElement('section');
undo.className = 'daily-card daily-undo';
undo.setAttribute('aria-label', 'Son eklenen kayıtlar');
undo.hidden = true;
const undoList = document.createElement('ul');
undo.append(undoList);
$('dashboard').append(undo);

function showScores(entries) {
  const totals = totalsFor(config.items, entries);
  const percentages = rates(totals);
  $('scores').innerHTML = Object.entries(groups).map(([key, label]) => {
    const rate = percentages[key];
    const target = config.targets[key];
    const result = rate === null ? '' : rate >= target ? 'ok' : 'low';
    const description = result === 'ok' ? ' · Hedefte' : result === 'low' ? ' · Hedef altında' : '';
    return `<article class="daily-score"><h3>${label}</h3><strong data-rate="${result}">${pct(rate)}</strong>
      <small>Hedef ${pct(target)}${description}</small></article>`;
  }).join('');
  for (const { code } of config.items) $('total-' + code).textContent = totals[code];
  $('records').innerHTML = recordTable(entries, config.items);
}

async function loadScores() {
  const request = ++generation;
  const selected = history;
  const date = $('history-date');
  $('dashboard').setAttribute('aria-busy', 'true');
  try {
    const result = await api(selected && date.value ? 'entries?day=' + encodeURIComponent(date.value) : 'entries');
    if (request !== generation) return;
    config.today = result.today;
    config.targets = result.targets;
    date.max = result.today;
    $('score-heading').textContent = selected ? dateText(result.day) : 'Bugünün skoru';
    showScores(result.entries);
  } catch (error) {
    if (request !== generation) return;
    if (error.status === 401) clearSession();
    status(error.message, true);
  } finally {
    if (request === generation) $('dashboard').removeAttribute('aria-busy');
  }
}

function setView(isHistory) {
  history = isHistory;
  $('today').setAttribute('aria-pressed', String(!history));
  $('history').setAttribute('aria-pressed', String(history));
  $('entry-area').hidden = history;
  $('history-date-label').hidden = !history;
  status();
  return loadScores();
}

function clearSession() {
  clearMyPlan();
  generation++;
  $('dashboard').removeAttribute('aria-busy');
  $('dashboard').hidden = true;
  $('logout').hidden = true;
  $('login').hidden = false;
  $('intro').textContent = 'Mola saatlerini, Post Pre ve Savedesk kayıtlarını takip et.';
  $('gsm').value = '';
  $('records').replaceChildren();
  $('expert-contests').hidden = true;
  $('expert-contest-list').replaceChildren();
  $('scores').replaceChildren();
  for (const id of undoActions.keys()) dismissUndo(id);
  retry = null;
}

async function initialize(session) {
  config = session ?? await api('session?plan=1');
  if (!config.user) {
    clearSession();
    return;
  }
  $('login').hidden = true;
  $('dashboard').hidden = false;
  $('logout').hidden = false;
  $('intro').textContent = 'Post Pre ve Savedesk';
  showMyPlan(config.user.name, config.myPlan);
  $('history-date').value = config.today;
  $('history-date').max = config.today;
  $('counters').innerHTML = Object.entries(groups).map(([key, label]) =>
    `<article class="daily-card"><h3>${label}</h3>${config.items.filter(i => i.group === key).map(item =>
      `<div class="daily-counter"><span>${escape(item.label)}</span><div><strong id="total-${escape(item.code)}">0</strong>
        <button class="button" type="button" data-item="${escape(item.code)}" aria-label="${escape(item.label)} ekle">Ekle</button>
      </div></div>`).join('')}</article>`).join('');
  await setView(false);
  await loadExpertContests();
}

function dismissUndo(id) {
  const pending = undoActions.get(id);
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.row.remove();
  undoActions.delete(id);
  undo.hidden = undoActions.size === 0;
}

function queueUndo(result, item) {
  if (undoActions.has(result.id) || result.undoUntil <= Date.now()) return;
  const row = document.createElement('li');
  const label = document.createElement('span');
  label.textContent = item.label + ' eklendi';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button secondary';
  button.textContent = 'Geri al';
  button.setAttribute('aria-label', item.label + ' kaydını geri al');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api('undo', { id: result.id });
      status('Kayıt geri alındı.');
      await loadScores();
    } catch (error) {
      status(error.message, true);
    } finally {
      dismissUndo(result.id);
    }
  });
  row.append(label, button);
  undoList.append(row);
  undo.hidden = false;
  const timer = setTimeout(() => dismissUndo(result.id), result.undoUntil - Date.now());
  undoActions.set(result.id, { row, timer });
}

function confirmDuplicate() {
  const dialog = $('duplicate');
  return new Promise(resolve => {
    dialog.returnValue = 'cancel';
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'add'), { once: true });
    dialog.showModal();
  });
}

$('counters').addEventListener('click', async event => {
  const trigger = event.target.closest('[data-item]');
  if (!trigger || saving) return;
  const input = $('gsm');
  const gsm = input.value.trim().replace(/[\s()-]/g, '');
  if (!/^[0-9]{10}$/.test(gsm)) {
    status('10 haneli GSM numarası gir.', true);
    input.focus();
    return;
  }
  const item = config.items.find(entry => entry.code === trigger.dataset.item);
  saving = true;
  const buttons = $('counters').querySelectorAll('button');
  for (const button of buttons) button.disabled = true;
  status();
  const data = retry?.gsm === gsm && retry?.item === item.code && retry?.day === config.today
    ? retry : { day: config.today, id: crypto.randomUUID(), item: item.code, gsm, force: false };
  retry = data;
  try {
    let result = await api('entries', data);
    if (result.duplicate) {
      if (!await confirmDuplicate()) {
        retry = null;
        return;
      }
      data.force = true;
      result = await api('entries', data);
    }
    retry = null;
    input.value = '';
    queueUndo(result, item);
    status(item.label + ' kaydı eklendi.');
    await loadScores();
    if (!history) input.focus();
  } catch (error) {
    if (error.status && error.status < 500) retry = null;
    if (error.status === 401) clearSession();
    status(error.message, true);
    if (error.status === 409) await loadScores();
  } finally {
    saving = false;
    for (const button of buttons) button.disabled = false;
  }
});

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  button.disabled = true;
  status();
  try {
    const credentials = Object.fromEntries(new FormData(form));
    const session = await api('login', { ...credentials, includePlan: true });
    form.reset();
    await initialize(session.user ? session : undefined);
  } catch (error) {
    status(error.message, true);
  } finally {
    button.disabled = false;
  }
});
$('logout').addEventListener('click', async () => {
  if (saving) return;
  try {
    await api('logout', {});
    clearSession();
    status('Çıkış yapıldı.');
  } catch (error) {
    status(error.message, true);
  }
});
$('today').addEventListener('click', () => setView(false));
$('history').addEventListener('click', () => setView(true));
$('history-date').addEventListener('change', () => {
  status();
  if ($('history-date').validity.valid) loadScores();
});
$('refresh').addEventListener('click', () => {
  status();
  loadScores();
});
const contestTime = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'short', timeStyle: 'short' });
async function loadExpertContests() {
  if ($('dashboard').hidden) return;
  try {
    const result = await api('contests');
    if ($('dashboard').hidden) return;
    $('expert-contests').hidden = !result.contests.length;
    $('expert-contest-list').replaceChildren(...result.contests.map(contest => {
      const item = document.createElement('li');
      const start = contestTime.format(contest.startsAt);
      const end = contestTime.format(contest.endsAt);
      item.textContent = start + ' – ' + end + ' · Hedef ' + contest.target + ' ikna · ' + contest.prize;
      return item;
    }));
  } catch {
    $('expert-contests').hidden = true;
  }
}
setInterval(() => {
  if (!document.hidden) loadExpertContests();
}, 30_000);

initialize().then(() => {
  if ($('status').textContent === 'Oturum kontrol ediliyor…') status();
}).catch(error => {
  clearSession();
  status(error.message, true);
});
