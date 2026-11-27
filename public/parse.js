// Mola planı Excel/CSV dosyasını okur. Tarayıcıda ve Node'da (test) aynı kod çalışır;
// SheetJS (XLSX) dışarıdan verilir.

export const BREAK_COUNT = 7;
export const DEFAULT_BREAK_MIN = 10;
export const DEFAULT_LUNCH_MIN = 30;

// "Yemek (30 dk)" -> "yemek30dk", "1. Mola" -> "1mola"
export function norm(value) {
  return String(value ?? "")
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i").replace(/ğ/g, "g").replace(/ü/g, "u")
    .replace(/ş/g, "s").replace(/ö/g, "o").replace(/ç/g, "c")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

// Excel saat değeri (gün kesri, Date ya da "10:25") -> gün içi dakika (0-1439) veya null
export function toMinutes(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value.getHours() * 60 + value.getMinutes();
  if (typeof value === "number") {
    if (!isFinite(value) || value < 0) return null;
    const frac = value - Math.floor(value);
    return Math.round(frac * 1440) % 1440;
  }
  const m = String(value).trim().match(/^(\d{1,2})[:.](\d{2})(?:[:.]\d{2})?$/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return (h * 60 + min) % 1440;
}

// Vardiya kodu yedek çözümü: 918 -> 09:00-18:00, 1300 -> 13:00-00:00
export function shiftFromCode(code) {
  const s = String(code ?? "").trim();
  if (!/^\d{3,4}$/.test(s)) return null;
  const start = Number(s.slice(0, s.length - 2));
  const end = Number(s.slice(-2));
  if (start > 23 || end > 24) return null;
  return { start: start * 60, end: (end % 24) * 60 };
}

function sheetRows(XLSX, ws) {
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
}

function findSheet(wb, name) {
  const key = wb.SheetNames.find((n) => norm(n) === norm(name));
  return key ? wb.Sheets[key] : null;
}

function findHeaderRow(rows, test, limit = 30) {
  for (let i = 0; i < Math.min(rows.length, limit); i++) {
    if ((rows[i] || []).some((c) => test(norm(c)))) return i;
  }
  return -1;
}

const NAME_KEYS = ["personel", "personeladi", "adsoyad", "adisoyadi", "calisan", "isim", "ad"];

function mapColumns(header) {
  const cols = { name: -1, code: -1, start: -1, end: -1, lunch: -1, breaks: Array(BREAK_COUNT).fill(-1) };
  header.forEach((cell, i) => {
    const h = norm(cell);
    if (!h) return;
    if (cols.name < 0 && NAME_KEYS.includes(h)) cols.name = i;
    else if (cols.code < 0 && (h === "vardiyakodu" || h === "vardiya" || h === "kod")) cols.code = i;
    else if (cols.start < 0 && h.startsWith("baslangic")) cols.start = i;
    else if (cols.end < 0 && h.startsWith("bitis")) cols.end = i;
    else if (cols.lunch < 0 && h.startsWith("yemek")) cols.lunch = i;
    else {
      const m = h.match(/^(\d)mola/);
      if (m) {
        const n = Number(m[1]);
        if (n >= 1 && n <= BREAK_COUNT && cols.breaks[n - 1] < 0) cols.breaks[n - 1] = i;
      }
    }
  });
  return cols;
}

function readShiftTable(XLSX, wb) {
  const ws = findSheet(wb, "Vardiyalar");
  const map = new Map();
  if (!ws) return map;
  const rows = sheetRows(XLSX, ws);
  const hi = findHeaderRow(rows, (h) => h === "kod");
  if (hi < 0) return map;
  const header = rows[hi].map(norm);
  const ci = header.indexOf("kod");
  const si = header.findIndex((h) => h.startsWith("baslangic"));
  const ei = header.findIndex((h) => h.startsWith("bitis"));
  if (si < 0 || ei < 0) return map;
  for (const row of rows.slice(hi + 1)) {
    const code = row?.[ci];
    if (code === null || code === undefined || code === "") continue;
    const start = toMinutes(row[si]);
    const end = toMinutes(row[ei]);
    if (start !== null && end !== null) map.set(String(code).trim(), { start, end });
  }
  return map;
}

function readSettings(XLSX, wb) {
  const settings = { breakMin: DEFAULT_BREAK_MIN, lunchMin: DEFAULT_LUNCH_MIN };
  const ws = findSheet(wb, "Ayarlar");
  if (!ws) return settings;
  for (const row of sheetRows(XLSX, ws)) {
    if (!row) continue;
    const li = row.findIndex((c) => typeof c === "string" && c.trim());
    if (li < 0) continue;
    const label = norm(row[li]);
    const num = row.slice(li + 1).find((c) => typeof c === "number");
    if (typeof num !== "number" || num <= 0 || num > 180) continue;
    if (label.startsWith("molasuresi")) settings.breakMin = Math.round(num);
    else if (label.startsWith("yemeksuresi")) settings.lunchMin = Math.round(num);
  }
  return settings;
}

// Çalışma kitabını okur: { employees, settings, warnings }
export function parseWorkbook(XLSX, wb) {
  const warnings = [];
  const planSheet = findSheet(wb, "Plan") || wb.Sheets[wb.SheetNames[0]];
  const rows = sheetRows(XLSX, planSheet);
  const hi = findHeaderRow(rows, (h) => NAME_KEYS.includes(h));
  if (hi < 0) throw new Error("Plan sayfasında 'Personel' başlığı bulunamadı.");

  const cols = mapColumns(rows[hi]);
  if (!cols.breaks.some((i) => i >= 0) && cols.lunch < 0) {
    throw new Error("Plan sayfasında mola sütunları (1. Mola, Yemek…) bulunamadı.");
  }

  const shifts = readShiftTable(XLSX, wb);
  const settings = readSettings(XLSX, wb);
  const employees = [];

  for (const [offset, row] of rows.slice(hi + 1).entries()) {
    const rawName = row?.[cols.name];
    const name = typeof rawName === "string" || typeof rawName === "number" ? String(rawName).trim() : "";
    if (!name) continue;
    const line = hi + 2 + offset;

    const code = cols.code >= 0 ? row[cols.code] : null;
    const codeKey = code === null || code === undefined ? "" : String(code).trim();

    // Saat önceliği: Vardiyalar tablosu > satırdaki Başlangıç/Bitiş > koddan tahmin.
    // Excel'deki Başlangıç/Bitiş formülleri dosyada 00:00 olarak kayıtlı olabiliyor.
    let shift = shifts.get(codeKey) || null;
    if (!shift && cols.start >= 0 && cols.end >= 0) {
      const s = toMinutes(row[cols.start]), e = toMinutes(row[cols.end]);
      if (s !== null && e !== null && !(s === 0 && e === 0)) shift = { start: s, end: e };
    }
    if (!shift) shift = shiftFromCode(codeKey);
    if (!shift) warnings.push(`Satır ${line} (${name}): vardiya saati bulunamadı.`);

    const breaks = cols.breaks.map((i) => (i >= 0 ? toMinutes(row[i]) : null));
    const lunch = cols.lunch >= 0 ? toMinutes(row[cols.lunch]) : null;
    if (!breaks.some((b) => b !== null) && lunch === null) {
      warnings.push(`Satır ${line} (${name}): hiç mola saati yok.`);
    }

    employees.push({
      name,
      start: shift ? shift.start : null,
      end: shift ? shift.end : null,
      breaks,
      lunch,
    });
  }

  if (!employees.length) throw new Error("Planda hiç personel bulunamadı.");
  employees.sort((a, b) => a.name.localeCompare(b.name, "tr", { numeric: true, sensitivity: "base" }));
  return { employees, settings, warnings };
}
