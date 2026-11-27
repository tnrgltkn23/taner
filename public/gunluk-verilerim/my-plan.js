import { $, api } from './common.js';
import { planState, scheduleFor } from '/plan-time.js?v=2';

const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const day = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit',
});
const pad = number => String(number).padStart(2, '0');
const time = value => value == null ? '—' : pad(Math.floor(value / 60) % 24) + ':' + pad(value % 60);
const countdown = value => [Math.floor(value / 3600), Math.floor(value / 60) % 60, value % 60].map(pad).join(':');

let current;
let generation = 0;
let pending = null;
let mappedName = '';
let signature = '';
let retryTimer = 0;
let reminders;

function syncReminders() {
  const plan = current?.plan;
  const hasSlots = !$('my-break-details').hidden;
  $('my-break-reminders').hidden = !plan || !hasSlots || !reminders;
  reminders?.setReminderContext(plan && hasSlots ? {
    employee: plan.employee, settings: plan.settings, date: plan.date, eligible: true,
  } : null);
}

function loadReminders() {
  if (reminders || $('my-break-details').hidden) return;
  import('/notifications.js?v=2').then(module => {
    if (reminders) return;
    reminders = module;
    reminders.bindNotificationUI();
    syncReminders();
  }).catch(() => {});
}

function tick() {
  if (!current || document.hidden) return;
  const now = new Date();
  const [hour, minute, second] = clock.format(now).split(':').map(Number);
  const { today, plan } = current;
  if (today !== day.format(now)) {
    refresh();
    return;
  }
  const state = planState(plan.employee, plan.settings, hour * 60 + minute + second / 60, plan.date < today);
  const active = state.active ?? state.next;
  if (plan.date < today && hour * 60 + minute >= plan.employee.end) {
    current = null;
    $('my-break-countdown').hidden = true;
    $('my-break-details').hidden = true;
    syncReminders();
    refresh();
    return;
  }
  $('my-break-countdown').hidden = !active;
  $('my-break-label').textContent = state.active ? 'Molanın bitmesine' : 'Sıradaki molana';
  $('my-break-clock').textContent = active ? countdown(state.remaining) : '';
  $('my-break-next').textContent = active
    ? active.label + ' · ' + time(active.time) + (state.active ? ' – ' + time(active.time + active.duration) : '')
    : '';
  const message = active ? '' : state.schedule.length
    ? 'Bugünkü molaların tamamlandı.' : 'Bu vardiya için mola saati planlanmamış.';
  if ($('my-break-message').textContent !== message) $('my-break-message').textContent = message;
  const slots = $('my-break-slots').children;
  const selected = state.active ? state.schedule.indexOf(state.active) : -1;
  for (let index = 0; index < slots.length; index++) {
    if (index === selected) slots[index].setAttribute('aria-current', 'true');
    else slots[index].removeAttribute('aria-current');
  }
}

function display(result) {
  $('my-break-retry').hidden = true;
  $('my-break-name').textContent = result.name;
  const plan = result.plan;
  current = plan ? result : null;
  $('my-break-shift').hidden = !plan;
  $('my-break-countdown').hidden = !plan;
  const details = $('my-break-details');
  if (!plan) {
    $('my-break-message').textContent = 'Bugün için adına yayımlanmış mola planı yok.';
    details.hidden = true;
    signature = '';
    syncReminders();
    return;
  }
  const { employee, settings } = plan;
  $('my-break-shift').textContent = 'Vardiya · ' + time(employee.start) + ' – ' + time(employee.end);
  const nextSignature = JSON.stringify(plan);
  if (signature !== nextSignature) {
    signature = nextSignature;
    const nodes = scheduleFor(employee, settings).map(slot => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = slot.label;
      const hours = document.createElement('strong');
      hours.textContent = time(slot.time) + ' – ' + time(slot.time + slot.duration);
      li.append(name, hours);
      return li;
    });
    $('my-break-slots').replaceChildren(...nodes);
    details.hidden = !nodes.length;
  }
  tick();
  syncReminders();
  loadReminders();
}

async function refresh(retry = true) {
  if (!mappedName || pending !== null || retryTimer) return;
  $('my-break-retry').hidden = true;
  const request = ++generation;
  pending = request;
  try {
    const result = await api('my-plan', undefined, { timeout: 5000 });
    if (pending !== request) return;
    display(result);
  } catch (error) {
    if (pending !== request) return;
    if (error.status === 401) {
      clearMyPlan();
      return;
    }
    if (current) return;
    if (retry && (!error.status || error.status >= 500)) {
      $('my-break-message').textContent = 'Mola planı yeniden deneniyor…';
      retryTimer = setTimeout(() => {
        retryTimer = 0;
        refresh(false);
      }, 750);
    } else {
      $('my-break-message').textContent = 'Mola planı yüklenemedi.';
      $('my-break-retry').hidden = false;
    }
  } finally {
    if (pending === request) pending = null;
  }
}

export function showMyPlan(name, initialPlan) {
  clearMyPlan();
  mappedName = name;
  $('my-break-name').textContent = name;
  $('my-break-message').textContent = 'Mola planı yükleniyor…';
  $('my-break').hidden = false;
  if (initialPlan) display(initialPlan);
  else refresh();
}

export function clearMyPlan() {
  clearTimeout(retryTimer);
  retryTimer = 0;
  $('my-break-retry').hidden = true;
  pending = null;
  current = null;
  mappedName = '';
  signature = '';
  $('my-break').hidden = true;
  $('my-break-shift').hidden = true;
  $('my-break-countdown').hidden = true;
  $('my-break-details').hidden = true;
  $('my-break-details').open = false;
  $('my-break-name').textContent = '';
  $('my-break-message').textContent = '';
  $('my-break-slots').replaceChildren();
  $('my-break-reminders').open = false;
  syncReminders();
}

$('my-break-retry').addEventListener('click', () => {
  $('my-break-message').textContent = 'Mola planı yükleniyor…';
  refresh();
});
setInterval(tick, 1000);
setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    tick();
    refresh();
  }
});
