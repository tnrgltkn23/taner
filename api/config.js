// Tarayıcının ihtiyaç duyduğu GİZLİ OLMAYAN ayarlar (ortama göre değişir).
import { handler, HttpError, SUPABASE_URL, PUBLISHABLE_KEY } from './_lib/core.js';

export default handler(['GET'], async () => {
  const supabaseUrl = SUPABASE_URL();
  const publishableKey = PUBLISHABLE_KEY();
  if (!supabaseUrl || !publishableKey) throw new HttpError(500, 'Sunucu yapılandırması eksik');
  return {
    supabaseUrl,
    publishableKey,
    environment: process.env.VERCEL_ENV || 'development',
  };
});
