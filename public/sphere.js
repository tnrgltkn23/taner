import {ParticleExperience,GradientExperience,gsap,ScrollTrigger,createSmoothScroll,setupScrollText} from './animation-runtime.js';
import {frameGate} from './frame-budget.js';
const mobile=matchMedia('(max-width: 991px), (pointer: coarse)').matches;
const MOBILE_FPS=45;
const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
const stage=document.querySelector('.gpu-stage');
const ambient=document.querySelector('#ambient-gradient');
let experience;
if(!reduced){
  const gradient=new GradientExperience(ambient);
  if(mobile){
    gradient.dpi=Math.min(devicePixelRatio||1,1.25);
    gradient.onResize();
    const drawGradient=gradient.render;
    const canDrawGradient=frameGate(MOBILE_FPS);
    gradient.render=(time=performance.now())=>{
      if(canDrawGradient(time))drawGradient();
      else requestAnimationFrame(gradient.render);
    };
  }
  const smooth=createSmoothScroll();
  smooth.on('scroll',ScrollTrigger.update);
  gsap.ticker.add(time=>smooth.raf(time*1000));
  gsap.ticker.lagSmoothing(0);
  setupScrollText();
  gsap.from('.hero-eyebrow,.hero-body h1,.hero-bottom p,.hero-action',{y:24,opacity:0,duration:1,ease:'power2.out',stagger:.12,delay:.15});
  gsap.from('.intro h2,.intro p',{opacity:.15,y:30,stagger:.15,ease:'none',scrollTrigger:{trigger:'.intro',start:'top 80%',end:'top 35%',scrub:true}});
  const stats=document.querySelector('.stats');
  gsap.from(stats.children,{y:40,opacity:0,duration:.8,stagger:.12,ease:'power2.out',scrollTrigger:{trigger:stats,start:'top 85%',once:true}});
  const resize=()=>{if(experience)experience.resize(stage.clientWidth,stage.clientHeight)};
  function fallback(){
    const video=document.createElement('video');
    video.src='https://files.auros.global/web-assets/fallback.mp4';
    video.muted=true;video.autoplay=true;video.loop=true;video.playsInline=true;video.setAttribute('aria-hidden','true');
    stage.append(video);video.play().catch(()=>{});
  }
  try{
    if(!navigator.gpu||!await navigator.gpu.requestAdapter())throw new Error('No GPU');
    experience=new ParticleExperience(stage);
    if(mobile)experience.renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.25));
    resize();await experience.init();
    if(mobile){
      experience.particles.parameters.particleCount=24576;
      experience.particles.updateParticleCount();
      experience.particles.parameters.simulationSpeed=60/MOBILE_FPS;
      const update=experience.update;
      const canDrawParticles=frameGate(MOBILE_FPS);
      experience.update=(time=performance.now())=>{if(canDrawParticles(time))update();};
    }
    let visible=true;
    const render=()=>experience.onElementInViewport(visible&&!document.hidden);
    new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;render()}).observe(stage);
    document.addEventListener('visibilitychange',render);
    window.addEventListener('resize',resize,{passive:true});
    render();
  }catch(error){if(experience){experience.render(false);experience.renderer.domElement.remove();}fallback();}
  document.fonts.ready.then(()=>ScrollTrigger.refresh());
  const refresh=new ResizeObserver(()=>{smooth.resize();ScrollTrigger.refresh()});
  refresh.observe(document.querySelector('main'));
}else{
  ambient.style.display='none';
}

const options=[...document.querySelectorAll('[data-motion]')];
for(const option of options){
  const activate=()=>options.forEach(item=>item.classList.toggle('active',item===option));
  option.addEventListener('pointerenter',activate);option.addEventListener('focus',activate);
}
