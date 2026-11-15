import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {createTelemetry,routeClass,statusClass,evaluateAlerts,authorizedMetricsRequest} from '../packages/telemetry/index.mjs';
import {buildApplicationRuntime} from '../apps/web/application/start.mjs';

const rules=JSON.parse(await readFile(new URL('../infra/alerts/rules.json',import.meta.url),'utf8')).rules;
const fakeExchange=(telemetry,url,status,elapsed,clock)=>{
  const res=new EventEmitter();res.statusCode=status;telemetry.observe({url},res);clock.t+=elapsed;res.emit('finish');res.emit('close');
};

test('route classes never retain paths, IDs or query strings',()=>{
  assert.equal(routeClass('/bills/0d8f/versions/abc?q=private+question'),'reader');
  assert.equal(routeClass('/api/sessions/123/questions'),'api');
  assert.equal(routeClass('/admin/bills/1'),'publisher');
  assert.equal(routeClass('/health/ready'),'health');
  assert.equal(routeClass('/reader-client.mjs'),'static');
  assert.equal(routeClass('/privacy'),'info');
  assert.equal(routeClass('/wp-login.php'),'other');
  assert.equal(statusClass(503),'5xx');assert.equal(statusClass('bogus'),'5xx');assert.equal(statusClass(204),'2xx');
});

test('snapshot is bounded aggregates without request details',()=>{
  const clock={t:0},telemetry=createTelemetry({now:()=>clock.t});
  fakeExchange(telemetry,'/bills/secret-id?q=my+private+question',200,30,clock);
  fakeExchange(telemetry,'/api/x',500,2000,clock);
  const snap=telemetry.snapshot(),text=JSON.stringify(snap);
  assert.equal(snap.requests.reader['2xx'],1);assert.equal(snap.requests.api['5xx'],1);
  assert.equal(snap.latencyMs.reader['50'],1);assert.equal(snap.latencyMs.api['2500'],1);assert.equal(snap.inflight,0);
  assert(!/secret-id|private|question/.test(text));
  assert.throws(()=>telemetry.record('raw_question'),/TELEMETRY_EVENT_UNKNOWN/);
});

test('alert rules fire on concrete failures and stay quiet when healthy',()=>{
  const clock={t:0},telemetry=createTelemetry({now:()=>clock.t});
  for(let i=0;i<30;i++)fakeExchange(telemetry,'/bills',200,20,clock);
  assert.deepEqual(evaluateAlerts(telemetry.snapshot(),rules),[]);
  for(let i=0;i<5;i++)fakeExchange(telemetry,'/bills',503,20,clock);
  telemetry.record('readiness_failed');
  const ids=evaluateAlerts(telemetry.snapshot(),rules).map(a=>a.id).sort();
  assert.deepEqual(ids,['reader-5xx','readiness']);
  assert.throws(()=>evaluateAlerts(telemetry.snapshot(),[{kind:'unknown'}]),/ALERT_RULE_UNKNOWN/);
});

test('metrics authorization requires a long configured token and exact bearer value',()=>{
  const token='t'.repeat(40);
  assert.equal(authorizedMetricsRequest({headers:{authorization:'Bearer '+token}},token),true);
  assert.equal(authorizedMetricsRequest({headers:{authorization:'Bearer '+token}},null),false);
  assert.equal(authorizedMetricsRequest({headers:{authorization:'Bearer short'}},'short'),false);
  assert.equal(authorizedMetricsRequest({headers:{authorization:'Bearer wrong'}},token),false);
  assert.equal(authorizedMetricsRequest({headers:{}},token),false);
});

test('application serves metrics only to the operator token and counts requests',async()=>{
  const token='m'.repeat(48);
  const runtime=await buildApplicationRuntime({demo:true,env:{ASK_BILL_STAGE:'development',ASK_BILL_METRICS_TOKEN:token}});
  await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+runtime.server.address().port;
  try{
    assert.equal((await fetch(base+'/bills')).status,200);
    assert.equal((await fetch(base+'/health/metrics')).status,404);
    assert.equal((await fetch(base+'/health/metrics',{headers:{authorization:'Bearer nope'}})).status,404);
    const ok=await fetch(base+'/health/metrics',{headers:{authorization:'Bearer '+token}});
    assert.equal(ok.status,200);
    const snap=await ok.json();
    assert.equal(snap.requests.reader['2xx'],1);
    assert.equal(snap.requests.health['4xx'],2);
  }finally{await runtime.close();}
});
