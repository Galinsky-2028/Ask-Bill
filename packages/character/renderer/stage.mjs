/** Isolated, client-only character stage (AB-063/064/070/072/077, partial; candidate asset only).
 *
 * Off unless the server enables it. Backend: WebGPU when available (verified by an actual adapter
 * and a WebGPU-backed renderer), otherwise WebGL 2. The stage removes itself, leaving reading
 * untouched, on reduced motion, data saver, no WebGL 2, load timeout, asset error or GPU loss.
 * Every failure is caught here. The canvas is decorative (aria-hidden); text, citations and
 * controls remain the accessible experience.
 */
import {createClipController} from '../animation/mixer.mjs';
import {resolvePointTarget} from '../attention/targets.mjs';
import {createBlinkScheduler,stepGaze,createTalkVisemes,VISEMES,seededRandom} from '../animation/face.mjs';

export const BACKENDS=Object.freeze(['auto','webgpu','webgl2']);

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
    saveData:!!win.navigator?.connection?.saveData,webgpu:!!win.navigator?.gpu};
}

/** WebGPU only when requested/allowed and a real adapter exists; otherwise WebGL 2. */
export async function pickBackend({preference='auto',win}){
  if(!BACKENDS.includes(preference))preference='auto';
  if(preference==='webgl2'||!win.navigator?.gpu)return 'webgl2';
  try{return (await win.navigator.gpu.requestAdapter())?'webgpu':'webgl2';}catch{return 'webgl2';}
}

async function createRenderer({backend,loadModules,win,width,height,preserve=false}){
  const mods=await loadModules(backend),canvas=win.document.createElement('canvas');
  canvas.setAttribute('aria-hidden','true');canvas.width=width;canvas.height=height;
  let renderer;
  if(backend==='webgpu'){
    renderer=new mods.THREE.WebGPURenderer({canvas,alpha:true,antialias:true});
    await renderer.init();
    if(!renderer.backend?.isWebGPUBackend){renderer.dispose();throw Error('WEBGPU_UNAVAILABLE');}
  }else renderer=new mods.THREE.WebGLRenderer({canvas,alpha:true,antialias:true,powerPreference:'low-power',preserveDrawingBuffer:preserve});
  renderer.setPixelRatio(preserve?1:Math.min(win.devicePixelRatio||1,1.5));renderer.setSize(width,height,false);
  return {renderer,canvas,mods,backend};
}

/** WebGPU first when chosen; any WebGPU failure falls back to a fresh WebGL 2 canvas. */
export async function createRendererWithFallback(options){
  const backend=await pickBackend({preference:options.preference,win:options.win});
  if(backend==='webgpu'){try{return await createRenderer({...options,backend});}catch{}}
  return createRenderer({...options,backend:'webgl2'});
}

export function frameModel(THREE,model,camera){
  const box=new THREE.Box3().setFromObject(model),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
  const height=Math.max(size.y,1e-3);
  camera.position.set(center.x,center.y,center.z+height*2.1);camera.lookAt(center);
}

function buildScene(THREE,gltf,width,height){
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(30,width/height,0.1,100);
  scene.add(new THREE.HemisphereLight(0xffffff,0x8899aa,2.2));
  const key=new THREE.DirectionalLight(0xffffff,1.6);key.position.set(2,4,3);scene.add(key);
  const model=gltf.scene;scene.add(model);frameModel(THREE,model,camera);
  return {scene,camera,model};
}

const EYE_BLINK=['Soft_Almond_Sclera','Warm_Brown_Iris','Dark_Iris_Rim','Friendly_Pupil','Soft_Eye_Glint','Small_Eye_Glint'];
const EYE_GAZE=['Warm_Brown_Iris','Dark_Iris_Rim','Friendly_Pupil','Soft_Eye_Glint','Small_Eye_Glint'];

