/** Zero-account publishing on a disposable loopback database: passkey invites/enrolment and
 * PostgreSQL private storage, exercised through the restricted runtime role created by bootstrap. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApplicationPool} from '../../packages/db/pool.mjs';
import {migrate} from '../../scripts/migrate.mjs';
import {bootstrapSettings,bootstrapPublisher} from '../../scripts/bootstrap-publisher.mjs';
import {createOwnerInvite,inviteSettings} from '../../scripts/create-owner-invite.mjs';
import {newInvite} from '../../scripts/new-publisher-invite.mjs';
import {createPostgresPasskeyStore} from '../../packages/auth/passkey-store.mjs';
import {createPasskeyPublisherAuth} from '../../packages/auth/passkey.mjs';
import {createPostgresPrivateStorage} from '../../packages/storage/postgres.mjs';
import {createSoftAuthenticator} from '../helpers/soft-authenticator.mjs';

const raw=process.env.ASK_BILL_TEST_DATABASE_URL;
if(!raw)throw Error('EXPLICIT_TEST_DATABASE_REQUIRED');
const url=new URL(raw);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!/^\/askbill_/.test(url.pathname))throw Error('DISPOSABLE_LOOPBACK_DATABASE_REQUIRED');
const owner=await createApplicationPool({connectionString:raw,hosted:false,verifyRole:false,max:2});
const publisherId=randomUUID(),userId=randomUUID(),role='ask_bill_passkey_'+process.pid,password='p'.repeat(40);
const ORIGIN='https://askbill.example',RP='askbill.example';
let runtime;
const jar=set=>set.map(c=>c.split(';')[0]).filter(c=>!c.endsWith('=')).join('; ');
try{
  await migrate({pool:owner});
  await bootstrapPublisher({pool:owner,settings:bootstrapSettings({ASK_BILL_PUBLISHER_ID:publisherId,ASK_BILL_OWNER_USER_ID:userId,
    ASK_BILL_PUBLISHER_SLUG:'passkey-'+process.pid,ASK_BILL_PUBLISHER_NAME:'Passkey fixture',ASK_BILL_OWNER_IDENTITY:'deferred',
    ASK_BILL_RUNTIME_DB_ROLE:role,ASK_BILL_RUNTIME_DB_PASSWORD:password})});
  const appUrl=new URL(raw);appUrl.username=role;appUrl.password=password;
  // verifyRole defaults to true: the runtime role must still pass the non-owner/no-enrolment safety check.
  runtime=await createApplicationPool({connectionString:appUrl.href,hosted:false,max:3});
  const invite=newInvite();

  await test('owner CLI stores only the invite digest; reruns are idempotent',async()=>{
    const settings=inviteSettings({ASK_BILL_PUBLISHER_ID:publisherId,ASK_BILL_OWNER_INVITE_DIGEST:invite.digest});
    assert.equal((await createOwnerInvite({pool:owner,settings})).status,'created');
    assert.equal((await createOwnerInvite({pool:owner,settings})).status,'pending');
    const client=await owner.connect();
    try{
      await client.query("SELECT set_config('ask_bill.publisher_id',$1,false)",[publisherId]);
      const rows=(await client.query('SELECT * FROM ask_bill.publisher_enrollment_invites WHERE publisher_id=$1',[publisherId])).rows;
      assert.equal(rows.length,1);assert.equal(rows[0].invite_sha256,invite.digest);assert(!JSON.stringify(rows).includes(invite.code));
    }finally{client.release();}
  });

  await test('runtime role cannot create invites, identities or passkeys directly',async()=>{
    const client=await runtime.connect();
    try{
      await client.query("SELECT set_config('ask_bill.publisher_id',$1,false)",[publisherId]);
      for(const sql of [
        `INSERT INTO ask_bill.publisher_enrollment_invites(publisher_id,invite_sha256,user_id,expires_at) VALUES('${publisherId}','${'a'.repeat(64)}','${userId}',now()+interval '1 hour')`,
        `INSERT INTO ask_bill.publisher_auth_identities(publisher_id,identity_sha256,user_id) VALUES('${publisherId}','${'b'.repeat(64)}','${userId}')`,
        `UPDATE ask_bill.publisher_enrollment_invites SET redeemed_at=NULL`,
        `INSERT INTO ask_bill.publisher_passkeys(publisher_id,credential_id,identity_sha256,user_id,public_key_spki,algorithm) VALUES('${publisherId}','${'c'.repeat(22)}','${'d'.repeat(64)}','${userId}','\\x00','-7')`
      ])await assert.rejects(client.query(sql),e=>e.code==='42501',sql.slice(0,40));
    }finally{client.release();}
  });

  await test('passkey enrolment through the runtime role redeems the invite exactly once, then signs in',async()=>{
    const store=createPostgresPasskeyStore({pool:runtime,publisherId});
    const auth=createPasskeyPublisherAuth({expectedOrigin:ORIGIN,rpId:RP,publisherId,store});
    const a=createSoftAuthenticator({rpId:RP,origin:ORIGIN});
    const reg=await auth.registrationOptions({requestOrigin:ORIGIN,invite:invite.code});
    const done=await auth.finishRegistration({requestOrigin:ORIGIN,cookieHeader:jar(reg.setCookies),credential:a.create({challenge:reg.options.challenge})});
    const context=await auth.getContext({cookieHeader:jar(done.setCookies)});
    assert.equal(context.role,'owner');assert.equal(context.userId,userId);assert.equal(context.recentMfa,true);
    await assert.rejects(auth.registrationOptions({requestOrigin:ORIGIN,invite:invite.code}),e=>e.code==='INVITE_INVALID');
    const login=await auth.loginOptions({requestOrigin:ORIGIN});
    const assertion=a.get({challenge:login.options.challenge});
    const signedIn=await auth.finishPasskeyLogin({requestOrigin:ORIGIN,cookieHeader:jar(login.setCookies),credential:assertion});
    assert.equal((await auth.getContext({cookieHeader:jar(signedIn.setCookies)})).role,'owner');
    // A counter that does not advance (cloned authenticator) is refused.
    const again=await auth.loginOptions({requestOrigin:ORIGIN});
    await assert.rejects(auth.finishPasskeyLogin({requestOrigin:ORIGIN,cookieHeader:jar(again.setCookies),
      credential:a.get({challenge:again.options.challenge,keepCounter:true})}),e=>e.code==='PASSKEY_VERIFICATION_FAILED');
  });

  await test('PostgreSQL private storage verifies digests, enforces quota and keeps sources immutable',async()=>{
    const storage=createPostgresPrivateStorage({pool:runtime,publisherId,maxObjectBytes:4096,maxTotalBytes:8000});
    const content=Buffer.from('Section 1. Short title\n\nThis Act may be cited as the Fixture Act.\n'),sha256=(await import('node:crypto')).createHash('sha256').update(content).digest('hex');
    await storage.putQuarantine({publisherId,sha256,mime:'text/plain',content});
    const promoted=await storage.promoteQuarantine({publisherId,sha256,mime:'text/plain'});
    assert.equal(promoted.objectStoredAndVerified,true);assert.equal(promoted.scope,'private-source');
    const read=await storage.getPrivateSource({publisherId,sha256,size:content.length});assert(read.content.equals(content));
    await assert.rejects(storage.getQuarantine({publisherId,sha256}),e=>e.code==='OBJECT_NOT_FOUND');
    await assert.rejects(storage.putQuarantine({publisherId,sha256:'0'.repeat(64),mime:'text/plain',content}),e=>e.code==='OBJECT_INTEGRITY_FAILED');
    const big=Buffer.alloc(4000,'a'),bigSha=(await import('node:crypto')).createHash('sha256').update(big).digest('hex');
    await storage.putPrivateSource({publisherId,sha256:bigSha,mime:'text/plain',content:big});
    const more=Buffer.alloc(4000,'b'),moreSha=(await import('node:crypto')).createHash('sha256').update(more).digest('hex');
    await assert.rejects(storage.putPrivateSource({publisherId,sha256:moreSha,mime:'text/plain',content:more}),e=>e.code==='STORAGE_QUOTA_EXCEEDED');
    const client=await runtime.connect();
    try{
      await client.query("SELECT set_config('ask_bill.publisher_id',$1,false)",[publisherId]);
      await assert.rejects(client.query("DELETE FROM ask_bill.private_objects WHERE scope='private-source'"),e=>e.code==='23514');
      await assert.rejects(client.query("UPDATE ask_bill.private_objects SET mime='x/y'"),e=>e.code==='42501');
      await client.query("SELECT set_config('ask_bill.publisher_id',$1,false)",[randomUUID()]);
      assert.equal((await client.query('SELECT count(*)::int AS n FROM ask_bill.private_objects')).rows[0].n,0,'other publishers see nothing');
    }finally{client.release();}
    assert.deepEqual(await storage.usage(),{objects:2,bytes:content.length+4000,maxTotalBytes:8000});
  });
}finally{await runtime?.end();await owner.end();}
