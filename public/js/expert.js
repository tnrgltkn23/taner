import {
  requireSession, logout, unwrap, istanbulToday, fmtDay, fmtTime, esc, rate, rateHtml, barHtml,
  toast, debounce, showEnvBadge, setLive,
} from './common.js';

const $ = (id) => document.getElementById(id);
const ctx = await requireSession('expert');
if (!ctx) throw new Error('yönlendiriliyor');
const { client, profile, session } = ctx;

$('who').textContent = profile.display_name;
$('logout').addEventListener('click', logout);
showEnvBadge($('env'));

let day = istanbulToday();
let state = { items: [], goals: [], mine: [], team: [], events: [] };
const busy = new Set();

async function load() {
  day = istanbulToday();
  const [items, goals, mine, team, events] = await Promise.all([
    client.from('counter_items').select('id, name, sort_order').eq('active', true).order('sort_order').order('id'),
    client.from('goals').select('scope, profile_id, item_id, daily_target'),
    client.from('daily_user_totals').select('item_id, total').eq('day', day).eq('profile_id', profile.id),
    client.from('daily_team_totals').select('item_id, total').eq('day', day),
    client.from('counter_events').select('id, item_id, created_at, undone_at')
      .eq('day', day).eq('profile_id', profile.id).order('created_at', { ascending: false }).limit(100),
  ]);
  state = {
    items: unwrap(items), goals: unwrap(goals), mine: unwrap(mine), team: unwrap(team), events: unwrap(events),
  };
  render();
}

function myTarget(itemId) {
  const own = state.goals.find((g) => g.scope === 'individual' && g.profile_id === profile.id && g.item_id === itemId);
  if (own) return own.daily_target;
  return state.goals.find((g) => g.scope === 'individual_default' && g.item_id === itemId)?.daily_target ?? 0;
}
const teamTarget = (itemId) => state.goals.find((g) => g.scope === 'team' && g.item_id === itemId)?.daily_target ?? 0;
const myTotal = (itemId) => state.mine.find((r) => r.item_id === itemId)?.total ?? 0;
const teamTotal = (itemId) => state.team.find((r) => r.item_id === itemId)?.total ?? 0;

function render() {
  $('today-title').textContent = fmtDay(day);

  if (!state.items.length) {
    $('items').innerHTML = '<div class="empty">Henüz sayaç kalemi tanımlanmamış. Yöneticiniz kalem eklediğinde burada görünecek.</div>';
  } else {
    $('items').innerHTML = state.items.map((it) => {
      const total = myTotal(it.id);
      const target = myTarget(it.id);
      const r = rate(total, target);
      return `<div class="card counter">
        <div class="row" style="justify-content:space-between"><span class="name">${esc(it.name)}</span>${rateHtml(r)}</div>
        <div class="value num">${total}<small> / ${target || '—'}</small></div>
        ${barHtml(r)}
        <button class="btn primary plus" data-item="${it.id}" ${busy.has(it.id) ? 'disabled' : ''}>+1</button>
      </div>`;
    }).join('');
  }

  const sumT = state.items.reduce((s, it) => s + myTotal(it.id), 0);
  const sumG = state.items.reduce((s, it) => s + myTarget(it.id), 0);
  const myR = rate(sumT, sumG);
  $('my-rate').innerHTML = myR === null ? '—' : rateHtml(myR);
  $('my-sum').textContent = `${sumT} / ${sumG || '—'} işlem`;

  // Ekip: yalnızca oran gösterilir; kişi bazlı bilgi yok
  const withTarget = state.items.filter((it) => teamTarget(it.id) > 0);
  const tT = withTarget.reduce((s, it) => s + teamTotal(it.id), 0);
  const tG = withTarget.reduce((s, it) => s + teamTarget(it.id), 0);
  const teamR = rate(tT, tG);
  $('team-rate').innerHTML = teamR === null ? '—' : rateHtml(teamR);
  $('team').innerHTML = withTarget.length
    ? withTarget.map((it) => {
      const r = rate(teamTotal(it.id), teamTarget(it.id));
      return `<div><div class="row" style="justify-content:space-between"><span>${esc(it.name)}</span>${rateHtml(r)}</div>${barHtml(r)}</div>`;
    }).join('')
    : '<div class="muted small">Ekip hedefi tanımlanmamış.</div>';

  const names = Object.fromEntries(state.items.map((i) => [i.id, i.name]));
  $('events').innerHTML = state.events.length
    ? state.events.map((e) => `<tr class="${e.undone_at ? 'undone' : ''}">
        <td class="num">${fmtTime(e.created_at)}</td>
        <td>${esc(names[e.item_id] || '—')}</td>
        <td class="no-strike">${e.undone_at ? '<span class="pill gray">Geri alındı</span>' : '<span class="pill green">Geçerli</span>'}</td>
        <td class="no-strike" style="text-align:right">${e.undone_at ? '' : `<button class="btn sm danger" data-undo="${e.id}">Geri al</button>`}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="empty">Bugün henüz işlem yok.</td></tr>';
}

// +1
$('items').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-item]');
  if (!btn) return;
  const itemId = Number(btn.dataset.item);
  if (busy.has(itemId)) return;
  busy.add(itemId);
  btn.disabled = true;
  // Anında geri bildirim; gerçek değer veritabanından gelir
  const row = state.mine.find((r) => r.item_id === itemId);
  if (row) row.total += 1; else state.mine.push({ item_id: itemId, total: 1 });
  render();
  try {
    const { error } = await client.rpc('record_event', { p_item: itemId });
    if (error) throw new Error(error.message);
  } catch (e) {
    toast(`İşlem kaydedilemedi: ${e.message}`, 'error');
  } finally {
    busy.delete(itemId);
    await load().catch(() => {});
  }
});

// Geri al
$('events').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-undo]');
  if (!btn) return;
  if (!confirm('Bu işlemi geri almak istiyor musunuz?')) return;
  btn.disabled = true;
  const { error } = await client.rpc('undo_my_event', { p_event: Number(btn.dataset.undo) });
  if (error) toast(error.message, 'error'); else toast('İşlem geri alındı', 'success');
  await load().catch(() => {});
});

// Gerçek zamanlı senkronizasyon (RLS: yalnızca kendi verisi + ekip toplamı gelir)
const refresh = debounce(() => load().catch((e) => toast(e.message, 'error')), 250);
await client.realtime.setAuth(session.access_token);
client.channel(`uzman-${profile.id}`)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'daily_user_totals', filter: `profile_id=eq.${profile.id}` }, refresh)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'counter_events', filter: `profile_id=eq.${profile.id}` }, refresh)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'daily_team_totals' }, refresh)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'goals' }, refresh)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'counter_items' }, refresh)
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${profile.id}` }, async (p) => {
    if (p.new && p.new.active === false) { toast('Hesabınız devre dışı bırakıldı', 'error'); setTimeout(logout, 1500); }
  })
  .subscribe((status) => { setLive($('live'), status); if (status === 'SUBSCRIBED') refresh(); });

// Gün değişimini (Europe/Istanbul) yakala, sekmeye dönünce tazele
setInterval(() => { if (istanbulToday() !== day) refresh(); }, 30_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

await load().catch((e) => toast(e.message, 'error'));
