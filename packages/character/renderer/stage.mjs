/** Isolated, client-only character stage (AB-063 partial, AB-077 partial).
 *
 * Off unless the server enables it. Falls back to *no stage at all* (reading untouched) on reduced
 * motion, data saver, missing WebGL 2, load timeout, asset error or GPU context loss. Every failure
 * is caught here; nothing propagates to the reader. The canvas is decorative (aria-hidden): the
 * source text, citations and controls remain the accessible experience.
 */
import {createClipController} from '../animation/mixer.mjs';
import {resolvePointTarget} from '../attention/targets.mjs';

export function chooseStageMode({config,env}){
  if(!config?.enabled)return {mode:'off',reason:'disabled'};
  if(env.hiddenByUser)return {mode:'off',reason:'hidden-by-user'};
  if(env.reducedMotion)return {mode:'off',reason:'reduced-motion'};
  if(env.saveData)return {mode:'off',reason:'save-data'};
  if(!env.webgl2)return {mode:'off',reason:'no-webgl2'};
  return {mode:'3d',reason:'capable'};
}

export function detectEnvironment(win){
  let webgl2=false;
  try{webgl2=!!win.document.createElement('canvas').getContext('webgl2');}catch{}
  let hiddenByUser=false;try{hiddenByUser=win.sessionStorage?.getItem('ask-bill:character-hidden')==='1';}catch{}
  return {webgl2,hiddenByUser,reducedMotion:!!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    saveData:!!win.navigator?.connection?.saveData};
}

export async function mountCharacterStage({win,container,config,loadModules,registry,onState=()=>{},timeoutMs=20000}){
  const env=detectEnvironment(win),choice=chooseStageMode({config,env});
  let state={mode:choice.mode,reason:choice.reason};
  const report=next=>{state={...state,...next};try{onState(state);}catch{}};
  report({});
  const inert={get state(){return state;},focus(){return {action:'none',reason:state.reason};},answer(){},dispose(){}};
  if(choice.mode!=='3d')return inert;
  let renderer,mixer,controller,frame=0,disposed=false,scene,camera,model,targetYaw=0,listeners=[];
  const on=(target,name,fn)=>{target.addEventListener(name,fn);listeners.push([target,name,fn]);};
  const fail=reason=>{dispose();container.hidden=true;report({mode:'off',reason});};
  function dispose(){
    if(disposed)return;disposed=true;win.cancelAnimationFrame(frame);
    for(const [t,n,f] of listeners)t.removeEventListener(n,f);
    try{controller?.dispose();mixer?.stopAllAction();renderer?.dispose();renderer?.forceContextLoss?.();}catch{}
    container.replaceChildren();
  }
  try{
    report({mode:'loading'});
    const {THREE,GLTFLoader}=await loadModules();
    const canvas=win.document.createElement('canvas');
    canvas.setAttribute('aria-hidden','true');canvas.width=220;canvas.height=260;
    renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true,powerPreference:'low-power'});
    renderer.setPixelRatio(Math.min(win.devicePixelRatio||1,1.5));renderer.setSize(220,260,false);
    on(canvas,'webglcontextlost',event=>{event.preventDefault();fail('context-lost');});
    scene=new THREE.Scene();
    camera=new THREE.PerspectiveCamera(30,220/260,0.1,100);
    scene.add(new THREE.HemisphereLight(0xffffff,0x8899aa,2.2));
    const key=new THREE.DirectionalLight(0xffffff,1.6);key.position.set(2,4,3);scene.add(key);
    const gltf=await Promise.race([new GLTFLoader().loadAsync(config.assetUrl),
      new Promise((_,reject)=>win.setTimeout(()=>reject(Error('CHARACTER_LOAD_TIMEOUT')),timeoutMs))]);
    if(disposed)return inert;
    model=gltf.scene;scene.add(model);
    // Frame the model from its bounds; candidate assets differ in scale and origin.
    const box=new THREE.Box3().setFromObject(model),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
    const height=Math.max(size.y,1e-3);
    camera.position.set(center.x,center.y,center.z+height*2.1);camera.lookAt(center);
    mixer=new THREE.AnimationMixer(model);
    const actions=new Map(gltf.animations.map(clip=>[clip.name,mixer.clipAction(clip)]));
    controller=createClipController({actions});
    mixer.addEventListener('finished',event=>controller.finished(event.action));
    controller.play('idle');
    container.append(canvas);container.hidden=false;
    const clock=new THREE.Clock();
    const tick=()=>{
      if(disposed)return;
      const dt=Math.min(clock.getDelta(),0.1);mixer.update(dt);
      model.rotation.y+=(targetYaw-model.rotation.y)*Math.min(1,dt*4);
      renderer.render(scene,camera);frame=win.requestAnimationFrame(tick);
    };
    on(win.document,'visibilitychange',()=>{
      if(win.document.hidden){win.cancelAnimationFrame(frame);}else if(!disposed){clock.getDelta();frame=win.requestAnimationFrame(tick);}
    });
    on(win.matchMedia('(prefers-reduced-motion: reduce)'),'change',event=>{if(event.matches)fail('reduced-motion');});
    frame=win.requestAnimationFrame(tick);
    report({mode:'3d',reason:'ready',clips:[...actions.keys()]});
  }catch{fail('load-failed');return inert;}
  return {
    get state(){return state;},
    /** Trusted reader focus only (validated citation/tour/selection), never model output. */
    focus(detail){
      if(disposed)return {action:'none',reason:'disposed'};
      const rect=container.getBoundingClientRect();
      const target=resolvePointTarget({registry,focus:detail,stageRect:rect,viewport:{width:win.innerWidth,height:win.innerHeight}});
      if(target.action==='point'){targetYaw=target.gaze.yaw*0.6;controller.play('point');}
      else{targetYaw=0;}
      return target;
    },
    answer(phase){if(disposed)return;if(phase==='answering')controller.play('talk');else controller.cancel();},
    dispose(){dispose();container.hidden=true;report({mode:'off',reason:'disposed'});}
  };
}
