import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifyRegistration,verifyAssertion,decodeCbor,WebAuthnError} from '../packages/auth/webauthn.mjs';
import {createPasskeyPublisherAuth,inviteHash} from '../packages/auth/passkey.mjs';
import {newInvite,inviteDigest} from '../scripts/new-publisher-invite.mjs';
import {createSoftAuthenticator,encodeCbor} from './helpers/soft-authenticator.mjs';
import {createMemoryPasskeyStore} from './helpers/memory-passkey-store.mjs';

const ORIGIN='https://askbill.example',RP='askbill.example';
const PUBLISHER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',OWNER='11111111-1111-4111-8111-111111111111';
const challenge='C'.repeat(43);
const code=err=>e=>e instanceof WebAuthnError&&e.code===err;

for(const algorithm of [-7,-8,-257]){
  test(`registration and assertion verify for COSE algorithm ${algorithm}`,()=>{
    const a=createSoftAuthenticator({rpId:RP,origin:ORIGIN,algorithm});
    const reg=verifyRegistration({response:{...a.create({challenge}).response,id:a.credentialId},challenge,origin:ORIGIN,rpId:RP});
    assert.equal(reg.credentialId,a.credentialId);assert.equal(reg.algorithm,algorithm);
    const credential={publicKeySpki:reg.publicKeySpki,algorithm,signCount:0};
    const r=verifyAssertion({response:a.get({challenge}).response,challenge,origin:ORIGIN,rpId:RP,credential});
    assert.equal(r.signCount,1);
  });
}

test('registration rejects wrong challenge, origin, rpId and missing user verification',()=>{
  const a=createSoftAuthenticator({rpId:RP,origin:ORIGIN});
  const verify=response=>verifyRegistration({response,challenge,origin:ORIGIN,rpId:RP});
  assert.throws(()=>verify(a.create({challenge:'D'.repeat(43)}).response),code('CHALLENGE_MISMATCH'));
  assert.throws(()=>verify(a.create({challenge,originOverride:'https://evil.example'}).response),code('ORIGIN_MISMATCH'));
  assert.throws(()=>verify(a.create({challenge,rpIdOverride:'evil.example'}).response),code('RP_ID_MISMATCH'));
  const noUv=createSoftAuthenticator({rpId:RP,origin:ORIGIN,userVerified:false});
  assert.throws(()=>verify(noUv.create({challenge}).response),code('USER_VERIFICATION_REQUIRED'));
  const getAsCreate={...a.get({challenge}).response,attestationObject:encodeCbor(new Map([['fmt','none']])).toString('base64url')};
  assert.throws(()=>verify(getAsCreate),code('CLIENT_DATA_TYPE_INVALID'));
});

test('assertion rejects tampered signatures, counter regression and another key',()=>{
  const a=createSoftAuthenticator({rpId:RP,origin:ORIGIN}),b=createSoftAuthenticator({rpId:RP,origin:ORIGIN});
  const reg=verifyRegistration({response:a.create({challenge}).response,challenge,origin:ORIGIN,rpId:RP});
  const credential={publicKeySpki:reg.publicKeySpki,algorithm:-7,signCount:5};
  const verify=response=>verifyAssertion({response,challenge,origin:ORIGIN,rpId:RP,credential});
  assert.throws(()=>verify(a.get({challenge,tamper:true}).response),code('SIGNATURE_INVALID'));
  assert.throws(()=>verify(a.get({challenge}).response),code('SIGN_COUNT_REGRESSION'));
  assert.throws(()=>verify(b.get({challenge}).response),code('SIGNATURE_INVALID'));
});

test('CBOR decoder rejects truncated, duplicate-key and over-deep input',()=>{
  assert.throws(()=>decodeCbor(Buffer.from([0x5a,0,0,0,9,1])),code('CBOR_TRUNCATED'));
  assert.throws(()=>decodeCbor(Buffer.from([0xa2,0x01,0x01,0x01,0x02])),code('CBOR_DUPLICATE_KEY'));
  let deep=Buffer.from([0x01]);for(let i=0;i<12;i++)deep=Buffer.concat([Buffer.from([0x81]),deep]);
  assert.throws(()=>decodeCbor(deep),code('CBOR_TOO_DEEP'));
});

test('invite generator yields a 256-bit code whose digest is all the server stores',()=>{
  const {code:invite,digest}=newInvite();
  assert.match(invite,/^[A-Za-z0-9_-]{43}$/);assert.equal(digest,createHash('sha256').update(invite).digest('hex'));
  assert.equal(inviteDigest(invite),inviteHash(invite));assert.throws(()=>inviteDigest('short'));
});

