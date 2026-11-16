import test from 'node:test';
import assert from 'node:assert/strict';
import {createClipController,LOOP_ONCE,LOOP_REPEAT} from '../packages/character/animation/mixer.mjs';
import {resolvePointTarget} from '../packages/character/attention/targets.mjs';
import {chooseStageMode,mountCharacterStage} from '../packages/character/renderer/stage.mjs';
import {buildApplicationRuntime} from '../apps/web/application/start.mjs';

function fakeActions(names){
  const log=[];
  const make=name=>{const a={name,running:false,weight:0,loop:null,clampWhenFinished:false,
    reset(){log.push('reset '+name);return a;},setLoop(mode){a.loop=mode;return a;},play(){a.running=true;a.weight=1;log.push('play '+name);return a;},
    fadeIn(){log.push('fadeIn '+name);return a;},fadeOut(){a.running=false;log.push('fadeOut '+name);return a;},stop(){a.running=false;return a;}};return a;};
  return {map:new Map(names.map(n=>[n,make(n)])),log};
}

test('clip controller keeps one active base action and returns one-shots to idle',()=>{
  const {map,log}=fakeActions(['Idle','Talk','Point']);
  const c=createClipController({actions:map});
  assert.equal(c.play('idle'),'idle');assert.equal(map.get('Idle').loop,LOOP_REPEAT);
  assert.equal(c.play('point'),'point');assert.equal(map.get('Point').loop,LOOP_ONCE);
  assert.deepEqual([...map.values()].filter(a=>a.running).map(a=>a.name),['Point']);
  c.finished(map.get('Point'));assert.equal(c.current,'idle');
  assert.equal(c.play('talk'),'talk');assert.equal(c.cancel(),'idle');
  assert.deepEqual([...map.values()].filter(a=>a.running).map(a=>a.name),['Idle']);
  assert(log.includes('fadeOut Talk'));
});

test('missing clips degrade to idle and dispose stops everything',()=>{
  const {map}=fakeActions(['Idle']);
  const c=createClipController({actions:map});
  assert.equal(c.play('wave'),'idle');
  c.dispose();assert.equal(c.current,null);assert.equal(c.play('talk'),null);
  assert.equal(createClipController({actions:new Map()}).play('talk'),null);
});

const VERSION='33333333-3333-4333-8333-333333333333';
const registry={versionId:VERSION,resolve({sourceVersionId,provisionId}){
  if(provisionId==='missing')throw Error('UNKNOWN');
  const y={visible:100,below:2000,hidden:100}[provisionId];
  return {visible:provisionId!=='hidden',layoutRevision:3,viewportRect:{x:40,y,width:600,height:200}};}};
const stageRect={x:1000,y:500,width:220,height:260},viewport={width:1280,height:800};

test('Bill points only at visible text of the exact reader version',()=>{
  const ok=resolvePointTarget({registry,focus:{versionId:VERSION,provisionId:'visible'},stageRect,viewport});
  assert.equal(ok.action,'point');assert.equal(ok.side,'left');assert(ok.gaze.yaw<0&&ok.gaze.yaw>=-1);
  const reasons=[[{versionId:'other',provisionId:'visible'},'version-mismatch'],[{versionId:VERSION,provisionId:'missing'},'unknown-anchor'],
    [{versionId:VERSION,provisionId:'below'},'offscreen'],[{versionId:VERSION,provisionId:'hidden'},'not-rendered'],[null,'no-focus']];
  for(const [focus,reason] of reasons)assert.deepEqual(resolvePointTarget({registry,focus,stageRect,viewport}),{action:'none',reason});
});

test('stage stays off unless enabled and capable',()=>{
  const env={webgl2:true,reducedMotion:false,saveData:false,hiddenByUser:false};
  assert.equal(chooseStageMode({config:{enabled:false},env}).mode,'off');
  assert.equal(chooseStageMode({config:{enabled:true},env}).mode,'3d');
  for(const key of ['reducedMotion','saveData','hiddenByUser'])assert.equal(chooseStageMode({config:{enabled:true},env:{...env,[key]:true}}).mode,'off');
  assert.equal(chooseStageMode({config:{enabled:true},env:{...env,webgl2:false}}).reason,'no-webgl2');
});

test('a failing renderer load is contained and leaves no stage',async()=>{
  const listeners=[];
  const win={document:{createElement:()=>({getContext:()=>({})}),hidden:false},matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),
    navigator:{},sessionStorage:{getItem:()=>null},cancelAnimationFrame(){},requestAnimationFrame(){},setTimeout};
  const container={hidden:true,replaceChildren(){},append(){},getBoundingClientRect:()=>stageRect};
  const states=[];
  const stage=await mountCharacterStage({win,container,config:{enabled:true,assetUrl:'/x.glb'},registry,
    loadModules:async()=>{throw Error('network');},onState:s=>states.push(s.mode+':'+s.reason)});
  assert.deepEqual(states,['3d:capable','loading:capable','off:load-failed']);
  assert.equal(container.hidden,true);assert.equal(stage.focus({versionId:VERSION,provisionId:'visible'}).action,'none');
  assert.equal(listeners.length,0);
});

