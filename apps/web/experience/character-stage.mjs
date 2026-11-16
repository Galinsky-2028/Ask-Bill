/** Reader ↔ character stage glue (AB-072/AB-077, partial). Loaded on interactive reader pages.
 * Does nothing unless /experience/character.json says the stage is enabled. Reading never waits for it.
 */
import {mountCharacterStage} from '/browser/packages/character/renderer/stage.mjs';
import {chooseDock,DOCK_SIZE} from '/browser/packages/character/renderer/follow.mjs';
import {createLayoutAnchorRegistry} from '/browser/packages/character/layout/registry.mjs';
import {createPerformanceRecorder,layoutHash} from '/browser/packages/character/performance/recorder.mjs';

const reader=document.querySelector('[data-reader]'),documentRoot=document.getElementById('bill-document');
if(reader&&documentRoot)start().catch(()=>{});

const MODULES={
  webgl2:['/vendor/three/three.module.min.js','/vendor/three/loaders/GLTFLoader.js'],
  webgpu:['/vendor/three/three.webgpu.min.js','/vendor/three-webgpu/loaders/GLTFLoader.js']
};
export async function loadModules(backend){
  const [core,loader]=MODULES[backend]??MODULES.webgl2;
  const [THREE,{GLTFLoader}]=await Promise.all([import(core),import(loader)]);
  return {THREE,GLTFLoader};
}

async function start(){
  const response=await fetch('/experience/character.json',{credentials:'same-origin'});
  if(!response.ok)return;
  const config=await response.json();
  if(!config?.enabled)return;
  const shell=document.createElement('div');shell.setAttribute('role','group');
  shell.className='bill-stage';shell.hidden=true;shell.setAttribute('aria-label','Animated Bill (optional)');
  const container=document.createElement('div');container.className='bill-stage-canvas';
  const hide=document.createElement('button');hide.type='button';hide.className='bill-stage-hide';hide.textContent='Hide animated Bill';
  shell.append(container,hide);
  // In normal document flow inside the guide panel: the inline stage never covers source text or controls.
  const panel=document.getElementById('conversation-panel'),title=panel?.querySelector('.conversation-title');
  if(title)title.after(shell);else (panel??document.body).append(shell);
  const dock=document.createElement('div');dock.className='bill-stage-dock';dock.hidden=true;dock.setAttribute('aria-hidden','true');
  document.body.append(dock);
  let registry=null;
  try{registry=createLayoutAnchorRegistry({root:documentRoot,versionId:reader.dataset.versionId});registry.collect();}catch{}
  // Development-only performance recorder (AB-076): server flag, IDs/geometry/cues only, never conversation text.
  let recorder=null;
  const currentLayout=async()=>{const snap=registry.measure();
    return layoutHash({versionId:reader.dataset.versionId,anchors:snap.anchors,viewport:{width:innerWidth,height:innerHeight}});};
  if(config.recorder===true&&registry){
    try{
      recorder=createPerformanceRecorder({versionId:reader.dataset.versionId,layout:await currentLayout()});
      const download=document.createElement('button');download.type='button';download.className='bill-stage-hide';
      download.textContent='Download performance trace (no conversation text)';
      download.addEventListener('click',()=>{
        const url=URL.createObjectURL(new Blob([JSON.stringify(recorder.recording(),null,1)],{type:'application/json'}));
        const a=document.createElement('a');a.href=url;a.download='ask-bill-performance-'+Date.now()+'.json';a.click();
        setTimeout(()=>URL.revokeObjectURL(url),1000);
      });
      shell.append(download);
      let pending=0;addEventListener('resize',()=>{clearTimeout(pending);pending=setTimeout(async()=>{try{recorder.relayout(await currentLayout());}catch{}},250);});
    }catch{recorder=null;}
  }
  const stage=await mountCharacterStage({win:window,container,config,registry,loadModules,recorder,
    onState:state=>{shell.hidden=state.mode!=='3d'||state.reason!=='ready';shell.dataset.state=state.mode+':'+state.reason;
      if(state.backend)shell.dataset.backend=state.backend;}});
  let place='inline',observer=null;
  const contentRight=()=>{const main=document.querySelector('main');return main?main.getBoundingClientRect().right:window.innerWidth;};
  const relocate=slotVisible=>{
    const next=chooseDock({slotVisible,viewportWidth:window.innerWidth,contentRight:contentRight(),followEnabled:config.follow!==false});
    if(next===place||shell.dataset.state!=='3d:ready')return;
    place=next;recorder?.record({type:'place',place:next});
    if(next==='dock'){dock.hidden=false;stage.attach(dock,DOCK_SIZE);}else{stage.attach(container,{width:220,height:260});dock.hidden=true;}
    stage.walk(next==='dock'?1:-1);
  };
  if('IntersectionObserver' in window){
    observer=new IntersectionObserver(entries=>{for(const entry of entries)relocate(entry.isIntersecting);},{threshold:0.25});
    observer.observe(shell);
  }
  hide.addEventListener('click',()=>{
    try{sessionStorage.setItem('ask-bill:character-hidden','1');}catch{}
    observer?.disconnect();stage.dispose();registry?.dispose();shell.remove();dock.remove();
  });
  document.addEventListener('askbill:source-focus',event=>stage.focus(event.detail));
  document.addEventListener('askbill:answer-state',event=>stage.answer(event.detail?.phase));
}
