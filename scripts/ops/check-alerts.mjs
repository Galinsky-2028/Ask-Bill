/** Scheduled alert check and delivery (AB-103).
 *
 * Fetches the token-gated aggregate snapshot from /health/metrics, evaluates infra/alerts/rules.json
 * and, for page/ticket alerts, POSTs a short aggregate-only message to ASK_BILL_ALERT_WEBHOOK_URL
 * (Slack/Discord/Teams-compatible JSON with `text` and `content`). Without a webhook, firing alerts
 * make the process exit 2, so a scheduled CI run fails and notifies the repository owner.
 * An unreachable or not-ready service is itself a page alert.
 *
 *   ASK_BILL_ALERT_TARGET=https://ask-bill.onrender.com ASK_BILL_METRICS_TOKEN=… node scripts/ops/check-alerts.mjs
 */
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {evaluateAlerts} from '../../packages/telemetry/index.mjs';

const DELIVER=new Set(['page','ticket']);

export function alertSettings(env){
  let target;try{target=new URL(env.ASK_BILL_ALERT_TARGET??'');}catch{throw Error('ALERT_TARGET_INVALID');}
  if(target.protocol!=='https:'&&!['127.0.0.1','localhost'].includes(target.hostname))throw Error('ALERT_TARGET_INVALID');
  if(target.pathname!=='/'||target.search||target.username)throw Error('ALERT_TARGET_INVALID');
  const token=env.ASK_BILL_METRICS_TOKEN;if(typeof token!=='string'||token.length<32)throw Error('ALERT_TOKEN_REQUIRED');
  let webhook=null;
  if(env.ASK_BILL_ALERT_WEBHOOK_URL){try{webhook=new URL(env.ASK_BILL_ALERT_WEBHOOK_URL);}catch{throw Error('ALERT_WEBHOOK_INVALID');}
    if(webhook.protocol!=='https:')throw Error('ALERT_WEBHOOK_INVALID');}
  return {origin:target.origin,token,webhook};
}

export async function checkAlerts(settings,rules,{fetchImpl=fetch,timeoutMs=60000}={}){
  let firing=[],snapshot=null;
  try{
    const ready=await fetchImpl(settings.origin+'/health/ready',{signal:AbortSignal.timeout(timeoutMs)});
    if(ready.status!==200)firing.push({id:'service-not-ready',severity:'page',summary:'Health check is not ready',observed:{status:ready.status}});
    const res=await fetchImpl(settings.origin+'/health/metrics',{headers:{authorization:'Bearer '+settings.token},signal:AbortSignal.timeout(timeoutMs)});
    if(res.status!==200)firing.push({id:'metrics-unavailable',severity:'ticket',summary:'Metrics endpoint unavailable (token unset or wrong)',observed:{status:res.status}});
    else{snapshot=await res.json();firing.push(...evaluateAlerts(snapshot,rules));}
  }catch{
    firing.push({id:'service-unreachable',severity:'page',summary:'Service did not respond (down, or cold start exceeded the timeout)',observed:{}});
  }
  const deliverable=firing.filter(a=>DELIVER.has(a.severity));
  let delivered=false;
  if(deliverable.length&&settings.webhook){
    const text='Ask Bill alerts ('+settings.origin+'):\n'+deliverable.map(a=>`[${a.severity}] ${a.id}: ${a.summary} ${JSON.stringify(a.observed)}`).join('\n');
    const res=await fetchImpl(settings.webhook.href,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({text,content:text.slice(0,1900)}),signal:AbortSignal.timeout(15000)});
    delivered=res.ok;
  }
  return {product:'ask-bill',checkedAt:new Date().toISOString(),origin:settings.origin,firing,deliverable:deliverable.length,delivered,
    uptimeSeconds:snapshot?.uptimeSeconds??null};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const rules=JSON.parse(await readFile(new URL('../../infra/alerts/rules.json',import.meta.url),'utf8')).rules;
    const result=await checkAlerts(alertSettings(process.env),rules);
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
    if(result.deliverable&&!result.delivered)process.exitCode=2;
  }catch(error){process.stderr.write('Ask Bill alert check failed: '+error.message+'\n');process.exitCode=1;}
}