test('server exposes the stage only when enabled and serves rewritten same-origin three.js',async()=>{
  for(const enabled of [false,true]){
    const runtime=await buildApplicationRuntime({demo:true,env:{ASK_BILL_STAGE:'development',...(enabled?{ASK_BILL_CHARACTER_STAGE:'true'}:{})}});
    await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+runtime.server.address().port;
    try{
      assert.deepEqual(await (await fetch(base+'/experience/character.json')).json(),enabled?{enabled:true,assetUrl:'/experience/assets/bill.glb',backend:'auto',follow:true,status:'candidate-not-approved'}:{enabled:false});
      const glb=await fetch(base+'/experience/assets/bill.glb');
      assert.equal(glb.status,enabled?200:404);
      if(enabled){
        assert.equal(glb.headers.get('content-type'),'model/gltf-binary');
        assert.equal(Buffer.from(await glb.arrayBuffer()).subarray(0,4).toString(),'glTF');
        const loader=await (await fetch(base+'/vendor/three/loaders/GLTFLoader.js')).text();
        assert(!loader.includes("from 'three'"));assert(loader.includes("from '/vendor/three/three.module.min.js'"));
        const gpuLoader=await (await fetch(base+'/vendor/three-webgpu/loaders/GLTFLoader.js')).text();
        assert(gpuLoader.includes("from '/vendor/three/three.webgpu.min.js'"));
        assert.equal((await fetch(base+'/vendor/three/three.webgpu.min.js')).status,200);
      }else assert.equal((await fetch(base+'/vendor/three/three.module.min.js')).status,404);
      assert.equal((await fetch(base+'/experience/character-stage.mjs')).status,200);
    }finally{await runtime.close();}
  }
});

import {normalizeWeights,createBlinkScheduler,stepGaze,createTalkVisemes,seededRandom,VISEMES} from '../packages/character/animation/face.mjs';
import {chooseDock,DOCK_SIZE} from '../packages/character/renderer/follow.mjs';
import {pickBackend} from '../packages/character/renderer/stage.mjs';

test('viseme weights are clamped and never sum above one',()=>{
  const w=normalizeWeights({a:0.9,b:0.8,c:-1,d:NaN});
  assert.equal(w.c,0);assert.equal(w.d,0);assert(Math.abs(Object.values(w).reduce((x,y)=>x+y,0)-1)<1e-9);
  assert.deepEqual(normalizeWeights({a:0.2}),{a:0.2});
});

test('blink scheduler closes and reopens within the blink window and repeats',()=>{
  const b=createBlinkScheduler({random:seededRandom(7)});let closed=0,maxGap=0,last=0,blinks=0,prev=0;
  for(let t=0;t<30000;t+=10){const c=b.closure(t);if(c>=0.99)closed++;if(c>0&&prev===0){blinks++;maxGap=Math.max(maxGap,t-last);last=t;}prev=c;assert(c>=0&&c<=1);}
  assert(blinks>=4&&blinks<=16,String(blinks));assert(maxGap<=6500,String(maxGap));assert(closed>0);
});

test('gaze follows smoothly and stays bounded',()=>{
  let g={x:0,y:0};for(let i=0;i<60;i++)g=stepGaze(g,{x:5,y:-5},1/60);
  assert(g.x>0.9&&g.x<=1&&g.y<-0.9&&g.y>=-1);
  assert.deepEqual(stepGaze({x:0.5,y:0.5},{x:0,y:0},0),{x:0.5,y:0.5});
});

test('procedural talk uses only known visemes with bounded total weight',()=>{
  const talk=createTalkVisemes({random:seededRandom(3)});
  for(let t=0;t<2000;t+=33){const w=talk.weights(t);for(const k of Object.keys(w))assert(VISEMES.includes(k),k);
    assert(Object.values(w).reduce((a,b)=>a+b,0)<=1+1e-9);}
});

test('follow mode docks only into an empty gutter wide enough for the dock',()=>{
  const need=DOCK_SIZE.width+DOCK_SIZE.margin*2;
  assert.equal(chooseDock({slotVisible:true,viewportWidth:1920,contentRight:1200}),'inline');
  assert.equal(chooseDock({slotVisible:false,viewportWidth:1920,contentRight:1200}),'dock');
  assert.equal(chooseDock({slotVisible:false,viewportWidth:1280,contentRight:1280-need+1}),'inline');
  assert.equal(chooseDock({slotVisible:false,viewportWidth:1920,contentRight:1200,followEnabled:false}),'inline');
});

test('backend selection requires a real WebGPU adapter and honours a forced WebGL 2 choice',async()=>{
  const gpu=adapter=>({navigator:{gpu:{requestAdapter:async()=>adapter}}});
  assert.equal(await pickBackend({preference:'auto',win:gpu({})}),'webgpu');
  assert.equal(await pickBackend({preference:'auto',win:gpu(null)}),'webgl2');
  assert.equal(await pickBackend({preference:'webgl2',win:gpu({})}),'webgl2');
  assert.equal(await pickBackend({preference:'webgpu',win:{navigator:{}}}),'webgl2');
  assert.equal(await pickBackend({preference:'bogus',win:{navigator:{gpu:{requestAdapter:async()=>{throw Error('x');}}}}}),'webgl2');
});
