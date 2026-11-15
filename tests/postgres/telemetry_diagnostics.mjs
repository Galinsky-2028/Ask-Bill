/** AB-103: diagnostics query runs against the real migrated schema. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApplicationPool} from '../../packages/db/pool.mjs';
import {collectDiagnostics} from '../../packages/telemetry/diagnostics.mjs';
const raw=process.env.ASK_BILL_TEST_DATABASE_URL;
if(!raw)throw Error('EXPLICIT_TEST_DATABASE_REQUIRED');
const url=new URL(raw);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!/^\/askbill_/.test(url.pathname))throw Error('DISPOSABLE_LOOPBACK_DATABASE_REQUIRED');
const pool=await createApplicationPool({connectionString:raw,hosted:false,verifyRole:false,max:1});
try{
  await test('diagnostics return only numeric counts and ages',async()=>{
    const d=await collectDiagnostics(pool,randomUUID());
    for(const group of ['jobs','outbox','retention'])for(const [k,v] of Object.entries(d[group]))assert(Number.isFinite(v)&&v>=0,group+'.'+k);
  });
}finally{await pool.end();}
