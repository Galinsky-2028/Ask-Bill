import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readApplicationConfig} from '../packages/config/runtime.mjs';
import {createPublisherSourceExtractor} from '../packages/db/publisher-source-extraction.mjs';
import {createPublisherHandler} from '../apps/web/admin/server/index.mjs';
import {createPasskeyPublisherAuth} from '../packages/auth/passkey.mjs';
import {newInvite} from '../scripts/new-publisher-invite.mjs';
import {createSoftAuthenticator} from './helpers/soft-authenticator.mjs';
import {createMemoryPasskeyStore} from './helpers/memory-passkey-store.mjs';

const PUBLISHER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',OWNER='11111111-1111-4111-8111-111111111111',VERSION='22222222-2222-4222-8222-222222222222';
const hosted={ASK_BILL_STAGE:'staging',ASK_BILL_PUBLIC_ORIGIN:'https://askbill.example',ASK_BILL_PUBLISHER_ID:PUBLISHER,
  ASK_BILL_DATABASE_URL:'postgresql://runtime:pw@db.example/askbill',ASK_BILL_SESSION_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')};

test('publishing can be configured with passkeys and PostgreSQL storage and no external accounts',()=>{
  const config=readApplicationConfig({...hosted,ASK_BILL_ALLOW_PUBLISHING:'true',ASK_BILL_PUBLISHER_AUTH:'passkey',ASK_BILL_EMBEDDED_TEXT_WORKER:'true'});
  assert.equal(config.auth.kind,'passkey');assert.equal(config.auth.rpId,'askbill.example');
  assert.equal(config.storage.driver,'postgres');assert.equal(config.storage.maxObjectBytes,10485760);assert.equal(config.embeddedTextWorker,true);
  assert.throws(()=>readApplicationConfig({...hosted,ASK_BILL_EMBEDDED_TEXT_WORKER:'true'}),/EMBEDDED_WORKER_REQUIRES_PUBLISHING/);
  assert.throws(()=>readApplicationConfig({...hosted,ASK_BILL_ALLOW_PUBLISHING:'true',ASK_BILL_PUBLISHER_AUTH:'magic'}),/INVALID_ASK_BILL_PUBLISHER_AUTH/);
  assert.throws(()=>readApplicationConfig({...hosted,ASK_BILL_ALLOW_PUBLISHING:'true',ASK_BILL_PUBLISHER_AUTH:'passkey',ASK_BILL_STORAGE_DRIVER:'ftp'}),/INVALID_ASK_BILL_STORAGE_DRIVER/);
  // OIDC remains the default publisher sign-in.
  assert.throws(()=>readApplicationConfig({...hosted,ASK_BILL_ALLOW_PUBLISHING:'true'}),/MISSING_ASK_BILL_OIDC_ISSUER/);
});

test('text-only extractor parses text/Markdown in a permission-limited process and refuses binary formats',async()=>{
  const extract=createPublisherSourceExtractor({textOnlyProcessBoundary:true,timeoutMs:20000});
  const out=await extract({bytes:Buffer.from('Section 1. Short title\n\nThis Act may be cited as the Example Act.\n'),mime:'text/plain',versionId:VERSION});
  assert.match(out.canonicalText,/Example Act/);assert(out.provisions.length>=1);
  await assert.rejects(extract({bytes:Buffer.from('%PDF-1.7\n'),mime:'application/pdf',versionId:VERSION}),e=>e.code==='FORMAT_REQUIRES_SANDBOXED_WORKER');
});

async function serve(handler){
  const server=createServer((req,res)=>handler(req,res).then(h=>{if(!h){res.statusCode=404;res.end();}}).catch(()=>{res.statusCode=500;res.end();}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));return {server,base:'http://127.0.0.1:'+server.address().port};
}
const jar=set=>(set??[]).map(c=>c.split(';')[0]).filter(c=>!c.endsWith('=')).join('; ');

test('admin passkey endpoints enrol and sign in over HTTP with origin checks and a strict CSP',async()=>{
  const origin='https://askbill.example',invite=newInvite();
  const store=createMemoryPasskeyStore({publisherId:PUBLISHER,ownerUserId:OWNER,invites:[invite.digest]});
  const auth=createPasskeyPublisherAuth({expectedOrigin:origin,rpId:'askbill.example',publisherId:PUBLISHER,store});
  const handler=createPublisherHandler({auth,repository:{async listBills(){return [];}},storage:{},expectedOrigin:origin,publisherId:PUBLISHER,
    acceptedUploadMimes:['text/plain','text/markdown']});
  const {server,base}=await serve(handler),a=createSoftAuthenticator({rpId:'askbill.example',origin});
  const post=(path,body,cookie='',from=origin)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',origin:from,cookie},body:JSON.stringify(body)});
  try{
    const page=await fetch(base+'/admin/enroll');
    assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/script-src 'self'; connect-src 'self'/);
    assert.match(await page.text(),/src="\/admin\/assets\/passkey.mjs"/);
    assert.equal((await fetch(base+'/admin/assets/passkey.mjs')).status,200);
    assert.equal((await post('/admin/auth/passkey/register/options',{invite:invite.code},'', 'https://evil.example')).status,403);
    assert.equal((await post('/admin/auth/passkey/register/options',{invite:newInvite().code})).status,400);
    const opts=await post('/admin/auth/passkey/register/options',{invite:invite.code});assert.equal(opts.status,200);
    const {options}=await opts.json(),ceremony=jar(opts.headers.getSetCookie());
    const done=await post('/admin/auth/passkey/register/verify',{credential:a.create({challenge:options.challenge})},ceremony);
    assert.equal(done.status,200);assert.deepEqual(await done.json(),{location:'/admin'});
    const session=jar(done.headers.getSetCookie());
    const library=await fetch(base+'/admin',{headers:{cookie:session}});
    assert.equal(library.status,200);assert.match(await library.text(),/Multi-factor verification is current/);
    const signIn=await fetch(base+'/admin/auth/passkey?returnTo=/admin');assert.equal(signIn.status,200);
    const login=await post('/admin/auth/passkey/options',{returnTo:'/admin'});const lo=(await login.json()).options;
    const verified=await post('/admin/auth/passkey/verify',{credential:a.get({challenge:lo.challenge})},jar(login.headers.getSetCookie()));
    assert.equal(verified.status,200);
    const bad=await post('/admin/auth/passkey/verify',{credential:a.get({challenge:lo.challenge})},jar(login.headers.getSetCookie()));
    assert.equal(bad.status,400);assert.deepEqual(await bad.json(),{error:'PASSKEY_CHALLENGE_INVALID'});
  }finally{server.close();}
});
