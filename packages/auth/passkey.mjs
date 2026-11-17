/** Built-in publisher sign-in with passkeys (WebAuthn), an alternative to OIDC.
 *
 * Same interface and session model as oidc.mjs: hashed session/CSRF tokens in PostgreSQL, fresh
 * membership on every request, MFA-gated publish/withdraw. A passkey assertion requires user
 * verification (biometric or device PIN on a possession factor), so each sign-in records
 * mfaVerifiedAt and step-up is simply another assertion.
 * Enrolment requires an owner-created one-time invite; the server only ever sees its digest until
 * the owner types the invite code once into /admin/enroll.
 */
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {AuthError,publisherActionAllowed,secureSessionCookie,clearSessionCookie} from './server.mjs';
import {verifyRegistration,verifyAssertion,WebAuthnError,ALGORITHMS,b64urlDecode} from './webauthn.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const ROLES=new Set(['owner','editor','viewer']);
const CEREMONY_COOKIE='__Host-ask_bill_passkey';
const CSRF_COOKIE='__Host-ask_bill_csrf';
const SESSION_COOKIE='__Host-ask_bill_session';
const CEREMONY_TTL=300000,SESSION_TTL=1800000,MFA_TTL=600000;
const fail=code=>{throw new AuthError(code);};
const hash=value=>createHash('sha256').update(value).digest('hex');
const random=()=>randomBytes(32).toString('base64url');
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export const passkeyIdentityHash=credentialId=>hash(JSON.stringify(['webauthn',credentialId]));
export const inviteHash=code=>{if(!TOKEN.test(code??''))fail('INVITE_INVALID');return hash(code);};