/** Bind blink/gaze to the candidate eye parts and visemes to `MouthVisemes`. Missing parts → inert layer. */
export function bindFaceRig(THREE,model){
  const sides=[];
  for(const side of ['L','R']){
    const sclera=model.getObjectByName('Soft_Almond_Sclera_'+side);
    if(!sclera?.isMesh)continue;
    sclera.geometry.computeBoundingBox();
    const center=sclera.geometry.boundingBox.getCenter(new THREE.Vector3()),size=sclera.geometry.boundingBox.getSize(new THREE.Vector3());
    const parts=new Map();
    for(const name of new Set([...EYE_BLINK,...EYE_GAZE])){
      const mesh=model.getObjectByName(name+'_'+side);if(!mesh?.isMesh)continue;
      // Re-pivot each part on the eye centre so blink scaling closes toward the middle of the eye.
      mesh.geometry=mesh.geometry.clone();mesh.geometry.translate(-center.x,-center.y,-center.z);
      mesh.position.add(center);parts.set(name,{mesh,base:mesh.position.clone()});
    }
    sides.push({parts,radius:Math.max(size.x,size.y)*0.16});
  }
  const mouth=model.getObjectByName('MouthVisemes');
  const dictionary=mouth?.morphTargetDictionary??null,influences=mouth?.morphTargetInfluences??null;
  return {
    eyes:sides.length,visemes:dictionary?VISEMES.filter(v=>v in dictionary).length:0,
    apply({blink=0,gaze={x:0,y:0},visemes={}}){
      for(const {parts,radius} of sides){
        for(const name of EYE_BLINK){const p=parts.get(name);if(p)p.mesh.scale.y=1-0.92*blink;}
        for(const name of EYE_GAZE){const p=parts.get(name);if(p)p.mesh.position.set(p.base.x+gaze.x*radius,p.base.y+gaze.y*radius*0.7,p.base.z);}
      }
      if(dictionary&&influences)for(const name of VISEMES){const i=dictionary[name];if(i!==undefined)influences[i]=visemes[name]??0;}
    }
  };
}

async function loadAsset(GLTFLoader,url,win,timeoutMs){
  return Promise.race([new GLTFLoader().loadAsync(url),
    new Promise((_,reject)=>win.setTimeout(()=>reject(Error('CHARACTER_LOAD_TIMEOUT')),timeoutMs))]);
}

/**
 * Deterministic still for golden-pose regression and backend parity: fixed size, pixel ratio 1,
 * clip sampled at an exact time, neutral face. Returns a PNG data URL drawn through a 2D canvas.
 */
export async function renderPoseSnapshot({win,loadModules,assetUrl,clip,time=0,width=220,height=260,preference='webgl2',face={}}){
  const created=await createRendererWithFallback({win,loadModules,width,height,preference,preserve:true});
  const {renderer,mods}=created,{THREE,GLTFLoader}=mods;
  try{
    const gltf=await loadAsset(GLTFLoader,assetUrl,win,30000);
    const {scene,camera,model}=buildScene(THREE,gltf,width,height);
    const mixer=new THREE.AnimationMixer(model),source=gltf.animations.find(a=>a.name===clip);
    if(!source)throw Error('POSE_CLIP_MISSING');
    mixer.clipAction(source).play();mixer.setTime(time);
    bindFaceRig(THREE,model).apply(face);
    if(created.backend==='webgpu')await renderer.renderAsync(scene,camera);else renderer.render(scene,camera);
    const out=win.document.createElement('canvas');out.width=width;out.height=height;
    out.getContext('2d').drawImage(created.canvas,0,0,width,height);
    return {backend:created.backend,dataUrl:out.toDataURL('image/png')};
  }finally{renderer.dispose();}
}

