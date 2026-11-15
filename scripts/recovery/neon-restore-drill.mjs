/** Neon point-in-time restore drill (AB-104).
 *
 * Creates an isolated branch of the Ask Bill project at a past timestamp (default: 5 minutes ago),
 * waits for its compute to become ready, records timings, and deletes the branch unless --keep is
 * passed. It never touches the default branch, never prints passwords, and refuses any project ID
 * other than the one given explicitly. Run the restore fingerprint against the kept branch with its
 * owner URL (from the Neon console) to verify content, then delete the branch.
 *
 *   NEON_API_KEY=… node scripts/recovery/neon-restore-drill.mjs --project <id> [--at <ISO time>] [--keep]
 */
import {pathToFileURL} from 'node:url';

const API='https://console.neon.tech/api/v2';
const PROJECT=/^[a-z]+-[a-z]+-[0-9]{6,12}$/;

export function drillSettings(args,env,clock=()=>Date.now()){
  const out={keep:false,at:null,project:null};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--keep'){out.keep=true;continue;}
    const value=args[++i];if(value===undefined)throw Error('DRILL_ARGUMENTS');
    if(args[i-1]==='--project')out.project=value;else if(args[i-1]==='--at')out.at=value;else throw Error('DRILL_ARGUMENTS');
  }
  if(!PROJECT.test(out.project??''))throw Error('DRILL_PROJECT_REQUIRED');
  if(typeof env.NEON_API_KEY!=='string'||!env.NEON_API_KEY)throw Error('DRILL_API_KEY_REQUIRED');
  const at=out.at===null?new Date(clock()-5*60000):new Date(out.at);
  if(Number.isNaN(at.getTime())||at.getTime()>clock())throw Error('DRILL_TIMESTAMP_INVALID');
  return {project:out.project,at:at.toISOString(),keep:out.keep,apiKey:env.NEON_API_KEY};
}

export async function runRestoreDrill(settings,{fetchImpl=fetch,clock=()=>Date.now(),wait=ms=>new Promise(r=>setTimeout(r,ms)),maxPolls=90}={}){
  const call=async(method,path,body)=>{
    const res=await fetchImpl(API+path,{method,headers:{authorization:'Bearer '+settings.apiKey,accept:'application/json',
      ...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    const json=await res.json().catch(()=>({}));
    if(!res.ok)throw Object.assign(Error('NEON_API_'+res.status),{detail:json?.message});
    return json;
  };
  const awaitOperations=async operations=>{
    for(const op of operations??[]){
      for(let i=0;;i++){
        const status=(await call('GET',`/projects/${settings.project}/operations/${op.id}`)).operation?.status;
        if(status==='finished'||status==='skipped')break;
        if(['failed','error','cancelled'].includes(status)||i>=maxPolls)throw Error('DRILL_OPERATION_'+(status??'timeout').toUpperCase());
        await wait(2000);
      }
    }
  };
  const started=clock(),name='restore-drill-'+new Date(started).toISOString().replace(/[:.]/g,'-');
  const created=await call('POST',`/projects/${settings.project}/branches`,
    {branch:{name,parent_timestamp:settings.at},endpoints:[{type:'read_write'}]});
  const branch=created.branch,endpoint=created.endpoints?.[0];
  if(!branch?.id||!endpoint?.host)throw Error('DRILL_BRANCH_INCOMPLETE');
  if(branch.default||branch.primary)throw Error('DRILL_REFUSES_DEFAULT_BRANCH');
  let deleted=false,readyMs=null;
  try{
    await awaitOperations(created.operations);
    readyMs=clock()-started;
    if(!settings.keep){await awaitOperations((await call('DELETE',`/projects/${settings.project}/branches/${branch.id}`)).operations);deleted=true;}
  }catch(error){
    if(!settings.keep&&!deleted){try{await call('DELETE',`/projects/${settings.project}/branches/${branch.id}`);deleted=true;}catch{}}
    throw error;
  }
  return {product:'ask-bill',drill:'neon-pitr-v1',project:settings.project,restoredTo:settings.at,branch:{id:branch.id,name,host:endpoint.host},
    restoreReadyMs:readyMs,totalMs:clock()-started,deleted,
    next:settings.keep?'Run scripts/recovery/fingerprint.mjs against this branch and production, compare, then delete the branch.':null};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const result=await runRestoreDrill(drillSettings(process.argv.slice(2),process.env));
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  }catch(error){process.stderr.write('Ask Bill restore drill failed: '+(error.message??'unknown')+'\n');process.exitCode=1;}
}
