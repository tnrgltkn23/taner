const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
const mobile=matchMedia('(max-width: 991px), (pointer: coarse)').matches;
const coarse=matchMedia('(pointer: coarse)').matches;
const topic=document.getElementById('topic');
topic.addEventListener('change',()=>{if(!topic.value)return;const target=document.getElementById(topic.value);target.scrollIntoView({behavior:reduce?'instant':'smooth',block:'start'});target.focus({preventScroll:true});history.replaceState(null,'','#'+topic.value);});
const progress=document.querySelector('.progress');
function update(){const max=document.documentElement.scrollHeight-innerHeight;progress.style.width=(max>0?scrollY/max*100:0)+'%';}
addEventListener('scroll',update,{passive:true});addEventListener('resize',update);update();
async function checkMaintenance(){try{const response=await fetch('/api/state',{cache:'no-store'});const state=await response.json();if(state.maintenance?.enabled&&!state.isAdmin)location.reload();}catch{}}
setInterval(checkMaintenance,30000);
