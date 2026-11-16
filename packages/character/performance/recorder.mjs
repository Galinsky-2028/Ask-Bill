/** Performance recorder and deterministic replay (AB-076).
 *
 * Records what the character stage *decided* (focus → point/none, answer phases, clips, docking)
 * with the version, a layout hash and the exact geometry each decision used. Recordings carry
 * no conversation: every event is rebuilt from an allowlist of IDs, enums and numbers, so question
 * text, answers, quotes or audio cannot enter a trace even if a caller passes them.
 * Replay re-derives each pointing decision from the recorded geometry with the current resolver
 * and rejects a different source version or layout explicitly.
 */
import {resolvePointTarget} from '../attention/targets.mjs';

export const RECORDING_SCHEMA=1;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ID=/^[A-Za-z0-9._:-]{1,80}$/;
const PHASES=new Set(['answering','speaking','supported','unsupported','done','idle']);
const PLACES=new Set(['inline','dock']);
const MAX_EVENTS=2000;

export class ReplayError extends Error{constructor(code,detail){super(code);this.name='ReplayError';this.code=code;this.detail=detail;}}
const num=v=>Number.isFinite(v)?Math.round(v*100)/100:0;
const rect=r=>r?{x:num(r.x),y:num(r.y),width:num(r.width),height:num(r.height)}:null;
const id=v=>typeof v==='string'&&ID.test(v)?v:null;

/** Order-independent SHA-256 of rounded anchor geometry and viewport (Web Crypto or node:crypto). */
export async function layoutHash({versionId,anchors,viewport},subtle=globalThis.crypto?.subtle){
  const rows=[...anchors].map(a=>[a.provisionId,Math.round(a.pageRect.x),Math.round(a.pageRect.y),Math.round(a.pageRect.width),Math.round(a.pageRect.height)].join(':')).sort();
  const text=[versionId,Math.round(viewport.width),Math.round(viewport.height),...rows].join('\n');
  const bytes=new Uint8Array(await subtle.digest('SHA-256',new TextEncoder().encode(text)));
  return [...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
}

/** Rebuild an event from allowlisted fields only. Unknown types are dropped. */
export function redactEvent(event){
  const t=num(event?.t);
  switch(event?.type){
    case 'focus':{
      const r=event.result??{};
      return {t,type:'focus',provisionId:id(event.provisionId),versionId:id(event.versionId),
        stageRect:rect(event.stageRect),viewport:event.viewport?{width:num(event.viewport.width),height:num(event.viewport.height)}:null,
        anchor:event.anchor?{visible:event.anchor.visible===true,viewportRect:rect(event.anchor.viewportRect)}:null,
        result:{action:r.action==='point'?'point':'none',reason:id(r.reason),side:r.side==='left'||r.side==='right'?r.side:null,
          gaze:r.gaze?{yaw:num(r.gaze.yaw),pitch:num(r.gaze.pitch)}:null}};
    }
    case 'answer':return PHASES.has(event.phase)?{t,type:'answer',phase:event.phase}:null;
    case 'clip':return id(event.clip)?{t,type:'clip',clip:event.clip}:null;
    case 'place':return PLACES.has(event.place)?{t,type:'place',place:event.place}:null;
    case 'state':return {t,type:'state',mode:id(event.mode),reason:id(event.reason),backend:event.backend==='webgpu'||event.backend==='webgl2'?event.backend:null};
    default:return null;
  }
}

export function createPerformanceRecorder({versionId,layout,seed=null,now=()=>performance.now()}){
  if(!UUID.test(versionId??''))throw new ReplayError('RECORDING_VERSION_REQUIRED');
  if(!/^[a-f0-9]{64}$/.test(layout??''))throw new ReplayError('RECORDING_LAYOUT_REQUIRED');
  const start=now(),events=[];let dropped=0;
  return {
    record(event){
      const clean=redactEvent({...event,t:now()-start});
      if(!clean)return;
      if(events.length>=MAX_EVENTS){dropped++;return;}
      events.push(clean);
    },
    /** Layout changed (resize, reflow): later events belong to a new layout hash. */
    relayout(hash){if(/^[a-f0-9]{64}$/.test(hash))events.push({t:num(now()-start),type:'layout',layoutHash:hash});},
    recording(){return {schema:RECORDING_SCHEMA,product:'ask-bill',kind:'performance',versionId,layoutHash:layout,
      seed:Number.isSafeInteger(seed)?seed:null,dropped,events:events.map(e=>({...e}))};}
  };
}

/** Validate a stored recording: schema, IDs, and that nothing outside the allowlist is present. */
export function validateRecording(recording){
  if(recording?.schema!==RECORDING_SCHEMA||recording.kind!=='performance')throw new ReplayError('RECORDING_SCHEMA');
  if(!UUID.test(recording.versionId??'')||!/^[a-f0-9]{64}$/.test(recording.layoutHash??''))throw new ReplayError('RECORDING_IDENTITY');
  if(!Array.isArray(recording.events)||recording.events.length>MAX_EVENTS)throw new ReplayError('RECORDING_EVENTS');
  for(const event of recording.events){
    const clean=event.type==='layout'?event:redactEvent(event);
    if(!clean||JSON.stringify(clean)!==JSON.stringify(event))throw new ReplayError('RECORDING_NOT_REDACTED',event.type);
  }
  return recording;
}

/**
 * Replay against the *current* code. The caller states which version and layout it is reproducing;
 * any difference is rejected explicitly rather than replayed against the wrong geometry.
 * Returns per-focus comparisons; `divergences` lists decisions the current resolver makes differently.
 */
export function replayPerformance(recording,{versionId,layoutHash:expectedLayout}){
  validateRecording(recording);
  if(versionId!==recording.versionId)throw new ReplayError('REPLAY_VERSION_MISMATCH',{expected:versionId,recorded:recording.versionId});
  if(expectedLayout!==recording.layoutHash)throw new ReplayError('REPLAY_LAYOUT_MISMATCH',{expected:expectedLayout,recorded:recording.layoutHash});
  const steps=[],divergences=[];let layout=recording.layoutHash;
  for(const event of recording.events){
    if(event.type==='layout'){layout=event.layoutHash;continue;}
    if(event.type!=='focus'){steps.push({t:event.t,type:event.type,...(event.phase?{phase:event.phase}:{}),...(event.clip?{clip:event.clip}:{}),...(event.place?{place:event.place}:{})});continue;}
    const registry={versionId:recording.versionId,resolve:({provisionId})=>{
      if(!event.anchor||provisionId!==event.provisionId)throw Error('UNKNOWN');
      return {visible:event.anchor.visible,viewportRect:event.anchor.viewportRect,layoutRevision:0};}};
    const now=resolvePointTarget({registry,focus:{versionId:event.versionId,provisionId:event.provisionId},
      stageRect:event.stageRect,viewport:event.viewport});
    const replayed={action:now.action,reason:now.action==='none'?now.reason:null,side:now.side??null,
      gaze:now.gaze?{yaw:num(now.gaze.yaw),pitch:num(now.gaze.pitch)}:null};
    const recorded={...event.result,reason:event.result.action==='none'?event.result.reason:null};
    const same=JSON.stringify(replayed)===JSON.stringify(recorded);
    steps.push({t:event.t,type:'focus',provisionId:event.provisionId,layoutHash:layout,recorded,replayed,same});
    if(!same)divergences.push({t:event.t,provisionId:event.provisionId,recorded,replayed});
  }
  return {versionId:recording.versionId,layoutHash:recording.layoutHash,steps,divergences};
}
