/** Citation → gaze/point target resolution (AB-070, partial).
 *
 * Bill may point only at text that (1) belongs to the exact source version the reader is showing,
 * (2) is a registered provision anchor and (3) is at least partly inside the viewport. Anything else
 * yields no pointing: the character never gestures toward uncited, other-version or hidden text.
 * The resolver takes focus from the trusted reader event, never from model output.
 */
const clamp=(v,min,max)=>Math.min(max,Math.max(min,v));

export function resolvePointTarget({registry,focus,stageRect,viewport}){
  if(!registry||!focus||typeof focus.provisionId!=='string'||typeof focus.versionId!=='string')return {action:'none',reason:'no-focus'};
  if(registry.versionId!==focus.versionId)return {action:'none',reason:'version-mismatch'};
  let position;
  try{position=registry.resolve({sourceVersionId:focus.versionId,provisionId:focus.provisionId});}
  catch{return {action:'none',reason:'unknown-anchor'};}
  const r=position?.viewportRect;
  if(!position?.visible||!r)return {action:'none',reason:'not-rendered'};
  const inView=r.y<viewport.height&&r.y+r.height>0&&r.x<viewport.width&&r.x+r.width>0;
  if(!inView)return {action:'none',reason:'offscreen'};
  // Aim at the visible part of the provision's first lines.
  const top=Math.max(r.y,0),targetX=r.x+Math.min(r.width,240)/2,targetY=top+Math.min(r.height,80)/2;
  const cx=stageRect.x+stageRect.width/2,cy=stageRect.y+stageRect.height/2;
  const dx=targetX-cx,dy=targetY-cy;
  return {action:'point',provisionId:focus.provisionId,versionId:focus.versionId,layoutRevision:position.layoutRevision,
    gaze:{yaw:clamp(dx/(viewport.width/2),-1,1),pitch:clamp(-dy/(viewport.height/2),-1,1)},
    side:dx<0?'left':'right'};
}
