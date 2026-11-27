const hero = document.querySelector('.portal-hero');
const layer = hero.querySelector('.hero-precipitation');
const time = new Intl.DateTimeFormat('tr-TR', {timeZone:'Europe/Istanbul', hour:'2-digit', hourCycle:'h23'});
const conditions = new Set(['clear', 'cloudy', 'rain', 'snow', 'sleet']);
const refreshEvery = 5 * 60 * 1000;
let lastAttempt = -Infinity;

function setLight() {
  const hour = Number(time.format(new Date()));
  hero.dataset.light = hour >= 9 && hour < 17 ? 'day' : 'night';
}

function drawPrecipitation(condition) {
  layer.replaceChildren();
  if (!['rain', 'snow', 'sleet'].includes(condition)) return;
  const count = matchMedia('(max-width: 760px)').matches ? 12 : 22;
  for (let index = 0; index < count; index++) {
    const drop = document.createElement('i');
    const snow = condition === 'snow' || (condition === 'sleet' && index % 2 === 0);
    drop.className = snow ? 'hero-flake' : 'hero-drop';
    drop.style.setProperty('--x', ((index * 37 + 9) % 101) + '%');
    drop.style.setProperty('--y', ((index * 23 + 7) % 94) + '%');
    drop.style.setProperty('--scale', String(.62 + (index % 5) * .15));
    drop.style.setProperty('--delay', -(index % 11) * (snow ? .8 : .14) + 's');
    drop.style.setProperty('--duration', (snow ? 6 + index % 5 : 1 + (index % 5) * .21) + 's');
    layer.append(drop);
  }
}

function setWeather(condition, windy = false) {
  hero.dataset.treeSway = windy || ['rain', 'snow', 'sleet'].includes(condition) ? 'on' : 'off';
  if (hero.dataset.weather === condition) return;
  hero.dataset.weather = condition;
  drawPrecipitation(condition);
}

async function refresh() {
  setLight();
  if (document.hidden || Date.now() - lastAttempt < refreshEvery) return;
  lastAttempt = Date.now();
  try {
    const response = await fetch('/api/weather/elazig');
    if (!response.ok) throw new Error('Weather unavailable');
    const {condition, windy} = await response.json();
    setWeather(conditions.has(condition) ? condition : 'unknown', windy === true);
  } catch {
    setWeather('unknown');
  }
}

refresh();
setInterval(refresh, 15000);
document.addEventListener('visibilitychange', refresh);
