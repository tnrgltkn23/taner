// Resmi rapor (Churn Aktivite Excel'i) — tarayıcıda okunur, kişi × gün × kalem toplamlarına indirgenir.
// Dosyanın kendisi sunucuya gönderilmez; yalnızca bu toplamlar gönderilir.
//
// Eşleştirme (26.11.2026 verisiyle doğrulandı):
//   484 İkna    → "PostPre Data", Triplet 484, Başvuru Sonucu "İkna Edildi", Kapatan User, Closed Date
//   484 Geçiş   → "PostPre Data", Triplet 484, Başvuru Sonucu "Faturasıza Geçiş…", Kapatan User, Closed Date
//   14271       → "Acln Pusula", SR Vf Triplet No 14271 (açılan kayıt), SR Created By User, SR Open Date
//   16234 İkna  → "Savedesk Data", Başvuru Sonucu "İkna Edildi", Kapatan User, Closed Date
//   16234 İptal → "Savedesk Data", Başvuru Sonucu "İptal" / "Vefat/İptal", Kapatan User, Closed Date
//   17891       → "Acln Pusula", SR Vf Triplet No 17891 (açılan kayıt), SR Created By User, SR Open Date
import { ITEMS, rates } from './common.js';

const norm = (s) => String(s ?? '').trim().toLocaleLowerCase('tr').normalize('NFD').replace(/\p{M}/gu, '').replace(/ı/g, 'i');

export function loadSheetJs() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/xlsx.full.min.js?v=0.20.3';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('Excel okuyucu yüklenemedi'));
    document.head.appendChild(s);
  });
}

// Başlık satırını (ör. "SR Number") bul, sütunları ada göre eşle
function table(XLSX, wb, sheetName, mustHave) {
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Raporda "${sheetName}" sayfası yok`);
  // raw: tarih hücreleri Date nesnesi olarak gelir (biçimlendirmeden bağımsız)
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false });
  const hi = rows.findIndex((r) => r.some((c) => norm(c) === norm(mustHave)));
  if (hi < 0) throw new Error(`"${sheetName}" sayfasında "${mustHave}" başlığı bulunamadı`);
  const idx = {};
  rows[hi].forEach((c, i) => { if (c != null && idx[norm(c)] === undefined) idx[norm(c)] = i; });
  const col = (name) => {
    const i = idx[norm(name)];
    if (i === undefined) throw new Error(`"${sheetName}" sayfasında "${name}" sütunu yok`);
    return i;
  };
  return { rows: rows.slice(hi + 1), col };
}

// Tarih hücresi: "2026-11-26 13:45:00" veya Excel'in gösterdiği başka biçimler → "YYYY-MM-DD"
function dayOf(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    // SheetJS Excel tarihini yerel saatle kurar; yerel bileşenler Excel'deki günü verir
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

export async function parseChurnReport(file) {
  const XLSX = await loadSheetJs();
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  const counts = new Map(); // "gün|kullanıcı|kalem" → adet
  const add = (day, user, item) => {
    if (!day || !user) return;
    const k = `${day}|${norm(user)}|${item}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  };

  const pp = table(XLSX, wb, 'PostPre Data', 'Sr Number');
  const [ppT, ppU, ppD, ppR] = [pp.col('Triplet No'), pp.col('Kapatan User'), pp.col('Closed Date'), pp.col('Başvuru Sonucu')];
  for (const r of pp.rows) {
    if (String(r[ppT] ?? '').trim() !== '484') continue;
    const res = norm(r[ppR]);
    if (res === 'ikna edildi') add(dayOf(r[ppD]), r[ppU], 'pp_ikna');
    else if (res.startsWith('faturas')) add(dayOf(r[ppD]), r[ppU], 'pp_gecis'); // "Faturasıza Geçiş-Anlık / İleri Tarihli"
  }

  const sd = table(XLSX, wb, 'Savedesk Data', 'SR Number');
  const [sdU, sdD, sdR] = [sd.col('Kapatan User'), sd.col('Closed Date'), sd.col('Başvuru Sonucu')];
  for (const r of sd.rows) {
    const res = norm(r[sdR]);
    if (res === 'ikna edildi') add(dayOf(r[sdD]), r[sdU], 'sd_ikna');
    else if (res === 'iptal' || res === 'vefat/iptal') add(dayOf(r[sdD]), r[sdU], 'sd_iptal');
  }

  const ac = table(XLSX, wb, 'Acln Pusula', 'SR Number');
  const [acT, acU, acD] = [ac.col('SR Vf Triplet No'), ac.col('SR Created By User'), ac.col('SR Open Date')];
  for (const r of ac.rows) {
    const t = String(r[acT] ?? '').trim();
    if (t === '14271') add(dayOf(r[acD]), r[acU], 'pp_14271');
    else if (t === '17891') add(dayOf(r[acD]), r[acU], 'sd_17891');
  }

  const rows = [...counts].map(([k, total]) => { const [day, username, item] = k.split('|'); return { day, username, item, total }; });
  const days = [...new Set(rows.map((r) => r.day))].sort();
  return { rows, days };
}

// ---- Karşılaştırma hesapları
export const iknaOf = (t) => t.pp_ikna + t.sd_ikna;

// Uyum puanı: resmi işlemlerin ne kadarının doğru kalemde girildiği (100 = birebir aynı)
export function agreement(site, off) {
  let diff = 0; let base = 0; let siteSum = 0;
  for (const i of ITEMS) { diff += Math.abs(site[i.code] - off[i.code]); base += off[i.code]; siteSum += site[i.code]; }
  const denom = Math.max(base, siteSum);
  return denom ? Math.max(0, 1 - diff / denom) : null;
}

// Davranış işaretleri
export function flags(site, off) {
  const out = [];
  const missing = ITEMS.reduce((s, i) => s + Math.max(0, off[i.code] - site[i.code]), 0);
  const offSum = ITEMS.reduce((s, i) => s + off[i.code], 0);
  const negSite = site.pp_14271 + site.sd_17891 + site.pp_gecis + site.sd_iptal;
  const negOff = off.pp_14271 + off.sd_17891 + off.pp_gecis + off.sd_iptal;
  if (offSum && missing / offSum >= 0.2) out.push(['red', 'Eksik giriş']);
  if (negOff - negSite >= 3 && (negOff - negSite) / negOff >= 0.3) out.push(['red', 'Olumsuzlar eksik']);
  if (site.pp_gecis - off.pp_gecis >= 3 && off.pp_14271 - site.pp_14271 >= 3) out.push(['amber', 'Geçiş ↔ 14271 karışıyor']);
  const rs = rates(site); const ro = rates(off);
  if ((rs.pp !== null && ro.pp !== null && rs.pp - ro.pp >= 0.05) || (rs.sd !== null && ro.sd !== null && rs.sd - ro.sd >= 0.05)) out.push(['amber', 'Oran resmiden yüksek']);
  if (!offSum && ITEMS.some((i) => site[i.code])) out.push(['gray', 'Resmide kaydı yok']);
  return out;
}
