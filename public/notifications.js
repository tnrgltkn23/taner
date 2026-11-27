import {reminderEvents,dueReminders} from './reminder-time.js';
let context=null,signature='',notBefore=Date.now(),busy=false;
const supported=()=>isSecureContext&&'Notification'in window&&'serviceWorker'in navigator;
const enabled=()=>supported()&&Notification.permission==='granted'&&localStorage.getItem('uzman-notifications')!=='off';
const registration=supported()?navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).catch(()=>null):Promise.resolve(null);
const readSent=()=>{try{return JSON.parse(localStorage.getItem('uzman-reminders-sent')||'[]')}catch{return []}};
export function setReminderContext(next){const key=JSON.stringify(next);if(key!==signature){signature=key;context=next;notBefore=Date.now();}updateUI();}
export async function enableNotifications(explicit=true){
 if(!supported()){updateUI('Bu tarayıcı bildirimleri desteklemiyor.');return false;}
 if(!explicit&&localStorage.getItem('uzman-notifications')==='off')return false;
 try{const result=Notification.permission==='default'?await Notification.requestPermission():Notification.permission;if(result==='granted'){localStorage.setItem('uzman-notifications','on');updateUI();return true;}updateUI();return false;}catch{updateUI('Bildirim izni alınamadı. Tarayıcı site ayarlarını kontrol et.');return false;}
}
function updateUI(message){const status=document.getElementById('notification-status'),button=document.getElementById('notification-enable'),test=document.getElementById('notification-test');if(!status)return;
 status.textContent=message||(!supported()?'Bu tarayıcıda bildirim desteği yok. iPhone kullanıyorsan siteyi ana ekrana ekleyip oradan aç.':Notification.permission==='denied'?'Bildirim izni kapalı. Tarayıcının site ayarlarından izin ver.':enabled()?(context?.eligible&&context.employee?'Bildirimler açık · 5 dakika önce / bitişe 2 dakika kala.':'Bildirimler açık. Mola planın hazır olduğunda hatırlatıcılar çalışır.'):'Bildirimler kapalı. İzin vererek hatırlatıcılarını açabilirsin.');
 if(button)button.textContent=enabled()?'Bildirimleri kapat':'Bildirimleri aç';if(test)test.hidden=!enabled();
}
async function show(event){const reg=await registration;if(!reg)throw Error('Bildirim servisi hazır değil.');await reg.showNotification(event.title,{body:event.body,icon:'/img/uzman-logo-transparent.png',tag:event.id,data:{url:'/gunluk-verilerim/'},renotify:false});}
async function check(){if(busy||!enabled()||!context?.eligible||!context.employee)return;busy=true;
 const send=async()=>{
  if (!enabled() || !context?.eligible || !context.employee) return;
  const activeContext = context;
  const sent=readSent();const due=dueReminders(reminderEvents(context.employee,context.settings,context.date),Date.now(),notBefore,sent);for(const event of due){
   if (context !== activeContext) break;
   try{await show(event);sent.push(event.id);localStorage.setItem('uzman-reminders-sent',JSON.stringify(sent.slice(-160)));}catch{updateUI('Bildirim gönderilemedi. Tarayıcı izinlerini kontrol et.');}}};
 try{if(navigator.locks)await navigator.locks.request('uzman-reminder-send',send);else await send();}finally{busy=false;}
}
export function bindNotificationUI(){document.getElementById('notification-enable')?.addEventListener('click',async()=>{if(enabled()){localStorage.setItem('uzman-notifications','off');updateUI();}else await enableNotifications();});document.getElementById('notification-test')?.addEventListener('click',async()=>{try{await show({id:'uzman-test',title:'Mola bildirimleri hazır',body:'Başlangıçtan 5 dakika, bitişten 2 dakika önce haber vereceğiz.'});updateUI('Deneme bildirimi gönderildi.');}catch{updateUI('Bildirim gösterilemedi. Tarayıcı ve cihaz bildirim ayarlarını kontrol et.');}});updateUI();}
setInterval(check,15000);document.addEventListener('visibilitychange',()=>{if(!document.hidden){check();updateUI();}});addEventListener('storage',()=>updateUI());
