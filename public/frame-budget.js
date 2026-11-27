// Retain fractional frame time so a 60 Hz display targets 45 rather than 30 FPS.
export function frameGate(fps) {
  const interval=1000/fps;
  let next=null;
  return time=>{
    if(next!==null&&time<next-.001)return false;
    next=next===null||time-next>interval?time+interval:next+interval;
    return true;
  };
}
