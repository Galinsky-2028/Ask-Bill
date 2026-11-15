/** Clip controller over three.js AnimationActions (AB-064, partial).
 *
 * Exactly one base action is active at a time. Switching cross-fades, one-shot gestures return
 * to Idle when finished, and cancel() always fades back to Idle. Missing clips degrade to Idle
 * rather than throwing, so an incomplete candidate asset never breaks the stage.
 */
export const SEMANTIC_CLIPS=Object.freeze({idle:'Idle',talk:'Talk',point:'Point',wave:'Wave',walk:'WalkFunny',
  celebrate:'Celebrate',look:'Look',laugh:'Laugh'});
const ONE_SHOT=new Set(['point','wave','celebrate','laugh','look']);
export const LOOP_ONCE=2200,LOOP_REPEAT=2201; // three.js LoopOnce / LoopRepeat

export function createClipController({actions,fadeSeconds=0.25}={}){
  if(!actions||typeof actions.get!=='function')throw Error('CLIP_ACTIONS_REQUIRED');
  if(!(fadeSeconds>=0&&fadeSeconds<=2))throw Error('CLIP_FADE_INVALID');
  let current=null,currentSemantic=null,disposed=false;
  const resolve=semantic=>{
    const clip=SEMANTIC_CLIPS[semantic];
    if(clip&&actions.get(clip))return {semantic,action:actions.get(clip)};
    const idle=actions.get(SEMANTIC_CLIPS.idle);
    return idle?{semantic:'idle',action:idle}:null;
  };
  function play(semantic){
    if(disposed)return null;
    const next=resolve(semantic);if(!next)return null;
    if(next.action===current&&!ONE_SHOT.has(next.semantic))return currentSemantic;
    const once=ONE_SHOT.has(next.semantic);
    next.action.reset();
    next.action.setLoop(once?LOOP_ONCE:LOOP_REPEAT,once?1:Infinity);
    next.action.clampWhenFinished=once;
    if(current&&current!==next.action){current.fadeOut(fadeSeconds);next.action.fadeIn(fadeSeconds);}
    next.action.play();
    current=next.action;currentSemantic=next.semantic;
    return currentSemantic;
  }
  return {
    play,
    /** Wire to mixer 'finished' events: a completed one-shot returns to Idle. */
    finished(action){if(!disposed&&action===current&&ONE_SHOT.has(currentSemantic))play('idle');},
    cancel(){return play('idle');},
    get current(){return currentSemantic;},
    dispose(){disposed=true;for(const name of Object.values(SEMANTIC_CLIPS))actions.get(name)?.stop();current=null;currentSemantic=null;}
  };
}
