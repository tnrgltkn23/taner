export function scheduleFor(employee, settings) {
  const overnight=employee.start!=null&&employee.end!=null&&employee.end<=employee.start;
  return [...employee.breaks.map((t,i)=>({label:`${i+1}. Mola`,time:t,duration:settings.breakMin})),{label:'Yemek',time:employee.lunch,duration:settings.lunchMin}]
    .filter(s=>s.time!=null)
    .map(s=>({...s,start:s.time+(overnight&&s.time<employee.start?1440:0)}))
    .sort((a,b)=>a.start-b.start);
}
export function planState(employee, settings, minute, afterMidnight = minute < employee.end) {
  const overnight=employee.start!=null&&employee.end!=null&&employee.end<=employee.start;
  const now=minute+(overnight&&afterMidnight?1440:0);
  const schedule=scheduleFor(employee,settings);
  const active=schedule.find(s=>now>=s.start&&now<s.start+s.duration);
  const next=schedule.find(s=>s.start>now);
  const target=active?active.start+active.duration:next?.start;
  const remaining=target==null?0:Math.max(0,Math.ceil((target-now)*60));
  const complete=schedule.filter(s=>now>=s.start+s.duration).length;
  return {now,schedule,active,next,remaining,complete,progress:active?Math.min(100,(now-active.start)/active.duration*100):0};
}
