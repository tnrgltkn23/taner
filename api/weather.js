// Elazığ hava durumu (MET Norway) — İkna Rehberi ve KPI sayfalarındaki hava efekti için
let forecast; let retryAt = 0;
export default async function weather(req, res) {
  const now = Date.now();
  if ((!forecast || now >= forecast.expires) && now >= retryAt) {
    try {
      const r = await fetch('https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=38.6744&lon=39.2228', { headers: { 'User-Agent': 'UzmanHedefTakip/1.0' }, signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error('weather');
      const series = (await r.json()).properties?.timeseries;
      if (!Array.isArray(series) || !series.length) throw new Error('weather');
      forecast = { series, expires: now + 10800_000 };
    } catch { retryAt = Date.now() + 300_000; }
  }
  const list = forecast?.series || [];
  const e = list.find((x) => { const s = Date.parse(x.time); return s <= now && now < s + 3600_000; }) || list.find((x) => { const s = Date.parse(x.time); return s > now && s - now <= 3600_000; });
  const sym = e?.data?.next_1_hours?.summary?.symbol_code;
  if (!sym) return res.status(503).json({ condition: null });
  let condition = 'cloudy';
  if (sym.includes('sleet')) condition = 'sleet'; else if (sym.includes('snow')) condition = 'snow';
  else if (sym.includes('rain') || sym.includes('thunder')) condition = 'rain'; else if (/^(clearsky|fair)_/.test(sym)) condition = 'clear';
  const wind = e.data.instant?.details?.wind_speed;
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).json({ condition, windy: Number.isFinite(wind) && wind >= 6 });
}
