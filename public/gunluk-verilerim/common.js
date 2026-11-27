export const $ = id => document.getElementById(id);
export const escape = value => String(value ?? '').replace(/[&<>"']/g,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export const number = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 });
export const pct = value => value === null ? '—' : '%' + number.format(value);
export const groups = { pp: 'Post Pre', sd: 'Savedesk' };
const time = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', timeStyle: 'short' });
const date = new Intl.DateTimeFormat('tr-TR', { timeZone: 'UTC', dateStyle: 'long' });
export const dateText = day => date.format(new Date(day + 'T12:00:00Z'));

export function status(message = '', error = false) {
  $('status').textContent = message;
  $('status').dataset.error = String(error);
}
export async function api(route, data, { timeout = 10000 } = {}) {
  const signal = AbortSignal.timeout(timeout);
  const options = { signal };
  if (data !== undefined) Object.assign(options, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  let response, result;
  try {
    response = await fetch('/api/daily/' + route, options);
    result = await response.json();
  } catch (error) {
    if (signal.aborted) throw new Error('Sunucu zamanında yanıt vermedi. Tekrar deneyin.');
    throw error;
  }
  if (!response.ok && !result.duplicate) {
    const error = new Error(result.error || 'İşlem tamamlanamadı.');
    error.status = response.status;
    throw error;
  }
  return result;
}
export function totalsFor(items, entries) {
  const totals = Object.fromEntries(items.map(({ code }) => [code, 0]));
  for (const entry of entries) totals[entry.item] += entry.delta ?? entry.total;
  return totals;
}
export function rates(totals) {
  const postPre = totals.pp_ikna + totals.pp_gecis + totals.pp_14271;
  const savedesk = totals.sd_ikna + totals.sd_iptal + totals.sd_17891;
  return {
    pp: postPre ? totals.pp_ikna / postPre * 100 : null,
    sd: savedesk ? totals.sd_ikna / savedesk * 100 : null,
  };
}
export function gsmText(gsm) {
  return gsm ? gsm.replace(/^(\d{3})(\d{3})(\d{2})(\d{2})$/, '$1 $2 $3 $4') : '—';
}
export function recordTable(entries, items, editable = false) {
  if (!entries.length) return '<p class="daily-hint">Bu tarih için kayıt yok.</p>';
  const labels = Object.fromEntries(items.map(({ code, label }) => [code, label]));
  return '<div class="daily-table-wrap"><table class="daily-table"><thead><tr><th scope="col">Saat</th>' +
    '<th scope="col">Kalem</th><th scope="col">GSM</th><th scope="col">Adet</th>' +
    (editable ? '<th scope="col">İşlem</th>' : '') + '</tr></thead><tbody>' +
    entries.map(entry => '<tr><td>' + time.format(entry.createdAt) + '</td><td>' + escape(labels[entry.item]) +
      '</td><td>' + escape(gsmText(entry.gsm)) + '</td><td>' + escape(entry.delta) + '</td>' +
      (editable ? '<td>' + (entry.source === 'expert' ? '<button type="button" class="button secondary" data-remove="' +
        escape(entry.id) + '">Sil</button>' : 'Düzeltme') + '</td>' : '') + '</tr>').join('') + '</tbody></table></div>';
}