export async function mountCharacterStage({win,container,config,loadModules,registry,onState=()=>{},timeoutMs=20000,seed}){
  const env=detectEnvironment(win),choice=chooseStageMode({config,env});
  let state={mode:choice.mode,reason:choice.reason};
  const report=next=>{state={...state,...next};try{onState(state);}catch{}};
  report({});
  const inert={get state(){return state;},focus(){return {action:'none',reason:state.reason};},answer(){},walk(){},attach(){},dispose(){}};
  if(choice.mode!=='3d')return inert;
  let created,renderer,mixer,controller,face,frame=0,disposed=false,scene,camera,model,listeners=[],timers=[];
  let targetYaw=0,gaze={x:0,y:0},gazeTarget={x:0,y:0},talking=false,elapsed=0;
  const random=seed===undefined?Math.random:seededRandom(seed),blink=createBlinkScheduler({random}),talk=createTalkVisemes({random});
  const on=(target,name,fn)=>{target?.addEventListener?.(name,fn);listeners.push([target,name,fn]);};
  const later=(fn,ms)=>{const id=win.setTimeout(fn,ms);timers.push(id);return id;};
  const fail=reason=>{dispose();container.hidden=true;report({mode:'off',reason});};
  function dispose(){
    if(disposed)return;disposed=true;win.cancelAnimationFrame(frame);
    for(const id of timers)win.clearTimeout(id);
    for(const [t,n,f] of listeners)t?.removeEventListener?.(n,f);
    try{controller?.dispose();mixer?.stopAllAction();renderer?.dispose();renderer?.forceContextLoss?.();}catch{}
    created?.canvas?.remove();container.replaceChildren();
  }
  try{
    report({mode:'loading'});
    created=await createRendererWithFallback({win,loadModules,width:220,height:260,preference:config.backend});
    ({renderer}=created);const {THREE,GLTFLoader}=created.mods;
    on(created.canvas,'webglcontextlost',event=>{event.preventDefault();fail('context-lost');});
    renderer.backend?.device?.lost?.then?.(()=>{if(!disposed)fail('context-lost');});
    const gltf=await loadAsset(GLTFLoader,config.assetUrl,win,timeoutMs);
    if(disposed)return inert;
    ({scene,camera,model}=buildScene(THREE,gltf,220,260));
    mixer=new THREE.AnimationMixer(model);
    const actions=new Map(gltf.animations.map(clip=>[clip.name,mixer.clipAction(clip)]));
    controller=createClipController({actions});
    face=bindFaceRig(THREE,model);
    mixer.addEventListener('finished',event=>controller.finished(event.action));
    controller.play('idle');
    container.append(created.canvas);container.hidden=false;
    const clock=new THREE.Clock();
    const tick=()=>{
      if(disposed)return;
      const dt=Math.min(clock.getDelta(),0.1);elapsed+=dt*1000;mixer.update(dt);
      model.rotation.y+=(targetYaw-model.rotation.y)*Math.min(1,dt*4);
      gaze=stepGaze(gaze,gazeTarget,dt);
      face.apply({blink:blink.closure(elapsed),gaze,visemes:talking?talk.weights(elapsed):{}});
      renderer.render(scene,camera);frame=win.requestAnimationFrame(tick);
    };
    on(win.document,'visibilitychange',()=>{
      if(win.document.hidden){win.cancelAnimationFrame(frame);}else if(!disposed){clock.getDelta();frame=win.requestAnimationFrame(tick);}
    });
    on(win.matchMedia?.('(prefers-reduced-motion: reduce)'),'change',event=>{if(event.matches)fail('reduced-motion');});
    frame=win.requestAnimationFrame(tick);
    report({mode:'3d',reason:'ready',backend:created.backend,clips:[...actions.keys()],face:{eyes:face.eyes,visemes:face.visemes}});
  }catch{fail('load-failed');return inert;}
  return {
    get state(){return state;},
    /** Trusted reader focus only (validated citation/tour/selection), never model output. */
    focus(detail){
      if(disposed)return {action:'none',reason:'disposed'};
      const rect=container.getBoundingClientRect();
      const target=resolvePointTarget({registry,focus:detail,stageRect:rect,viewport:{width:win.innerWidth,height:win.innerHeight}});
      if(target.action==='point'){
        targetYaw=target.gaze.yaw*0.6;gazeTarget={x:target.gaze.yaw,y:target.gaze.pitch};blink.trigger(elapsed);controller.play('point');
        later(()=>{gazeTarget={x:0,y:0};targetYaw=0;},2500);
      }else{targetYaw=0;gazeTarget={x:0,y:0};}
      return target;
    },
    /** Answer lifecycle: thinking → explaining (talk mouth) → nod/shrug → idle. */
    answer(phase){
      if(disposed)return;
      if(phase==='answering'){talking=false;controller.play('think');}
      else if(phase==='speaking'){talking=true;controller.play('explain');}
      else if(phase==='supported'){talking=false;controller.play('nod');}
      else if(phase==='unsupported'){talking=false;controller.play('shrug');}
      else{talking=false;controller.cancel();}
    },
    /** In-place walk toward a side (follow-mode transitions); returns to idle. */
    walk(direction=1,ms=1200){
      if(disposed)return;targetYaw=Math.sign(direction)*0.9;controller.play('walk');
      later(()=>{if(!disposed){targetYaw=0;controller.cancel();}},ms);
    },
    /** Move the live canvas into another container (inline slot or dock) and resize. */
    attach(element,{width,height}){
      if(disposed||!element)return;
      element.append(created.canvas);renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();
    },
    dispose(){dispose();container.hidden=true;report({mode:'off',reason:'disposed'});}
  };
}
