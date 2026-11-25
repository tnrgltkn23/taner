import {
  requireSession, logout, unwrap, ITEMS, itemLabel, emptyTotals, rates, pct, rateClass, istanbulToday, fmtShort,
  fmtLong, esc, toast, modal, debounce, showEnvBadge, setLive, setupTabs,
} from './common.js';

const $ = (id) => document.getElementById(id);
const ctx = await requireSession('expert');
if (!ctx) await new Promise(() => {}); // yönlendirme sürerken dur
const { client, user, session } = ctx;

$('who').textContent = user.username;
$('logout').addEventListener('click', logout);
showEnvBadge($('env'));

let tab = 'daily';
let day = istanbulToday();
let settings = { postpre_target: 0.65, savedesk_target: 0.75, maintenance: false };
let totals = emptyTotals();
const busy = new Set();

// ---------------------------------------------------------------- Günlük skor
function counterHtml(it) {
  return `<div class="counter">
    <div class="name">${esc(it.label)}</div>
    <div class="value num" id="v-${it.code}">0</div>
    <button class="btn green" data-add="${it.code}">Ekle</button>
  </div>`;
}
$('g-pp').innerHTML = ITEMS.filter((i) => i.group === 'pp').map(counterHtml).join('')
  + '<div class="rate-box" id="r-pp"><span class="lbl">Post Pre %</span><span class="val">—</span></div>';
$('g-sd').innerHTML = ITEMS.filter((i) => i.group === 'sd').map(counterHtml).join('')
  + '<div class="rate-box" id="r-sd"><span class="lbl">Savedesk %</span><span class="val">—</span></div>';

function renderDaily() {
  $('target-title').textContent = `${fmtShort(day)} Tarihinin Hedefi`;
  $('t-pp').textContent = pct(Number(settings.postpre_target));
  $('t-sd').textContent = pct(Number(settings.savedesk_target));
  for (const it of ITEMS) $(`v-${it.code}`).textContent = totals[it.code];
  const r = rates(totals);
  for (const [key, val, target] of [['pp', r.pp, Number(settings.postpre_target)], ['sd', r.sd, Number(settings.savedesk_target)]]) {
    const box = $(`r-${key}`);
    box.className = `rate-box ${rateClass(val, target)}`;
    box.querySelector('.val').textContent = pct(val);
  }
  document.querySelectorAll('[data-add]').forEach((b) => { b.disabled = busy.has(b.dataset.add) || settings.maintenance; });
}

async function loadSettings() {
  settings = unwrap(await client.from('settings').select('postpre_target, savedesk_target, maintenance').eq('id', 1).single());
  $('maint').classList.toggle('hidden', !settings.maintenance);
}

async function loadDaily() {
  day = istanbulToday();
  const rows = unwrap(await client.rpc('day_totals', { p_from: day, p_to: day, p_user: user.id }));
  totals = emptyTotals();
  for (const r of rows) totals[r.item] = Number(r.total);
  renderDaily();
}

// GSM alanı: yalnızca rakam, 10 hane
const gsmInput = $('gsm');
gsmInput.addEventListener('input', () => {
  gsmInput.value = gsmInput.value.replace(/\D/g, '').slice(0, 10);
  gsmInput.classList.remove('invalid');
});

async function addEntry(item, force = false) {
  const gsm = gsmInput.value;
  if (!/^\d{10}$/.test(gsm)) {
    gsmInput.classList.add('invalid');
    gsmInput.focus();
    toast('Adet eklemek için 10 haneli GSM numarası girmelisiniz', 'error');
    return;
  }
  busy.add(item); renderDaily();
  try {
    const res = unwrap(await client.rpc('add_entry', { p_item: item, p_gsm: gsm, p_force: force }));
    if (res.status === 'duplicate') {
      busy.delete(item); renderDaily();
      const yes = await modal({
        title: 'Aynı GSM numarası',
        message: `${gsm} numarası üzerinden bugün kayıt eklediniz. Tekrar eklemek istediğinize emin misiniz?`,
        ok: 'Evet', cancel: 'Hayır',
      });
      if (yes) return await addEntry(item, true);
      return;
    }
    totals[item] += 1;
    gsmInput.value = '';
    showUndo(res.id, item, gsm);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    busy.delete(item);
    renderDaily();
    loadDaily().catch(() => {});
  }
}

// 10 saniyelik geri alma
function showUndo(id, item, gsm) {
  const until = Date.now() + 10_000;
  const t = toast(`${itemLabel(item)} eklendi · ${gsm}`, 'success', {
    ms: 0,
    action: {
      label: 'Geri al (10)',
      onClick: async (btn, el) => {
        btn.disabled = true;
        const { error } = await client.rpc('undo_entry', { p_id: id });
        el.remove();
        if (error) toast(error.message, 'error'); else toast('Kayıt geri alındı');
        loadDaily().catch(() => {});
      },
    },
  });
  const btn = t.querySelector('button');
  const timer = setInterval(() => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0 || !t.isConnected) { clearInterval(timer); t.remove(); return; }
    btn.textContent = `Geri al (${left})`;
  }, 250);
}

