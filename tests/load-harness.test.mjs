import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSettings,runLoad} from '../tools/perf/load.mjs';
import {buildApplicationRuntime} from '../apps/web/application/start.mjs';

test('harness refuses remote targets without an explicit flag and non-reading paths',()=>{
  assert.throws(()=>loadSettings({target:'https://ask-bill.onrender.com'}),/LOAD_REMOTE_REQUIRES_EXPLICIT_FLAG/);
  assert.equal(loadSettings({target:'https://ask-bill.onrender.com',allowRemote:true}).origin,'https://ask-bill.onrender.com');
  for(const path of ['/api/sessions','/admin','/bills?q=x','bills','/health/metrics'])
    assert.throws(()=>loadSettings({target:'http://127.0.0.1:1',paths:[path]}),/LOAD_PATHS_PUBLIC_READING_ONLY/);
  assert.throws(()=>loadSettings({target:'http://127.0.0.1:1',requests:20001}),/LOAD_LIMIT_INVALID/);
  assert.throws(()=>loadSettings({target:'http://user:pw@127.0.0.1:1'}),/LOAD_TARGET_INVALID/);
});

test('budget verdict reflects measured latency and server errors',async()=>{
  let t=0,calls=0;
  const fetchImpl=async()=>{calls++;t+=calls%10===0?900:10;return {status:calls%10===0?503:200,arrayBuffer:async()=>new ArrayBuffer(0)};};
  const result=await runLoad({target:'http://127.0.0.1:1',requests:100,concurrency:1,p95Ms:500,maxErrorRatio:0.05},{fetchImpl,now:()=>t});
  assert.equal(result.statuses['200'],90);assert.equal(result.statuses['503'],10);
  assert.equal(result.errorRatio,0.1);assert.equal(result.passed,false);
});

test('reader demo serves a short burst within a generous local budget',async()=>{
  const runtime=await buildApplicationRuntime({demo:true,env:{ASK_BILL_STAGE:'development'}});
  await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));
  try{
    const result=await runLoad({target:'http://127.0.0.1:'+runtime.server.address().port,paths:['/bills','/learn','/about'],
      requests:120,concurrency:12,p95Ms:5000});
    assert.equal(result.requests,120);assert.equal(result.errorRatio,0);assert.equal(result.passed,true);
    assert.equal(Object.values(result.statuses).reduce((a,b)=>a+b,0),120);
  }finally{await runtime.close();}
});
