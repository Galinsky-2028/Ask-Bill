/** Reader load harness (AB-102, partial).
 *
 * Drives concurrent GET requests against public reading routes only. It never posts questions,
 * never opens a provider-backed generation and sends no cookies, so it cannot incur AI/voice spend.
 * Remote targets require an explicit --allow-remote flag, and request counts are capped.
 *
 * Usage:
 *   node tools/perf/load.mjs --target http://127.0.0.1:4100 --paths /bills,/learn --concurrency 20 --requests 500 --p95-ms 500
 */
import {pathToFileURL} from 'node:url';

const LOOPBACK=new Set(['127.0.0.1','localhost','[::1]']);
export const MAX_REQUESTS=20000,MAX_CONCURRENCY=200;
const PUBLIC_PATH=/^\/(?:bills(?:\/[A-Za-z0-9._~\/-]*)?|learn(?:\/[A-Za-z0-9._~\/-]*)?|privacy|accessibility|about|health\/(?:live|ready))?$/;

export function loadSettings({target,paths=['/bills'],concurrency=10,requests=200,p95Ms=1000,maxErrorRatio=0.01,allowRemote=false,timeoutMs=15000}={}){
  let url;try{url=new URL(target);}catch{throw Error('LOAD_TARGET_INVALID');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('LOAD_TARGET_INVALID');
  if(!LOOPBACK.has(url.hostname)&&allowRemote!==true)throw Error('LOAD_REMOTE_REQUIRES_EXPLICIT_FLAG');
  if(!Array.isArray(paths)||!paths.length||paths.length>50||paths.some(p=>typeof p!=='string'||!PUBLIC_PATH.test(p)))throw Error('LOAD_PATHS_PUBLIC_READING_ONLY');
  for(const [value,max] of [[concurrency,MAX_CONCURRENCY],[requests,MAX_REQUESTS],[timeoutMs,120000]])
    if(!Number.isSafeInteger(value)||value<1||value>max)throw Error('LOAD_LIMIT_INVALID');
  if(!(p95Ms>0)||!(maxErrorRatio>=0&&maxErrorRatio<=1))throw Error('LOAD_BUDGET_INVALID');
  return {origin:url.origin,paths,concurrency,requests,p95Ms,maxErrorRatio,timeoutMs};
}

const percentile=(sorted,p)=>sorted.length?sorted[Math.min(sorted.length-1,Math.ceil(p/100*sorted.length)-1)]:null;

export async function runLoad(options,{fetchImpl=fetch,now=()=>performance.now()}={}){
  const settings=loadSettings(options);
  const latencies=[],statuses={};let next=0,errors=0;
  const started=now();
  async function worker(){
    while(next<settings.requests){
      const index=next++,path=settings.paths[index%settings.paths.length],t0=now();
      let status='network_error';
      try{
        const res=await fetchImpl(settings.origin+path,{redirect:'manual',signal:AbortSignal.timeout(settings.timeoutMs),headers:{'user-agent':'ask-bill-load-harness'}});
        await res.arrayBuffer();status=String(res.status);
        if(res.status>=500)errors++;
      }catch{errors++;}
      latencies.push(now()-t0);statuses[status]=(statuses[status]??0)+1;
    }
  }
  await Promise.all(Array.from({length:Math.min(settings.concurrency,settings.requests)},worker));
  const elapsedMs=now()-started,sorted=[...latencies].sort((a,b)=>a-b);
  const p95=percentile(sorted,95),errorRatio=errors/settings.requests;
  const round=v=>v===null?null:Math.round(v*10)/10;
  return {product:'ask-bill',harness:'reader-load-v1',origin:settings.origin,paths:settings.paths,requests:settings.requests,
    concurrency:settings.concurrency,elapsedMs:round(elapsedMs),throughputPerSecond:round(settings.requests/(elapsedMs/1000)),
    latencyMs:{p50:round(percentile(sorted,50)),p95:round(p95),p99:round(percentile(sorted,99)),max:round(sorted.at(-1)??null)},
    statuses,errorRatio:round(errorRatio*1000)/1000,
    budget:{p95Ms:settings.p95Ms,maxErrorRatio:settings.maxErrorRatio},
    passed:p95!==null&&p95<=settings.p95Ms&&errorRatio<=settings.maxErrorRatio};
}

function parseArgs(argv){
  const out={};
  for(let i=0;i<argv.length;i++){
    const key=argv[i];
    if(key==='--allow-remote'){out.allowRemote=true;continue;}
    const value=argv[++i];if(value===undefined)throw Error('LOAD_ARGUMENTS');
    if(key==='--target')out.target=value;
    else if(key==='--paths')out.paths=value.split(',');
    else if(key==='--concurrency')out.concurrency=Number(value);
    else if(key==='--requests')out.requests=Number(value);
    else if(key==='--p95-ms')out.p95Ms=Number(value);
    else if(key==='--max-error-ratio')out.maxErrorRatio=Number(value);
    else throw Error('LOAD_ARGUMENTS');
  }
  return out;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const result=await runLoad(parseArgs(process.argv.slice(2)));
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  if(!result.passed)process.exitCode=2;
}