document.querySelector('.groups').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-add]');
  if (b && !b.disabled) addEntry(b.dataset.add);
});

// ---------------------------------------------------------------- Geçmiş skorlarım
$('h-day').value = day;
$('h-day').max = day;
$('h-day').addEventListener('change', () => loadHistory().catch((e) => toast(e.message, 'error')));

async function loadHistory() {
  const d = $('h-day').value || istanbulToday();
  $('h-title').textContent = fmtLong(d);
  const rows = unwrap(await client.from('entries').select('item, gsm, delta, source, created_at')
    .eq('user_id', user.id).eq('day', d).is('deleted_at', null).order('created_at'));
  const t = emptyTotals();
  const gsms = Object.fromEntries(ITEMS.map((i) => [i.code, []]));
  for (const r of rows) {
    t[r.item] += r.delta;
    if (r.source === 'user') gsms[r.item].push(r.gsm);
  }
  $('h-table').innerHTML = `<thead><tr>${ITEMS.map((i) => `<th>${esc(i.label)}</th>`).join('')}</tr></thead>
    <tbody>
      <tr class="total">${ITEMS.map((i) => `<td class="num">${t[i.code]}</td>`).join('')}</tr>
      <tr>${ITEMS.map((i) => `<td style="vertical-align:top"><div class="gsm-list">${
        gsms[i.code].length ? gsms[i.code].map((g) => esc(g || '(silindi)')).join('<br>') : '<span class="muted">—</span>'
      }</div></td>`).join('')}</tr>
    </tbody>`;
}

// ---------------------------------------------------------------- Mini yarışma duyurusu
// Başlangıç saatinde açık ekranlara 10 saniyelik duyuru çıkar; yarışma sürerken giriş yapan
// uzmana da bir kez gösterilir (tarayıcı başına, localStorage ile).
const contestTimers = new Map();
const popQueue = [];
let popOpen = false;
const shownKey = (id) => `uht-contest-${id}`;

function showNextPop() {
  if (popOpen || !popQueue.length) return;
  const c = popQueue.shift();
  popOpen = true;
  try { localStorage.setItem(shownKey(c.id), '1'); } catch { /* yok say */ }
  const back = document.createElement('div');
  back.className = 'contest-pop';
  back.setAttribute('role', 'alertdialog');
  back.innerHTML = `<div class="box"><div class="icon">🏆</div><h2>Mini yarışma başladı!</h2><p>${esc(c.message)}</p>
    <button class="btn green" type="button">Tamam</button><div class="bar"><i></i></div></div>`;
  const close = () => { if (!back.isConnected) return; back.remove(); popOpen = false; showNextPop(); };
  back.querySelector('button').addEventListener('click', close);
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.body.appendChild(back);
  setTimeout(close, 10_000);
}

async function fireContest(id) {
  contestTimers.delete(id);
  // İptal edilmiş olabilir: göstermeden önce yeniden kontrol et
  const { data } = await client.from('contests').select('id, message, starts_at, ends_at').eq('id', id).maybeSingle();
  if (!data || Date.parse(data.ends_at) <= Date.now()) return;
  try { if (localStorage.getItem(shownKey(id))) return; } catch { /* yok say */ }
  popQueue.push(data);
  showNextPop();
}

async function loadContests() {
  const rows = unwrap(await client.from('contests').select('id, starts_at, ends_at')
    .gt('ends_at', new Date().toISOString()).order('starts_at').limit(20));
  const seen = new Set(rows.map((r) => r.id));
  for (const [id, t] of contestTimers) if (!seen.has(id)) { clearTimeout(t); contestTimers.delete(id); }
  for (const c of rows) {
    let shown = false;
    try { shown = Boolean(localStorage.getItem(shownKey(c.id))); } catch { /* yok say */ }
    if (shown || contestTimers.has(c.id)) continue;
    const wait = Date.parse(c.starts_at) - Date.now();
    if (wait <= 0) fireContest(c.id);
    else if (wait < 24 * 3600_000) contestTimers.set(c.id, setTimeout(() => fireContest(c.id), wait));
  }
}

// ---------------------------------------------------------------- Sekmeler ve senkronizasyon
setupTabs($('nav'), (t) => { tab = t; refresh(); });
const refresh = debounce(async () => {
  try {
    await loadSettings();
    if (tab === 'daily') await loadDaily(); else await loadHistory();
  } catch (e) { toast(e.message, 'error'); }
}, 200);

await client.realtime.setAuth(session.access_token);
client.channel(`uzman-${user.id}`)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'entries', filter: `user_id=eq.${user.id}` }, refresh)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, refresh)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'contests' }, () => loadContests().catch(() => {}))
  .subscribe((status) => { setLive($('live'), status); if (status === 'SUBSCRIBED') refresh(); });

setInterval(() => { if (istanbulToday() !== day) { $('h-day').max = istanbulToday(); refresh(); } }, 30_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); loadContests().catch(() => {}); } });

await Promise.all([loadSettings(), loadDaily()]);
loadContests().catch(() => {});