const cookieHeader=setCookies=>setCookies.map(c=>c.split(';')[0]).filter(c=>!c.endsWith('=')).join('; ');
function harness(){
  const invite=newInvite(),store=createMemoryPasskeyStore({publisherId:PUBLISHER,ownerUserId:OWNER,invites:[invite.digest]});
  const auth=createPasskeyPublisherAuth({expectedOrigin:ORIGIN,rpId:RP,publisherId:PUBLISHER,store});
  const a=createSoftAuthenticator({rpId:RP,origin:ORIGIN});
  return {invite,store,auth,a};
}

test('enrolment with a one-time invite creates an MFA-verified owner session; the invite cannot be reused',async()=>{
  const {invite,store,auth,a}=harness();
  const opts=await auth.registrationOptions({requestOrigin:ORIGIN,invite:invite.code});
  assert.equal(opts.options.authenticatorSelection.userVerification,'required');assert.equal(opts.options.rp.id,RP);
  const done=await auth.finishRegistration({requestOrigin:ORIGIN,cookieHeader:cookieHeader(opts.setCookies),credential:a.create({challenge:opts.options.challenge})});
  assert.equal(done.location,'/admin');
  const cookies=cookieHeader(done.setCookies),context=await auth.getContext({cookieHeader:cookies});
  assert.equal(context.role,'owner');assert.equal(context.recentMfa,true);
  const actor=await auth.authorize({cookieHeader:cookies,csrfToken:context.csrfToken,requestOrigin:ORIGIN,method:'POST',action:'publish'});
  assert.equal(actor.mfaVerifiedByTrustedServer,true);
  await assert.rejects(auth.registrationOptions({requestOrigin:ORIGIN,invite:invite.code}),e=>e.code==='INVITE_INVALID');
  await assert.rejects(auth.registrationOptions({requestOrigin:ORIGIN,invite:newInvite().code}),e=>e.code==='INVITE_INVALID');
  assert.equal(store.state.passkeys.size,1);
});

test('passkey sign-in verifies the assertion, rotates the session and refuses replays and foreign origins',async()=>{
  const {invite,auth,a}=harness();
  const reg=await auth.registrationOptions({requestOrigin:ORIGIN,invite:invite.code});
  const enrolled=await auth.finishRegistration({requestOrigin:ORIGIN,cookieHeader:cookieHeader(reg.setCookies),credential:a.create({challenge:reg.options.challenge})});
  const oldCookies=cookieHeader(enrolled.setCookies);
  const login=await auth.loginOptions({requestOrigin:ORIGIN,cookieHeader:oldCookies,returnTo:'/admin/bills'});
  assert.deepEqual(login.options.allowCredentials,[]);
  const ceremony=cookieHeader(login.setCookies)+'; '+oldCookies;
  const assertion=a.get({challenge:login.options.challenge});
  const signedIn=await auth.finishPasskeyLogin({requestOrigin:ORIGIN,cookieHeader:ceremony,credential:assertion});
  assert.equal(signedIn.location,'/admin/bills');
  await assert.rejects(auth.getContext({cookieHeader:oldCookies}),e=>e.code==='SESSION_EXPIRED');
  assert.equal((await auth.getContext({cookieHeader:cookieHeader(signedIn.setCookies)})).recentMfa,true);
  await assert.rejects(auth.finishPasskeyLogin({requestOrigin:ORIGIN,cookieHeader:ceremony,credential:assertion}),e=>e.code==='PASSKEY_CHALLENGE_INVALID');
  await assert.rejects(auth.loginOptions({requestOrigin:'https://evil.example'}),e=>e.code==='ORIGIN_FORBIDDEN');
  const next=await auth.loginOptions({requestOrigin:ORIGIN});
  await assert.rejects(auth.finishPasskeyLogin({requestOrigin:ORIGIN,cookieHeader:cookieHeader(next.setCookies),
    credential:a.get({challenge:next.options.challenge,originOverride:'https://evil.example'})}),e=>e.code==='PASSKEY_VERIFICATION_FAILED');
});

test('configuration refuses http origins and mismatched relying party ids outside tests',()=>{
  const store=createMemoryPasskeyStore({publisherId:PUBLISHER,ownerUserId:OWNER});
  assert.throws(()=>createPasskeyPublisherAuth({expectedOrigin:'http://askbill.example',rpId:RP,publisherId:PUBLISHER,store}),e=>e.code==='PASSKEY_CONFIGURATION_INVALID');
  assert.throws(()=>createPasskeyPublisherAuth({expectedOrigin:ORIGIN,rpId:'other.example',publisherId:PUBLISHER,store}),e=>e.code==='PASSKEY_CONFIGURATION_INVALID');
  assert.throws(()=>createPasskeyPublisherAuth({expectedOrigin:ORIGIN,rpId:RP,publisherId:PUBLISHER,store:{}}),e=>e.code==='DURABLE_AUTH_STORE_REQUIRED');
});
