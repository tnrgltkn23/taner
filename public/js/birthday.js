// Doğum günü banner'ı + konfeti (sitenin mor/turkuaz/altın renkleri)
const box = document.getElementById('birthday');
const r = await fetch('/api/birthdays').then((x) => x.json()).catch(() => ({ names: [] }));
if (box && r.names?.length) {
  box.querySelector('.bd-names').textContent = r.names.join(' · ');
  box.hidden = false;
  const c = document.createElement('canvas'); c.className = 'confetti'; document.body.appendChild(c);
  const ctx = c.getContext('2d'); const colors = ['#8b3dff', '#b98cff', '#52baaa', '#ffd34d', '#ff7ab6', '#ffffff'];
  let parts = []; const size = () => { c.width = innerWidth; c.height = innerHeight; }; size(); addEventListener('resize', size);
  const burst = () => {
    const x = innerWidth * (0.2 + Math.random() * 0.6), y = innerHeight * (0.15 + Math.random() * 0.35);
    for (let i = 0; i < 90; i++) {
      const a = Math.random() * Math.PI * 2, v = 4 + Math.random() * 7;
      parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 3, w: 5 + Math.random() * 6, h: 8 + Math.random() * 8, r: Math.random() * 6, vr: (Math.random() - .5) * .3, c: colors[i % colors.length], life: 160 });
    }
  };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce) {
    burst(); setTimeout(burst, 500); setInterval(burst, 3500);
    (function tick() {
      ctx.clearRect(0, 0, c.width, c.height);
      parts = parts.filter((p) => p.life-- > 0 && p.y < c.height + 20);
      for (const p of parts) {
        p.vy += 0.15; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.globalAlpha = Math.min(1, p.life / 40);
        ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
      }
      requestAnimationFrame(tick);
    })();
  }
}
