/** Privacy-minimized aggregate telemetry (AB-103).
 *
 * Records only bounded aggregate counters: a fixed route class (never the path, IDs or query),
 * a status class, a latency bucket and allowlisted operational event names. It stores no question
 * text, audio, cookies, IP addresses, user agents, publisher drafts or secrets, and cannot be used
 * to profile a visitor. Counters reset on process restart; a scraper or uptime probe aggregates.
 */
import {timingSafeEqual,createHash} from 'node:crypto';

export const ROUTE_CLASSES=Object.freeze(['reader','api','publisher','health','static','info','other']);
export const STATUS_CLASSES=Object.freeze(['2xx','3xx','4xx','5xx']);
export const LATENCY_BUCKETS_MS=Object.freeze([50,100,250,500,1000,2500,5000,10000]);
export const EVENT_NAMES=Object.freeze(['readiness_failed','provider_failure','provider_timeout','quota_exceeded',
  'generation_rejected','speech_failure','transcription_failure','publisher_auth_failure','job_dead_lettered','source_stale']);

export function routeClass(url){
  const path=typeof url==='string'?url.split('?')[0]:'';
  if(path.startsWith('/health/'))return 'health';
  if(path.startsWith('/api/'))return 'api';
  if(path==='/admin'||path.startsWith('/admin/'))return 'publisher';
  if(path==='/'||path==='/bills'||path.startsWith('/bills/')||path==='/learn'||path.startsWith('/learn/')||/^\/[a-z]{2}(\/|$)/.test(path))return 'reader';
  if(/\.(?:mjs|js|css|svg|png|webp|woff2|json|glb)$/.test(path))return 'static';
  if(['/privacy','/accessibility','/about'].includes(path))return 'info';
  return 'other';
}
export function statusClass(status){
  const n=Number(status);if(!Number.isInteger(n)||n<200||n>599)return '5xx';
  return STATUS_CLASSES[Math.floor(n/100)-2];
}
function bucket(ms){
  for(const limit of LATENCY_BUCKETS_MS)if(ms<=limit)return String(limit);
  return 'inf';
}

export function createTelemetry({now=()=>performance.now(),clock=()=>Date.now()}={}){
  const startedAt=clock();
  const requests=Object.fromEntries(ROUTE_CLASSES.map(route=>[route,Object.fromEntries(STATUS_CLASSES.map(s=>[s,0]))]));
  const latency=Object.fromEntries(ROUTE_CLASSES.map(route=>[route,Object.fromEntries([...LATENCY_BUCKETS_MS.map(String),'inf'].map(b=>[b,0]))]));
  const events=Object.fromEntries(EVENT_NAMES.map(name=>[name,0]));
  let inflight=0;
  return {
    /** Observe one HTTP exchange; safe to attach as a passive 'request' listener. */
    observe(req,res){
      const route=routeClass(req.url),started=now();inflight++;let done=false;
      const finish=()=>{if(done)return;done=true;inflight--;
        requests[route][statusClass(res.statusCode)]++;latency[route][bucket(now()-started)]++;};
      res.once('finish',finish);res.once('close',finish);
    },
    record(name){if(!Object.hasOwn(events,name))throw Error('TELEMETRY_EVENT_UNKNOWN');events[name]++;},
    snapshot(){
      return {product:'ask-bill',schema:1,uptimeSeconds:Math.round((clock()-startedAt)/1000),inflight,
        requests:structuredClone(requests),latencyMs:structuredClone(latency),events:{...events}};
    }
  };
}

/** Evaluate declarative alert rules against one snapshot. Returns firing alerts only. */
export function evaluateAlerts(snapshot,rules){
  const firing=[];
  for(const rule of rules){
    if(rule.kind==='error_rate'){
      const counts=rule.routes.reduce((acc,route)=>{const r=snapshot.requests[route]??{};
        acc.total+=STATUS_CLASSES.reduce((n,s)=>n+(r[s]??0),0);acc.errors+=r['5xx']??0;return acc;},{total:0,errors:0});
      if(counts.total>=rule.minRequests&&counts.errors/counts.total>rule.maxRatio)
        firing.push({id:rule.id,severity:rule.severity,summary:rule.summary,observed:{requests:counts.total,errors5xx:counts.errors}});
    }else if(rule.kind==='slow_ratio'){
      const counts=rule.routes.reduce((acc,route)=>{const l=snapshot.latencyMs[route]??{};
        for(const [b,n] of Object.entries(l)){acc.total+=n;if(b==='inf'||Number(b)>rule.thresholdMs)acc.slow+=n;}return acc;},{total:0,slow:0});
      if(counts.total>=rule.minRequests&&counts.slow/counts.total>rule.maxRatio)
        firing.push({id:rule.id,severity:rule.severity,summary:rule.summary,observed:{requests:counts.total,slow:counts.slow}});
    }else if(rule.kind==='event_count'){
      const n=snapshot.events[rule.event]??0;
      if(n>rule.maxCount)firing.push({id:rule.id,severity:rule.severity,summary:rule.summary,observed:{[rule.event]:n}});
    }else throw Error('ALERT_RULE_UNKNOWN');
  }
  return firing;
}

/** Constant-time bearer check; an unset token disables the endpoint entirely. */
export function authorizedMetricsRequest(req,token){
  if(typeof token!=='string'||token.length<32)return false;
  const header=req.headers?.authorization;
  if(typeof header!=='string'||!header.startsWith('Bearer '))return false;
  const a=createHash('sha256').update(header.slice(7)).digest(),b=createHash('sha256').update(token).digest();
  return timingSafeEqual(a,b);
}
