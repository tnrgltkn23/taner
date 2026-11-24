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
