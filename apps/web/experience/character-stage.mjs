/** Reader ↔ character stage glue (AB-077, partial). Loaded on interactive reader pages.
 * Does nothing unless /experience/character.json says the stage is enabled. Reading never waits for it.
 */
import {mountCharacterStage} from '/browser/packages/character/renderer/stage.mjs';
import {createLayoutAnchorRegistry} from '/browser/packages/character/layout/registry.mjs';

const reader=document.querySelector('[data-reader]'),documentRoot=document.getElementById('bill-document');
if(reader&&documentRoot)start().catch(()=>{});

async function start(){
  const response=await fetch('/experience/character.json',{credentials:'same-origin'});
  if(!response.ok)return;
  const config=await response.json();
  if(!config?.enabled)return;
  const shell=document.createElement('aside');
  shell.className='bill-stage';shell.hidden=true;shell.setAttribute('aria-label','Animated Bill (optional)');
  const container=document.createElement('div');container.className='bill-stage-canvas';
  const hide=document.createElement('button');hide.type='button';hide.className='bill-stage-hide';hide.textContent='Hide animated Bill';
  shell.append(container,hide);
  // In normal document flow inside the guide panel: the stage can never cover source text or controls.
  const panel=document.getElementById('conversation-panel'),title=panel?.querySelector('.conversation-title');
  if(title)title.after(shell);else (panel??document.body).append(shell);
  let registry=null;
  try{registry=createLayoutAnchorRegistry({root:documentRoot,versionId:reader.dataset.versionId});registry.collect();}catch{}
  const stage=await mountCharacterStage({win:window,container,config,registry,
    loadModules:async()=>{
      const [THREE,{GLTFLoader}]=await Promise.all([import('/vendor/three/three.module.min.js'),import('/vendor/three/loaders/GLTFLoader.js')]);
      return {THREE,GLTFLoader};
    },
    onState:state=>{shell.hidden=state.mode!=='3d'||state.reason!=='ready';shell.dataset.state=state.mode+':'+state.reason;}});
  hide.addEventListener('click',()=>{try{sessionStorage.setItem('ask-bill:character-hidden','1');}catch{}stage.dispose();registry?.dispose();shell.remove();});
  document.addEventListener('askbill:source-focus',event=>stage.focus(event.detail));
  document.addEventListener('askbill:answer-state',event=>stage.answer(event.detail?.phase));
}
