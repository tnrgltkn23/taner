import {parseWorkbook} from '../parse.js';
import {planState,scheduleFor} from '../plan-time.js';
const $=id=>document.getElementById(id),node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const clock=()=>new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Istanbul',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date());
const fmt=n=>n==null?'—':`${String(Math.floor(n/60)%24).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;
const dateLabel=d=>new Intl.DateTimeFormat('tr-TR',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(d+'T12:00:00Z'));
const addDays=(d,n)=>{const v=new Date(d+'T12:00:00Z');v.setUTCDate(v.getUTCDate()+n);return v.toISOString().slice(0,10)};
const monday=d=>{const day=new Date(d+'T12:00:00Z').getUTCDay();return addDays(d,-((day+6)%7))};
let currentPlan=null,weekStart=monday(today()),queue=[],authenticated=false,lastMinute='',lastDate=today(),loadToken=0;
$('admin-date').value=today();$('upload-start').value=today();
async function api(path, options = {}) {
  const signal = AbortSignal.timeout(10000);
  try {
    const res = await fetch('/api/mola/' + path, {
      ...options, signal,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 401) showLogin();
      throw new Error(data.error || 'İşlem tamamlanamadı.');
    }
    return data;
  } catch (error) {
    if (signal.aborted) throw new Error('Sunucu zamanında yanıt vermedi. Tekrar deneyin.');
    throw error;
  }
}
const post=(path,body,method='POST')=>api(path,{method,body:JSON.stringify(body)});
function status(text){$('admin-status').textContent=text;}
function showLogin(){authenticated=false;$('admin-login').hidden=false;$('workspace').hidden=true;}
async function start(){authenticated=true;$('admin-login').hidden=true;$('workspace').hidden=false;const results = await Promise.allSettled([loadPlan(), loadWeek(), loadMaintenance()]);
const failure = results.find(result => result.status === 'rejected');
if (failure && authenticated) status(failure.reason.message);}
$('admin-login-form').onsubmit=async e=>{e.preventDefault();$('login-message').textContent='Giriş yapılıyor…';try{await post('admin/login',{password:$('login-password').value});$('login-password').value='';$('login-message').textContent='';await start();}catch(err){$('login-message').textContent=err.message;}};
$('admin-logout').onclick=async()=>{try{await post('admin/logout',{});showLogin();}catch(err){status(err.message);}};
for(const tab of document.querySelectorAll('[data-panel]'))tab.onclick=()=>{for(const t of document.querySelectorAll('[data-panel]'))t.setAttribute('aria-selected',String(t===tab));for(const panel of document.querySelectorAll('[role=tabpanel]'))panel.hidden=panel.id!=='panel-'+tab.dataset.panel;if(tab.dataset.panel==='stats')renderChart();if(tab.dataset.panel==='day-plan')renderDayPlan();};
$('admin-date').onchange=()=>{if(!$('admin-date').value)return;$('upload-start').value=$('admin-date').value;weekStart=monday($('admin-date').value);loadPlan().catch(e=>status(e.message));loadWeek().catch(e=>status(e.message));};
async function loadPlan(){const token=++loadToken;const selected=$('admin-date').value;const data=await api('admin/plans?date='+selected);if(token!==loadToken)return;currentPlan=data.plan;status(data.plan?`${dateLabel(selected)} · ${data.plan.employees.length} çalışan · ${data.filename}`:`${dateLabel(selected)} için plan yüklenmemiş. Haftalık Plan bölümünden ekleyebilirsin.`);renderLive();renderChart();if(!$('panel-day-plan').hidden)renderDayPlan();}
function renderDayPlan() {
  const rows = $('day-plan-rows');
  const query = $('day-plan-search').value.trim().toLocaleLowerCase('tr');
  const employees = currentPlan?.employees ?? [];
  const filtered = employees.filter(employee => employee.name.toLocaleLowerCase('tr').includes(query));
  const isToday = $('admin-date').value === today();
  const [hour, minute] = clock().split(':').map(Number);
  const time = hour * 60 + minute;
  const fragment = document.createDocumentFragment();
  for (const employee of filtered) {
    const row = document.createElement('tr');
    const name = node('th', employee.name);
    name.scope = 'row';
    row.append(name, node('td', fmt(employee.start) + ' – ' + fmt(employee.end)));
    const active = isToday ? planState(employee, currentPlan.settings, time, false).active : null;
    const slots = [...employee.breaks.slice(0, 3), employee.lunch, ...employee.breaks.slice(3)];
    slots.forEach((slot, index) => {
      const label = index === 3 ? 'Yemek' : (index < 3 ? index + 1 : index) + '. Mola';
      const cell = node('td', fmt(slot));
      if (active?.label === label) {
        cell.classList.add('active-time');
        cell.setAttribute('aria-label', 'Aktif mola, ' + fmt(slot));
      }
      row.append(cell);
    });
    fragment.append(row);
  }
  rows.replaceChildren(fragment);
  $('day-plan-count').textContent = !currentPlan ? 'Seçili tarih için mola planı yok.'
    : !filtered.length ? 'Aramayla eşleşen çalışan yok.'
    : filtered.length + ' / ' + employees.length + ' çalışan';
}
$('day-plan-search').addEventListener('input', renderDayPlan);

function groups(){const n=clock().split(':');const minute=+n[0]*60 + +n[1] + +n[2]/60;const all=(currentPlan?.employees||[]).map(e=>({e,state:planState(e,currentPlan.settings,minute)}));return{all,now:all.filter(x=>x.state.active),soon:all.filter(x=>x.state.next&&x.state.next.start-x.state.now<=15),back:all.map(x=>({...x,ended:x.state.schedule.filter(s=>x.state.now>=s.start+s.duration&&x.state.now-(s.start+s.duration)<=15).at(-1)})).filter(x=>x.ended)};}
function fillList(id,list,type){const root=$(id);root.replaceChildren();const query=$('live-search').value.toLocaleLowerCase('tr');const filtered=list.filter(x=>x.e.name.toLocaleLowerCase('tr').includes(query));if(!filtered.length){root.append(node('p','Bu aralıkta çalışan yok.','admin-empty'));return;}for(const x of filtered){const s=type==='now'?x.state.active:type==='soon'?x.state.next:x.ended;const remaining=type==='now'?Math.ceil(s.start+s.duration-x.state.now):Math.ceil(s.start-x.state.now);const text=type==='now'?`${s.label} · ${fmt((s.time+s.duration)%1440)} dönüş · ${remaining} dk kaldı`:type==='soon'?`${s.label} · ${fmt(s.time)} · ${remaining} dk sonra`:`${s.label} · ${fmt((s.time+s.duration)%1440)} dönüş`;const card=node('div',null,'live-person');card.append(node('strong',x.e.name),node('small',text));root.append(card);}}
function renderLive(){const g=groups();$('live-count').textContent=`${g.all.length} çalışan`;$('live-plan-date').textContent=dateLabel($('admin-date').value);for(const name of ['now','soon','back']){const query=$('live-search').value.toLocaleLowerCase('tr');$(name+'-count').textContent=g[name].filter(x=>x.e.name.toLocaleLowerCase('tr').includes(query)).length;fillList(name+'-list',g[name],name);}fillList('stats-now-list',g.now,'now');$('stat-total').textContent=g.all.length;$('stat-now').textContent=g.now.length;$('stat-soon').textContent=g.soon.length;$('stat-date').textContent=dateLabel($('admin-date').value);const total=g.all.reduce((n,x)=>n+scheduleFor(x.e,currentPlan.settings).reduce((a,s)=>a+s.duration,0),0);$('stat-minutes').textContent=total.toLocaleString('tr-TR')+' dk';$('stat-average').textContent=g.all.length?Math.round(total/g.all.length)+' dk / kişi':'Plan bekleniyor';}
function renderChart(){const root=$('stats-chart');root.replaceChildren();const values=Array.from({length:96},(_,i)=>(currentPlan?.employees||[]).filter(e=>planState(e,currentPlan.settings,i*15).active).length),max=Math.max(1,...values),peak=values.indexOf(Math.max(...values));values.forEach((value,i)=>{const bar=node('div',null,'chart-bar');bar.style.height=Math.max(1,value/max*100)+'%';bar.title=`${fmt(i*15)} · ${value} kişi`;bar.tabIndex=0;bar.setAttribute('aria-label',bar.title);root.append(bar);});$('chart-peak').textContent=currentPlan?`Tepe ${fmt(peak*15)} · ${Math.max(...values)} kişi`:'Plan bekleniyor';root.setAttribute('aria-label',currentPlan?`15 dakikalık mola yoğunluğu. En yüksek ${fmt(peak*15)} saatinde ${Math.max(...values)} kişi.`:'Plan yüklenmemiş.');}
$('live-search').oninput=renderLive;$('fullscreen').onclick=()=>{if(document.fullscreenElement)document.exitFullscreen();else $('live-panel').requestFullscreen?.().catch(()=>status('Bu tarayıcıda tam ekran açılamadı.'));};
async function loadWeek(){const from=weekStart,to=addDays(from,6);$('week-title').textContent=`${dateLabel(from)} – ${dateLabel(to)}`;const data=await api('admin/plans?from='+from+'&to='+to);if(from!==weekStart)return;const root=$('week-grid');root.replaceChildren();for(let i=0;i<7;i++){const date=addDays(from,i),record=data.days.find(d=>d.date===date);const card=node('article',null,'day-card'+(date===today()?' today':''));const dayName=new Intl.DateTimeFormat('tr-TR',{weekday:'long',timeZone:'UTC'}).format(new Date(date+'T12:00:00Z'));card.append(node('p',dayName+(date===today()?' · BUGÜN':''),'day-name'),node('p',new Intl.DateTimeFormat('tr-TR',{day:'numeric',month:'long',timeZone:'UTC'}).format(new Date(date+'T12:00:00Z')),'day-date'),node('p',record?`✓ ${record.count} çalışan`:'Plan yüklenmedi','day-state'));const filename=node('p',record?.filename||'Excel / CSV','day-file');filename.title=record?.filename||'';card.append(filename);const actions=node('div',null,'day-actions'),upload=node('button',record?'Değiştir':'Yükle');upload.onclick=()=>{$('upload-start').value=date;$('plan-files').click();};actions.append(upload);if(record){const remove=node('button','Sil');remove.onclick=async()=>{if(!confirm(dateLabel(date)+' planı silinsin mi?'))return;try{await post('admin/plans',{date},'DELETE');await Promise.all([loadWeek(),loadPlan()]);localStorage.setItem('uzman-plan-update',Date.now());}catch(e){status(e.message);}};actions.append(remove);}card.append(actions);root.append(card);}}
$('week-prev').onclick=()=>{weekStart=addDays(weekStart,-7);loadWeek().catch(e=>status(e.message));};$('week-next').onclick=()=>{weekStart=addDays(weekStart,7);loadWeek().catch(e=>status(e.message));};
let xlsx;
$('plan-files').onchange=async e=>{const files=[...e.target.files];if(!files.length)return;$('upload-message').textContent='Dosyalar okunuyor…';try{xlsx??=await (window.XLSX?Promise.resolve(window.XLSX):new Promise((r,j)=>{const s=document.createElement('script');s.src='/vendor/xlsx.full.min.js?v=0.20.3';s.onload=()=>r(window.XLSX);s.onerror=j;document.head.appendChild(s);}));for(let i=0;i<files.length;i++){const file=files[i];let date=addDays($('upload-start').value||today(),i);const iso=file.name.match(/(20\d{2})[-_.](\d{2})[-_.](\d{2})/),tr=file.name.match(/(\d{2})[-_.](\d{2})[-_.](20\d{2})/);if(iso)date=`${iso[1]}-${iso[2]}-${iso[3]}`;else if(tr)date=`${tr[3]}-${tr[2]}-${tr[1]}`;try{if(file.size>15*1024*1024)throw new Error('Dosya 15 MB sınırını aşıyor.');const parsed=parseWorkbook(xlsx,xlsx.read(await file.arrayBuffer(),{type:'array'}));queue.push({date,filename:file.name,plan:parsed});}catch(err){queue.push({date,filename:file.name,error:err.message});}}renderQueue();$('upload-message').textContent='Tarihleri kontrol et. Kaydetmeden önce hiçbir plan değişmez.';}catch(err){$('upload-message').textContent='Dosya okuyucu yüklenemedi: '+err.message;}finally{e.target.value='';}};
function renderQueue(){const root=$('upload-queue');root.replaceChildren();queue.forEach((item,i)=>{const row=node('div',null,'queue-row'),name=node('div');name.append(node('strong',item.filename),node('small',item.error||item.plan.warnings.join(' ')||'Kaydetmeye hazır',item.error?'queue-error':''));const date=node('input');date.type='date';date.value=item.date;date.setAttribute('aria-label',item.filename+' plan tarihi');date.onchange=()=>{item.date=date.value;};const remove=node('button','×');remove.setAttribute('aria-label',item.filename+' dosyasını kuyruktan çıkar');remove.onclick=()=>{queue.splice(i,1);renderQueue();};row.append(name,date,node('span',item.plan?item.plan.employees.length+' çalışan':'Hatalı dosya'),remove);root.append(row);});$('publish-plans').hidden=!queue.length;$('publish-plans').disabled=queue.some(q=>q.error);}
$('publish-plans').onclick=async()=>{const button=$('publish-plans');button.disabled=true;try{const dates=queue.map(q=>q.date);if(dates.some(d=>!d)||new Set(dates).size!==dates.length)throw new Error('Her dosya için farklı bir tarih seç.');const result=await post('admin/plans',{days:queue.map(q=>({date:q.date,filename:q.filename,plan:q.plan}))});queue=[];renderQueue();$('upload-message').textContent=`${result.count} günlük plan sunucuya kaydedildi.`;await Promise.all([loadWeek(),loadPlan()]);localStorage.setItem('uzman-plan-update',Date.now());}catch(err){$('upload-message').textContent=err.message;}finally{button.disabled=false;}};
$('change-password').onsubmit=async e=>{e.preventDefault();if($('password-new').value!==$('password-repeat').value){$('password-message').textContent='Yeni şifreler eşleşmiyor.';return;}try{await post('admin/password',{current:$('password-current').value,password:$('password-new').value});e.target.reset();$('password-message').textContent='Şifre değiştirildi. Diğer yönetici oturumları kapatıldı.';}catch(err){$('password-message').textContent=err.message;}};
function showMaintenance(data){$('maintenance-enabled').checked=data.enabled;$('maintenance-message').value=data.message||'';$('maintenance-state').textContent=data.enabled?'● Bakım modu açık':'● Bakım modu kapalı';}
async function loadMaintenance(){showMaintenance(await api('admin/maintenance'));}
$('maintenance-form').onsubmit=async e=>{e.preventDefault();try{const data=await post('admin/maintenance',{enabled:$('maintenance-enabled').checked,message:$('maintenance-message').value});showMaintenance(data);$('maintenance-result').textContent='Bakım ayarı kaydedildi.';localStorage.setItem('uzman-plan-update',Date.now());}catch(err){$('maintenance-result').textContent=err.message;}};
function tick(){const value=clock();$('live-clock').textContent=value;if(authenticated&&value.slice(0,5)!==lastMinute){lastMinute=value.slice(0,5);renderLive();if(!$('panel-day-plan').hidden)renderDayPlan();}if(today()!==lastDate){if($('admin-date').value===lastDate){$('admin-date').value=today();weekStart=monday(today());loadPlan().catch(e=>status(e.message));loadWeek().catch(e=>status(e.message));}lastDate=today();}}
setInterval(tick,1000);setInterval(()=>{if(authenticated)loadPlan().catch(e=>status(e.message));},30000);tick();
try{const data=await api('admin/session');if(data.authenticated)await start();else showLogin();}catch(err){showLogin();$('login-message').textContent=err.message;}

