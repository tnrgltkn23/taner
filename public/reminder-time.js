import {scheduleFor} from './plan-time.js';
export function reminderEvents(employee,settings,date){
 if(!employee||!/^\d{4}-\d{2}-\d{2}$/.test(date||''))return [];
 const midnight=Date.parse(date+'T00:00:00+03:00');
 return scheduleFor(employee,settings).flatMap(s=>[
 {id:`${date}|${employee.name}|${s.start}|before`,at:midnight+(s.start-5)*60000,title:'Molana 5 dakika kaldı',body:`${employee.name} · ${s.label} ${formatTime(s.time)} saatinde başlıyor.`},
 {id:`${date}|${employee.name}|${s.start}|ending`,at:midnight+(s.start+s.duration-2)*60000,title:'Molanın bitmesine 2 dakika kaldı',body:`${employee.name} · ${s.label} ${formatTime(s.time+s.duration)} saatinde bitiyor.`}
 ]);
}
export function formatTime(n){return `${String(Math.floor(n/60)%24).padStart(2,'0')}:${String(Math.floor(n%60)).padStart(2,'0')}`;}
export function dueReminders(events,now,notBefore,sent=[]){return events.filter(e=>e.at>=notBefore&&e.at<=now&&now-e.at<60000&&!sent.includes(e.id));}
