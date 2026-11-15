import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {evaluateAlerts} from '../packages/telemetry/index.mjs';
import {alertSettings,checkAlerts} from '../scripts/ops/check-alerts.mjs';

const rules=JSON.parse(await readFile(new URL('../infra/alerts/rules.json',import.meta.url),'utf8')).rules;
const token='t'.repeat(40);
const healthy={requests:{},latencyMs:{},events:{},uptimeSeconds:5,
  diagnostics:{jobs:{waiting:0,leased:0,expiredLeases:0,dead:0,oldestReadySeconds:0},outbox:{pending:0,failed:0,oldestPendingSeconds:0},retention:{expiredSessions:0}}};

test('gauge rules fire on dead jobs, stalled queues and diagnostics failure only',()=>{
  assert.deepEqual(evaluateAlerts(healthy,rules),[]);
  const bad=structuredClone(healthy);bad.diagnostics.jobs.dead=2;bad.diagnostics.jobs.oldestReadySeconds=1200;
  assert.deepEqual(evaluateAlerts(bad,rules).map(a=>a.id).sort(),['jobs-dead','jobs-stalled']);
  assert.deepEqual(evaluateAlerts({...healthy,diagnostics:{unavailableCount:1}},rules).map(a=>a.id),['diagnostics-unavailable']);
});

test('settings require an https target and a long token; webhook must be https',()=>{
  assert.throws(()=>alertSettings({ASK_BILL_ALERT_TARGET:'http://example.com',ASK_BILL_METRICS_TOKEN:token}),/ALERT_TARGET_INVALID/);
  assert.throws(()=>alertSettings({ASK_BILL_ALERT_TARGET:'https://example.com'}),/ALERT_TOKEN_REQUIRED/);
  assert.throws(()=>alertSettings({ASK_BILL_ALERT_TARGET:'https://example.com',ASK_BILL_METRICS_TOKEN:token,ASK_BILL_ALERT_WEBHOOK_URL:'http://hook'}),/ALERT_WEBHOOK_INVALID/);
  assert.equal(alertSettings({ASK_BILL_ALERT_TARGET:'https://example.com',ASK_BILL_METRICS_TOKEN:token}).webhook,null);
});

function fake({ready=200,metrics=healthy,hook=true,throws=false}={}){
  const posts=[];
  const fetchImpl=async(url,init={})=>{
    if(throws)throw Error('down');
    if(url.endsWith('/health/ready'))return {status:ready};
    if(url.endsWith('/health/metrics')){assert.equal(init.headers.authorization,'Bearer '+token);return {status:200,json:async()=>metrics};}
    posts.push(JSON.parse(init.body));return {ok:hook};
  };
  return {posts,fetchImpl};
}
const settings={origin:'https://example.com',token,webhook:new URL('https://hooks.example/x')};

test('healthy service delivers nothing',async()=>{
  const f=fake();const r=await checkAlerts(settings,rules,{fetchImpl:f.fetchImpl});
  assert.equal(r.deliverable,0);assert.equal(f.posts.length,0);
});

test('firing alerts are delivered as aggregate-only text',async()=>{
  const bad=structuredClone(healthy);bad.diagnostics.jobs.dead=1;
  const f=fake({ready:503,metrics:bad});const r=await checkAlerts(settings,rules,{fetchImpl:f.fetchImpl});
  assert.equal(r.delivered,true);assert.equal(f.posts.length,1);
  assert.match(f.posts[0].text,/service-not-ready/);assert.match(f.posts[0].text,/jobs-dead/);
  assert(!f.posts[0].text.includes(token));
});

test('unreachable service is a page alert and undelivered without a webhook',async()=>{
  const r=await checkAlerts({...settings,webhook:null},rules,{fetchImpl:fake({throws:true}).fetchImpl});
  assert.deepEqual(r.firing.map(a=>a.id),['service-unreachable']);assert.equal(r.delivered,false);assert.equal(r.deliverable,1);
});
