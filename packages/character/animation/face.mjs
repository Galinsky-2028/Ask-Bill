/** Facial layers (AB-064 partial): blink, gaze and viseme weights, layered on top of clip playback.
 *
 * Pure, deterministic functions (seeded) so behaviour is testable without a GPU. The stage binds
 * them to the candidate rig's eye parts and its `MouthVisemes` morph targets.
 */
export const VISEMES=Object.freeze(['viseme_sil','viseme_AA','viseme_EE','viseme_IH','viseme_OH','viseme_OO','viseme_U',
  'viseme_FV','viseme_MBP','viseme_L','viseme_TH','viseme_CH','viseme_SS','viseme_R']);

/** Mulberry32: small seeded PRNG for reproducible blink/talk timing in tests and golden poses. */
export function seededRandom(seed){
  let a=seed>>>0;
  return ()=>{a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
}

/** Clamp each weight to [0,1] and scale the set so the total never exceeds 1 (no over-driven mouths). */
export function normalizeWeights(weights){
  const out={};let sum=0;
  for(const [k,v] of Object.entries(weights)){const w=Number.isFinite(v)?Math.min(1,Math.max(0,v)):0;out[k]=w;sum+=w;}
  if(sum>1)for(const k of Object.keys(out))out[k]/=sum;
  return out;
}

/** Blink scheduler: closure 0 (open) … 1 (closed). Intervals 2.5–6 s, 15 % double blinks. */
export function createBlinkScheduler({random=Math.random,closeMs=70,openMs=110}={}){
  let next=2500+random()*3500,start=-1,double=false;
  return {
    closure(t){
      if(start<0&&t>=next){start=t;double=random()<0.15;}
      if(start<0)return 0;
      const e=t-start,total=closeMs+openMs;
      if(e<closeMs)return e/closeMs;
      if(e<total)return 1-(e-closeMs)/openMs;
      if(double&&e<total*2+60){const d=e-total-60;if(d<0)return 0;return d<closeMs?d/closeMs:Math.max(0,1-(d-closeMs)/openMs);}
      start=-1;next=t+2500+random()*3500;return 0;
    },
    /** Force a blink now (for example when gaze jumps to a new target). */
    trigger(t){if(start<0)next=t;}
  };
}

/** Critically damped follow toward a gaze target in [-1,1]²; returns the new offset. */
export function stepGaze(current,target,dt,speed=10){
  const k=1-Math.exp(-speed*Math.max(0,dt));
  const clamp=v=>Math.min(1,Math.max(-1,v));
  return {x:current.x+(clamp(target.x)-current.x)*k,y:current.y+(clamp(target.y)-current.y)*k};
}

/** Procedural talk when no aligned speech timing is available: plausible viseme shapes at ~9 Hz. */
export function createTalkVisemes({random=Math.random,rateHz=9}={}){
  const open=['viseme_AA','viseme_EE','viseme_IH','viseme_OH','viseme_OO','viseme_U'];
  const closed=['viseme_MBP','viseme_FV','viseme_SS','viseme_TH','viseme_L','viseme_CH','viseme_R'];
  let index=-1,current='viseme_sil',previous='viseme_sil';
  return {
    weights(t){
      const step=Math.floor(t*rateHz/1000);
      if(step!==index){index=step;previous=current;current=random()<0.7?open[Math.floor(random()*open.length)]:closed[Math.floor(random()*closed.length)];}
      const phase=(t*rateHz/1000)-step,blend=Math.min(1,phase*3);
      const w={};w[current]=(w[current]??0)+0.85*blend;w[previous]=(w[previous]??0)+0.85*(1-blend);
      return normalizeWeights(w);
    }
  };
}