function readCookie(header,name){
  if(typeof header!=='string'||header.length>8192||/[\r\n\0]/.test(header))fail('SESSION_INVALID');
  const entries=header.split(';').map(s=>s.trim()).filter(s=>s.startsWith(name+'='));
  if(entries.length!==1)fail('SESSION_INVALID');
  const value=entries[0].slice(name.length+1);if(!TOKEN.test(value))fail('SESSION_INVALID');return value;
}
const cookie=(name,value,maxAge)=>`${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
function returnPath(value){
  if(typeof value!=='string'||value.length>1000||!/^\/admin(?:\/[A-Za-z0-9_-]+)*\/?$/.test(value))fail('RETURN_PATH_INVALID');
  return value;
}
function origin(value,{allowLoopbackHttp}){
  let url;try{url=new URL(value);}catch{fail('PASSKEY_CONFIGURATION_INVALID');}
  const loopback=allowLoopbackHttp&&url.protocol==='http:'&&url.hostname==='localhost';
  if((url.protocol!=='https:'&&!loopback)||url.href!==url.origin+'/')fail('PASSKEY_CONFIGURATION_INVALID');
  return url;
}
const wrap=async fn=>{try{return await fn();}catch(error){if(error instanceof WebAuthnError)fail('PASSKEY_VERIFICATION_FAILED');throw error;}};

export function createPasskeyPublisherAuth({expectedOrigin,rpId,rpName='Ask Bill publisher',publisherId,store,now=()=>Date.now(),
  allowLoopbackHttpForTests=false}={}){
  if(allowLoopbackHttpForTests&&process.env.NODE_ENV!=='test')fail('PASSKEY_CONFIGURATION_INVALID');
  const url=origin(expectedOrigin,{allowLoopbackHttp:allowLoopbackHttpForTests}),expected=url.origin;
  if(rpId!==url.hostname||typeof rpName!=='string'||!rpName||rpName.length>64||!UUID.test(publisherId??'')||typeof now!=='function')fail('PASSKEY_CONFIGURATION_INVALID');
  for(const method of ['saveChallenge','consumeChallenge','inviteAvailable','redeemInvite','getPasskey','recordPasskeyUse',
    'saveSession','getSession','deleteSession','resolveMembership'])if(typeof store?.[method]!=='function')fail('DURABLE_AUTH_STORE_REQUIRED');
  const publisher=publisherId.toLowerCase();
  const clock=()=>{const v=now();if(!Number.isSafeInteger(v)||v<0)fail('INVALID_CLOCK');return v;};
  const checkOrigin=requestOrigin=>{if(requestOrigin!==expected)fail('ORIGIN_FORBIDDEN');};
  async function previousSession(cookieHeader){
    if(!cookieHeader)return null;
    try{return hash(readCookie(cookieHeader,SESSION_COOKIE));}catch(error){if(error instanceof AuthError)return null;throw error;}
  }
  async function ceremony({requestOrigin,cookieHeader,purpose,invite=null,returnTo='/admin',requireMfa=false}){
    checkOrigin(requestOrigin);
    const challenge=random(),binding=random(),at=clock();
    await store.saveChallenge({publisherId:publisher,challengeHash:hash(challenge),bindingHash:hash(binding),purpose,challenge,
      inviteHash:invite,returnTo:returnPath(returnTo),requireMfa,previousSessionHash:await previousSession(cookieHeader),createdAt:at,expiresAt:at+CEREMONY_TTL});
    return {challenge,setCookies:[cookie(CEREMONY_COOKIE,binding,300)]};
  }
  async function consume({requestOrigin,cookieHeader,purpose}){
    checkOrigin(requestOrigin);
    const binding=readCookie(cookieHeader,CEREMONY_COOKIE),at=clock();
    const row=await store.consumeChallenge({publisherId:publisher,bindingHash:hash(binding),purpose,now:at});
    if(!row||row.purpose!==purpose||row.expiresAt<=at||row.createdAt>at||row.expiresAt-row.createdAt>CEREMONY_TTL||!TOKEN.test(row.challenge??''))fail('PASSKEY_CHALLENGE_INVALID');
    return row;
  }
  async function startSession({userId,identityHash,previousSessionHash,cookieHeader}){
    if(previousSessionHash)await store.deleteSession({sessionHash:previousSessionHash,publisherId:publisher});
    else{const old=await previousSession(cookieHeader);if(old)await store.deleteSession({sessionHash:old,publisherId:publisher});}
    const sid=random(),csrf=random(),issuedAt=clock();
    await store.saveSession({sessionHash:hash(sid),publisherId:publisher,userId:userId.toLowerCase(),identityHash,csrfHash:hash(csrf),
      issuedAt,expiresAt:issuedAt+SESSION_TTL,mfaVerifiedAt:issuedAt});
    return [secureSessionCookie(sid),cookie(CSRF_COOKIE,csrf,1800),cookie(CEREMONY_COOKIE,'',0)];
  }
  async function currentSession(cookieHeader){
    const sid=readCookie(cookieHeader,SESSION_COOKIE),sessionHash=hash(sid),at=clock();
    const session=await store.getSession({sessionHash,publisherId:publisher});
    if(!session||session.publisherId!==publisher||!UUID.test(session.userId??'')||!Number.isSafeInteger(session.issuedAt)||session.issuedAt>at||
      !Number.isSafeInteger(session.expiresAt)||at>=session.expiresAt||session.expiresAt-session.issuedAt>SESSION_TTL)fail('SESSION_EXPIRED');
    const role=await store.resolveMembership({userId:session.userId,publisherId:publisher});
    if(!ROLES.has(role))fail('MEMBERSHIP_REVOKED');
    const recentMfa=Number.isSafeInteger(session.mfaVerifiedAt)&&at>=session.mfaVerifiedAt&&at-session.mfaVerifiedAt<=MFA_TTL;
    return {session,role,recentMfa};
  }
  return Object.freeze({
    kind:'passkey',publisherId:publisher,
    /** The sign-in form (and MFA step-up) lead to the passkey ceremony page. */
    async beginLogin({requestOrigin,returnTo='/admin',requireMfa=false}={}){
      checkOrigin(requestOrigin);if(typeof requireMfa!=='boolean')fail('PASSKEY_REQUEST_INVALID');
      const target=new URL('/admin/auth/passkey',expected);target.searchParams.set('returnTo',returnPath(returnTo));
      return {location:target.pathname+target.search,setCookies:[]};
    },
    async finishLogin(){fail('PASSKEY_CALLBACK_UNSUPPORTED');},
    async loginOptions({requestOrigin,cookieHeader,returnTo='/admin'}={}){
      const {challenge,setCookies}=await ceremony({requestOrigin,cookieHeader,purpose:'login',returnTo});
      // Discoverable credentials: no account list is revealed before verification.
      return {options:{challenge,rpId:url.hostname,timeout:120000,userVerification:'required',allowCredentials:[]},setCookies};
    },
    async finishPasskeyLogin({requestOrigin,cookieHeader,credential}={}){
      const row=await consume({requestOrigin,cookieHeader,purpose:'login'});
      if(!credential||typeof credential.id!=='string')fail('PASSKEY_VERIFICATION_FAILED');
      b64urlDecode(credential.id,{max:1366,code:'PASSKEY_VERIFICATION_FAILED'});
      const stored=await store.getPasskey({publisherId:publisher,credentialId:credential.id});
      if(!stored||!UUID.test(stored.userId??'')||!ROLES.has(stored.role))fail('PUBLISHER_NOT_ENROLLED');
      const result=await wrap(()=>verifyAssertion({response:credential.response,challenge:row.challenge,origin:expected,rpId:url.hostname,credential:stored}));
      // Conditional update: a concurrent replay with the same counter loses.
      if(!await store.recordPasskeyUse({publisherId:publisher,credentialId:credential.id,signCount:result.signCount,previousSignCount:stored.signCount??0}))fail('PASSKEY_VERIFICATION_FAILED');
      const setCookies=await startSession({userId:stored.userId,identityHash:stored.identityHash,previousSessionHash:row.previousSessionHash,cookieHeader});
      return {location:returnPath(row.returnTo),setCookies};
    },
    async registrationOptions({requestOrigin,cookieHeader,invite}={}){
      const invited=inviteHash(invite);
      if(!await store.inviteAvailable({publisherId:publisher,inviteHash:invited,now:clock()}))fail('INVITE_INVALID');
      const {challenge,setCookies}=await ceremony({requestOrigin,cookieHeader,purpose:'register',invite:invited});
      return {options:{challenge,rp:{id:url.hostname,name:rpName},
        user:{id:randomBytes(16).toString('base64url'),name:'publisher-owner',displayName:rpName},
        pubKeyCredParams:ALGORITHMS.map(alg=>({type:'public-key',alg})),timeout:180000,attestation:'none',
        authenticatorSelection:{residentKey:'required',requireResidentKey:true,userVerification:'required'}},setCookies};
    },
    async finishRegistration({requestOrigin,cookieHeader,credential}={}){
      const row=await consume({requestOrigin,cookieHeader,purpose:'register'});
      if(!/^[a-f0-9]{64}$/.test(row.inviteHash??''))fail('PASSKEY_CHALLENGE_INVALID');
      const created=await wrap(()=>verifyRegistration({response:{...credential?.response,id:credential?.id},challenge:row.challenge,origin:expected,rpId:url.hostname}));
      const identityHash=passkeyIdentityHash(created.credentialId);
      const member=await store.redeemInvite({publisherId:publisher,inviteHash:row.inviteHash,identityHash,credentialId:created.credentialId,
        publicKeySpki:created.publicKeySpki,algorithm:created.algorithm,signCount:created.signCount,transports:created.transports});
      if(!member||!UUID.test(member.userId??'')||!ROLES.has(member.role))fail('INVITE_INVALID');
      const setCookies=await startSession({userId:member.userId,identityHash,previousSessionHash:row.previousSessionHash,cookieHeader});
      return {location:'/admin',setCookies};
    },
    async getContext({cookieHeader}={}){
      const {session,role,recentMfa}=await currentSession(cookieHeader),csrfToken=readCookie(cookieHeader,CSRF_COOKIE);
      if(!same(hash(csrfToken),session.csrfHash))fail('CSRF_FORBIDDEN');
      return Object.freeze({userId:session.userId,publisherId:publisher,role,recentMfa,csrfToken,expiresAt:session.expiresAt});
    },
    async authorize({cookieHeader,csrfToken,requestOrigin,method,action,publisherId:requested=publisher}={}){
      if(requested!==publisher)fail('PUBLISHER_FORBIDDEN');
      if(!['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(method))fail('METHOD_INVALID');
      const {session,role,recentMfa}=await currentSession(cookieHeader);
      if(!['GET','HEAD'].includes(method)){
        checkOrigin(requestOrigin);
        if(!TOKEN.test(csrfToken??'')||!same(hash(csrfToken),session.csrfHash))fail('CSRF_FORBIDDEN');
      }else if(action!=='view')fail('METHOD_NOT_ALLOWED');
      if(!publisherActionAllowed(role,action,recentMfa))fail(['publish','withdraw','invite','manage-members'].includes(action)&&role!=='viewer'&&!recentMfa?'MFA_REQUIRED':'ACTION_FORBIDDEN');
      return Object.freeze({publisherId:publisher,userId:session.userId,role,action,freshMembershipVerified:true,mfaVerifiedByTrustedServer:recentMfa});
    },
    async logout(request={}){
      await this.authorize({...request,method:'POST',action:'view'});
      await store.deleteSession({sessionHash:hash(readCookie(request.cookieHeader,SESSION_COOKIE)),publisherId:publisher});
      return {setCookies:[clearSessionCookie(),cookie(CSRF_COOKIE,'',0),cookie(CEREMONY_COOKIE,'',0)]};
    }
  });
}
