import test from 'node:test';
import assert from 'node:assert/strict';
import {compareFingerprints,setDigest,DURABLE_TABLES} from '../scripts/recovery/fingerprint.mjs';
import {drillSettings,runRestoreDrill} from '../scripts/recovery/neon-restore-drill.mjs';

const base=()=>({publisherId:'9eca01ac-5317-4442-894e-6f63ea23fdc1',migrations:{count:13,sha256:'a'},
  counts:Object.fromEntries(DURABLE_TABLES.map(t=>[t,1])),
  digests:{sourceVersions:{count:1,sha256:'s'},sourceObjects:{count:1,sha256:'o'},releasePacks:{count:0,sha256:'r'},activeReleases:{count:0,sha256:'x'},auditEvents:{count:3,sha256:'e'}},
  rls:{tables:30,unprotected:[]}});

test('set digest is order independent and content sensitive',()=>{
  assert.equal(setDigest(['b','a']),setDigest(['a','b']));
  assert.notEqual(setDigest(['a']),setDigest(['a','b']));
});

test('restore comparison flags lost rows, changed hashes and missing RLS, ignores ephemeral sessions',()=>{
  const before=base();
  assert.deepEqual(compareFingerprints(before,structuredClone(before)),[]);
  const after=structuredClone(before);after.counts.bill_versions=0;after.digests.sourceVersions.sha256='changed';
  after.rls.unprotected=['bills'];after.counts.anonymous_sessions=999;
  const diffs=compareFingerprints(before,after);
  assert.equal(diffs.length,3);
  assert(diffs.some(d=>d.startsWith('bill_versions rows 1 -> 0')));
  assert(diffs.some(d=>d.startsWith('sourceVersions digest differs')));
  assert(diffs.some(d=>d.includes('row-level security missing on bills')));
});

test('drill settings require an explicit project, key and a past timestamp',()=>{
  const now=Date.parse('2026-11-15T12:00:00Z'),clock=()=>now;
  assert.throws(()=>drillSettings([],{NEON_API_KEY:'k'},clock),/DRILL_PROJECT_REQUIRED/);
  assert.throws(()=>drillSettings(['--project','winter-waterfall-73466147'],{},clock),/DRILL_API_KEY_REQUIRED/);
  assert.throws(()=>drillSettings(['--project','winter-waterfall-73466147','--at','2027-01-01T00:00:00Z'],{NEON_API_KEY:'k'},clock),/DRILL_TIMESTAMP_INVALID/);
  const s=drillSettings(['--project','winter-waterfall-73466147'],{NEON_API_KEY:'k'},clock);
  assert.equal(s.at,'2026-11-15T11:55:00.000Z');assert.equal(s.keep,false);
});

function fakeNeon({failOp=false,defaultBranch=false}={}){
  const calls=[];let polls=0;
  const fetchImpl=async(url,init)=>{
    calls.push(init.method+' '+url.replace('https://console.neon.tech/api/v2',''));
    let body;
    if(init.method==='POST')body={branch:{id:'br-drill',default:defaultBranch},endpoints:[{host:'ep-drill.example'}],operations:[{id:'op1'}]};
    else if(init.method==='DELETE')body={operations:[{id:'op2'}]};
    else body={operation:{status:failOp?'failed':(++polls>1?'finished':'running')}};
    return {ok:true,status:200,json:async()=>body};
  };
  return {calls,fetchImpl};
}

test('drill creates an isolated branch, waits for readiness, then deletes it',async()=>{
  const neon=fakeNeon();let t=0;
  const result=await runRestoreDrill({project:'winter-waterfall-73466147',at:'2026-11-15T11:55:00Z',keep:false,apiKey:'k'},
    {fetchImpl:neon.fetchImpl,clock:()=>(t+=1000),wait:async()=>{}});
  assert.equal(result.deleted,true);assert.equal(result.branch.id,'br-drill');assert(result.restoreReadyMs>0);
  assert.equal(neon.calls[0],'POST /projects/winter-waterfall-73466147/branches');
  assert(neon.calls.includes('DELETE /projects/winter-waterfall-73466147/branches/br-drill'));
  assert(!JSON.stringify(result).includes('password'));
});

test('drill cleans up after a failed restore and refuses a default branch',async()=>{
  const failed=fakeNeon({failOp:true});
  await assert.rejects(runRestoreDrill({project:'winter-waterfall-73466147',at:'2026-11-15T11:55:00Z',keep:false,apiKey:'k'},
    {fetchImpl:failed.fetchImpl,wait:async()=>{}}),/DRILL_OPERATION_FAILED/);
  assert(failed.calls.some(c=>c.startsWith('DELETE')));
  const def=fakeNeon({defaultBranch:true});
  await assert.rejects(runRestoreDrill({project:'winter-waterfall-73466147',at:'2026-11-15T11:55:00Z',keep:false,apiKey:'k'},
    {fetchImpl:def.fetchImpl,wait:async()=>{}}),/DRILL_REFUSES_DEFAULT_BRANCH/);
});
