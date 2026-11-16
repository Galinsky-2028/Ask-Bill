import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPerformanceRecorder,layoutHash,replayPerformance,validateRecording,redactEvent} from '../packages/character/performance/recorder.mjs';
import {resolvePointTarget} from '../packages/character/attention/targets.mjs';

const run=promisify(execFile),cli=fileURLToPath(new URL('../tools/performance/inspect.mjs',import.meta.url));
const VERSION='33333333-3333-4333-8333-333333333333';
const anchors=[{provisionId:'sec-1',pageRect:{x:40,y:300,width:600,height:200}},{provisionId:'sec-2',pageRect:{x:40,y:560,width:600,height:180}},
  {provisionId:'sec-3',pageRect:{x:40,y:2200,width:600,height:150}}];
const viewport={width:1280,height:800},stageRect={x:1000,y:420,width:220,height:260};

/** Record a fixed route exactly as the stage does: geometry, the decision, and cue events. */
async function fixedRoute(){
  const layout=await layoutHash({versionId:VERSION,anchors,viewport},webcrypto.subtle);
  let t=0;const rec=createPerformanceRecorder({versionId:VERSION,layout,now:()=>t});
  rec.record({type:'state',mode:'3d',reason:'ready',backend:'webgl2'});
  for(const a of anchors){
    t+=800;const anchor={visible:true,viewportRect:{...a.pageRect}};
    const registry={versionId:VERSION,resolve:()=>({...anchor,layoutRevision:1})};
    const result=resolvePointTarget({registry,focus:{versionId:VERSION,provisionId:a.provisionId},stageRect,viewport});
    rec.record({type:'focus',provisionId:a.provisionId,versionId:VERSION,stageRect,viewport,anchor,result,
      question:'what does my landlord owe me?',quote:'private text'});
  }
  t+=500;rec.record({type:'answer',phase:'answering',question:'secret'});
  t+=900;rec.record({type:'answer',phase:'supported'});
  t+=100;rec.record({type:'place',place:'dock'});
  rec.record({type:'transcript',text:'should be dropped'});
  return {rec,layout};
}

test('layout hash is order independent and sensitive to geometry and viewport',async()=>{
  const a=await layoutHash({versionId:VERSION,anchors,viewport},webcrypto.subtle);
  assert.equal(a,await layoutHash({versionId:VERSION,anchors:[...anchors].reverse(),viewport},webcrypto.subtle));
  assert.notEqual(a,await layoutHash({versionId:VERSION,anchors,viewport:{width:1279,height:800}},webcrypto.subtle));
  assert.notEqual(a,await layoutHash({versionId:VERSION,anchors:[{...anchors[0],pageRect:{...anchors[0].pageRect,y:320}},...anchors.slice(1)],viewport},webcrypto.subtle));
});

test('recordings never contain conversation text and validate as redacted',async()=>{
  const {rec}=await fixedRoute(),recording=rec.recording(),text=JSON.stringify(recording);
  for(const secret of ['landlord','private text','secret','should be dropped','question','quote','transcript'])assert(!text.includes(secret),secret);
  assert.equal(recording.events.length,7);
  validateRecording(recording);
  const tampered=structuredClone(recording);tampered.events[1].question='leak';
  assert.throws(()=>validateRecording(tampered),/RECORDING_NOT_REDACTED/);
  assert.equal(redactEvent({type:'answer',phase:'free text'}),null);
});

test('replaying the fixed route reproduces every decision with the current resolver',async()=>{
  const {rec,layout}=await fixedRoute(),recording=rec.recording();
  const result=replayPerformance(recording,{versionId:VERSION,layoutHash:layout});
  const focus=result.steps.filter(s=>s.type==='focus');
  assert.equal(focus.length,3);assert.deepEqual(result.divergences,[]);
  assert.deepEqual(focus.map(s=>s.replayed.action),['point','point','none']);
  assert.equal(focus[2].replayed.reason,'offscreen');
});

test('a different layout or version is rejected explicitly, and altered decisions are reported',async()=>{
  const {rec,layout}=await fixedRoute(),recording=rec.recording();
  assert.throws(()=>replayPerformance(recording,{versionId:VERSION,layoutHash:'0'.repeat(64)}),e=>e.code==='REPLAY_LAYOUT_MISMATCH');
  assert.throws(()=>replayPerformance(recording,{versionId:'44444444-4444-4444-8444-444444444444',layoutHash:layout}),e=>e.code==='REPLAY_VERSION_MISMATCH');
  const defect=structuredClone(recording);defect.events[1].result.side='right';
  assert.equal(replayPerformance(defect,{versionId:VERSION,layoutHash:layout}).divergences.length,1);
});

test('CLI prints a timeline, replays, and uses distinct exit codes',async()=>{
  const {rec,layout}=await fixedRoute(),dir=await mkdtemp(join(tmpdir(),'ask-bill-trace-')),file=join(dir,'trace.json');
  try{
    await writeFile(file,JSON.stringify(rec.recording()));
    const view=await run(process.execPath,[cli,file]);assert.match(view.stdout,/focus sec-1 → point/);assert.match(view.stdout,/answer supported/);
    const ok=await run(process.execPath,[cli,file,'--version',VERSION,'--layout',layout]);assert.match(ok.stdout,/divergences: 0/);
    await assert.rejects(run(process.execPath,[cli,file,'--version',VERSION,'--layout','f'.repeat(64)]),e=>e.code===3&&/REPLAY_LAYOUT_MISMATCH/.test(e.stderr));
    const bad=rec.recording();bad.events[1].result.side='right';await writeFile(file,JSON.stringify(bad));
    await assert.rejects(run(process.execPath,[cli,file,'--version',VERSION,'--layout',layout]),e=>e.code===2&&/DIVERGED/.test(e.stdout));
  }finally{await rm(dir,{recursive:true,force:true});}
});
