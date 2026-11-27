// KPI Performans sayfasının verisi (salt okunur): /api/kpi/public/{bootstrap,history,shifts,history/<id>}
import { adminClient, UUID_RE } from './_lib/core.js';

export default async function kpi(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Yöntem desteklenmiyor' });
  const r = String(req.query.r || '').replace(/^\/+|\/+$/g, '');
  let key = null;
  if (r === 'public/bootstrap') key = 'bootstrap';
  else if (r === 'public/history') key = 'history';
  else if (r === 'public/shifts') key = 'shifts';
  else { const m = r.match(/^public\/history\/(.+)$/); if (m && UUID_RE.test(m[1])) key = 'version:' + m[1]; }
  if (!key) return res.status(404).json({ error: 'KPI işlemi bulunamadı.' });
  try {
    const { data, error } = await adminClient().from('kpi_snapshot').select('data').eq('key', key).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'KPI verisi bulunamadı.' });
    return res.status(200).json(data.data);
  } catch (e) {
    console.error('kpi', e);
    return res.status(500).json({ error: 'KPI verisi alınamadı.' });
  }
}
