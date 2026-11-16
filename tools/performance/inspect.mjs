/** Performance trace viewer and replayer (AB-076).
 *
 *   node tools/performance/inspect.mjs trace.json                         # validate + timeline
 *   node tools/performance/inspect.mjs trace.json --version <uuid> --layout <sha256>   # replay
 *
 * Exit codes: 0 ok, 2 replay divergence, 3 version/layout mismatch, 1 invalid or unredacted trace.
 */
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {validateRecording,replayPerformance,ReplayError} from '../../packages/character/performance/recorder.mjs';

export function timeline(recording){
  const lines=[`version ${recording.versionId}  layout ${recording.layoutHash.slice(0,12)}…  events ${recording.events.length}${recording.dropped?` (dropped ${recording.dropped})`:''}`];
  for(const e of recording.events){
    const t=(e.t/1000).toFixed(2).padStart(8)+'s ';
    if(e.type==='focus')lines.push(t+`focus ${e.provisionId} → ${e.result.action}${e.result.action==='point'?` ${e.result.side} yaw=${e.result.gaze.yaw}`:` (${e.result.reason})`}`);
    else if(e.type==='layout')lines.push(t+`layout → ${e.layoutHash.slice(0,12)}…`);
    else lines.push(t+e.type+' '+(e.phase??e.clip??e.place??`${e.mode}:${e.reason}${e.backend?' '+e.backend:''}`));
  }
  return lines.join('\n');
}

async function main(argv){
  const [file,...rest]=argv;if(!file)throw new ReplayError('USAGE');
  const options={};for(let i=0;i<rest.length;i+=2){if(rest[i]==='--version')options.versionId=rest[i+1];else if(rest[i]==='--layout')options.layoutHash=rest[i+1];else throw new ReplayError('USAGE');}
  const recording=validateRecording(JSON.parse(await readFile(file,'utf8')));
  process.stdout.write(timeline(recording)+'\n');
  if(!options.versionId&&!options.layoutHash)return 0;
  const result=replayPerformance(recording,options);
  process.stdout.write(`replayed ${result.steps.filter(s=>s.type==='focus').length} focus decisions, divergences: ${result.divergences.length}\n`);
  for(const d of result.divergences)process.stdout.write(`  DIVERGED at ${(d.t/1000).toFixed(2)}s ${d.provisionId}: recorded ${JSON.stringify(d.recorded)} replayed ${JSON.stringify(d.replayed)}\n`);
  return result.divergences.length?2:0;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(error=>{
    process.stderr.write('Performance trace rejected: '+(error.code??'INVALID')+(error.detail?' '+JSON.stringify(error.detail):'')+'\n');
    process.exitCode=['REPLAY_VERSION_MISMATCH','REPLAY_LAYOUT_MISMATCH'].includes(error.code)?3:1;
  });
}
