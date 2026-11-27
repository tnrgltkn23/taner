// Vercel derlemesi: supabase-js tarayıcı paketini public/vendor altına kopyalar.
// Böylece istemci kodu üçüncü taraf CDN'e bağımlı olmaz.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  'node_modules/@supabase/supabase-js/dist/umd/supabase.js',
  'node_modules/@supabase/supabase-js/dist/umd/supabase.min.js',
];
const src = candidates.map((p) => join(root, p)).find((p) => existsSync(p));
if (!src) {
  console.error('supabase-js UMD paketi bulunamadı:', candidates.join(', '));
  process.exit(1);
}
const outDir = join(root, 'public', 'vendor');
mkdirSync(outDir, { recursive: true });
copyFileSync(src, join(outDir, 'supabase.js'));
console.log('supabase-js kopyalandı ->', join(outDir, 'supabase.js'));

// Resmi rapor (Excel) tarayıcıda okunur: SheetJS tam paketi public/vendor altına kopyalanır.
const xlsxSrc = join(root, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js');
if (!existsSync(xlsxSrc)) {
  console.error('SheetJS paketi bulunamadı:', xlsxSrc);
  process.exit(1);
}
copyFileSync(xlsxSrc, join(outDir, 'xlsx.full.min.js'));
console.log('SheetJS kopyalandı ->', join(outDir, 'xlsx.full.min.js'));

// Biçimli Excel çıktısı (renkli yazı, zemin, kenarlık) için ExcelJS tarayıcı paketi.
const excelSrc = join(root, 'node_modules', 'exceljs', 'dist', 'exceljs.min.js');
if (!existsSync(excelSrc)) {
  console.error('ExcelJS paketi bulunamadı:', excelSrc);
  process.exit(1);
}
copyFileSync(excelSrc, join(outDir, 'exceljs.min.js'));
console.log('ExcelJS kopyalandı ->', join(outDir, 'exceljs.min.js'));
