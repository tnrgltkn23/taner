const toggle = document.querySelector('.portal-menu-toggle');
const menu = document.getElementById('home-navigation');
const mobile = matchMedia('(max-width: 760px)');

const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';
function setOpen(open) {
  toggle.setAttribute('aria-expanded', String(open));
}

toggle.addEventListener('click', () => setOpen(!isOpen()));
menu.addEventListener('click', event => {
  if (mobile.matches && event.target.closest('a')) setOpen(false);
});
document.addEventListener('click', event => {
  if (isOpen() && !toggle.contains(event.target) && !menu.contains(event.target)) setOpen(false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && isOpen()) {
    setOpen(false);
    toggle.focus();
  }
});
mobile.addEventListener('change', () => setOpen(false));
