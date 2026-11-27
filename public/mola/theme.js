const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
function enter(panel){if(reduced||panel.hidden||document.hidden)return;const items=panel.matches('#workspace')?[panel.querySelector('.admin-title'),panel.querySelector('.admin-nav')]:[panel];items.filter(Boolean).forEach((item,i)=>{item.getAnimations().forEach(a=>a.cancel());item.animate([{opacity:.35,transform:'translateY(12px)'},{opacity:1,transform:'translateY(0)'}],{duration:320,delay:i*45,easing:'cubic-bezier(.2,.65,.3,1)'});});}
for(const panel of document.querySelectorAll('#workspace,#admin-login,[role=tabpanel]'))new MutationObserver(()=>enter(panel)).observe(panel,{attributes:true,attributeFilter:['hidden']});
const login=document.getElementById('admin-login');enter(login);
const tabs=[...document.querySelectorAll('[data-panel]')];
for(const tab of tabs)tab.addEventListener('keydown',event=>{let i=tabs.indexOf(tab),next;if(event.key==='ArrowRight')next=tabs[(i+1)%tabs.length];if(event.key==='ArrowLeft')next=tabs[(i+tabs.length-1)%tabs.length];if(event.key==='Home')next=tabs[0];if(event.key==='End')next=tabs.at(-1);if(next){event.preventDefault();next.focus();next.click();}});
