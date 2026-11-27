// Giriş ekranındaki doğum günü banner'ı: bugün (İstanbul) doğum günü olanların adları
import { adminClient } from './_lib/core.js';

export default async function birthdays(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=300');
  const [m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', month: '2-digit', day: '2-digit' }).format(new Date()).split('-').map(Number);
  const { data, error } = await adminClient().from('birthdays').select('name').eq('month', m).eq('day', d).order('name');
  if (error) return res.status(200).json({ names: [] });
  return res.status(200).json({ names: data.map((x) => x.name) });
}
