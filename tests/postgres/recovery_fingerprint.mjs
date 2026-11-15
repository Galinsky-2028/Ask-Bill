/** AB-104: restore fingerprint against a disposable loopback database with every migration applied. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApplicationPool} from '../../packages/db/pool.mjs';
import {migrate,migrationFiles} from '../../scripts/migrate.mjs';
import {fingerprint,compareFingerprints,DURABLE_TABLES} from '../../scripts/recovery/fingerprint.mjs';
const raw=process.env.ASK_BILL_TEST_DATABASE_URL;
if(!raw)throw Error('EXPLICIT_TEST_DATABASE_REQUIRED');
const url=new URL(raw);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!/^\/askbill_/.test(url.pathname))throw Error('DISPOSABLE_LOOPBACK_DATABASE_REQUIRED');
const pool=await createApplicationPool({connectionString:raw,hosted:false,verifyRole:false,max:2});
try{
  await test('fingerprint covers every migration and table and finds no table without forced RLS',async()=>{
    await migrate({pool});
    const publisherId=randomUUID(),first=await fingerprint(pool,{publisherId}),second=await fingerprint(pool,{publisherId});
    assert.equal(first.migrations.count,(await migrationFiles()).length);
    for(const table of DURABLE_TABLES)assert.equal(first.counts[table],0,table);
    assert.deepEqual(first.rls.unprotected,[]);
    assert(first.rls.tables>=DURABLE_TABLES.length);
    assert.deepEqual(compareFingerprints(first,second),[]);
    await assert.rejects(fingerprint(pool,{publisherId:'not-a-uuid'}),/FINGERPRINT_PUBLISHER_REQUIRED/);
  });
}finally{await pool.end();}
