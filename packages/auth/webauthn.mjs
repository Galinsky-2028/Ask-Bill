/** Server-side WebAuthn verification (passkeys) without third-party code.
 *
 * Registration uses attestation "none" (we bind credentials to an owner-issued invite, not to an
 * authenticator vendor). Both ceremonies require: exact challenge, exact origin, rpIdHash, user
 * presence AND user verification (UV) — a passkey with UV is possession + biometric/PIN, i.e. MFA.
 * Assertions also enforce the signature counter (clone detection) when authenticators use one.
 */
import {createHash,createPublicKey,verify as verifySignature} from 'node:crypto';

export class WebAuthnError extends Error{constructor(code){super(code);this.name='WebAuthnError';this.code=code;}}
const fail=code=>{throw new WebAuthnError(code);};
const sha256=data=>createHash('sha256').update(data).digest();
const B64URL=/^[A-Za-z0-9_-]+$/;
export const ALGORITHMS=Object.freeze([-7,-8,-257]); // ES256, EdDSA (Ed25519), RS256

export function b64urlDecode(value,{max=65536,code='WEBAUTHN_ENCODING_INVALID'}={}){
  if(typeof value!=='string'||!value||value.length>max||!B64URL.test(value))fail(code);
  const bytes=Buffer.from(value,'base64url');
  if(bytes.toString('base64url')!==value)fail(code);
  return bytes;
}

/** Minimal deterministic CBOR decoder for WebAuthn (major types 0–5, 7 for simple values). */
export function decodeCbor(buffer,{maxDepth=8}={}){
  let offset=0;
  const need=n=>{if(offset+n>buffer.length)fail('CBOR_TRUNCATED');};
  const length=info=>{
    if(info<24)return info;
    if(info===24){need(1);return buffer[offset++];}
    if(info===25){need(2);const v=buffer.readUInt16BE(offset);offset+=2;return v;}
    if(info===26){need(4);const v=buffer.readUInt32BE(offset);offset+=4;return v;}
    fail('CBOR_UNSUPPORTED');
  };
  const item=depth=>{
    if(depth>maxDepth)fail('CBOR_TOO_DEEP');
    need(1);const head=buffer[offset++],major=head>>5,info=head&31;
    if(major===7){if(info===20)return false;if(info===21)return true;if(info===22)return null;fail('CBOR_UNSUPPORTED');}
    const n=length(info);
    switch(major){
      case 0:return n;
      case 1:return -1-n;
      case 2:{need(n);const v=buffer.subarray(offset,offset+n);offset+=n;return Buffer.from(v);}
      case 3:{need(n);const v=buffer.subarray(offset,offset+n).toString('utf8');offset+=n;return v;}
      case 4:{if(n>64)fail('CBOR_TOO_LARGE');const out=[];for(let i=0;i<n;i++)out.push(item(depth+1));return out;}
      case 5:{if(n>64)fail('CBOR_TOO_LARGE');const out=new Map();for(let i=0;i<n;i++){const k=item(depth+1);if(out.has(k))fail('CBOR_DUPLICATE_KEY');out.set(k,item(depth+1));}return out;}
      default:fail('CBOR_UNSUPPORTED');
    }
  };
  const value=item(0);
  return {value,consumed:offset};
}

/** COSE_Key → Node KeyObject (and its SPKI DER) for the allowed algorithms only. */
export function coseToPublicKey(cose){
  if(!(cose instanceof Map))fail('COSE_KEY_INVALID');
  const kty=cose.get(1),alg=cose.get(3);
  let jwk;
  if(alg===-7&&kty===2&&cose.get(-1)===1){
    const x=cose.get(-2),y=cose.get(-3);if(!Buffer.isBuffer(x)||!Buffer.isBuffer(y)||x.length!==32||y.length!==32)fail('COSE_KEY_INVALID');
    jwk={kty:'EC',crv:'P-256',x:x.toString('base64url'),y:y.toString('base64url')};
  }else if(alg===-8&&kty===1&&cose.get(-1)===6){
    const x=cose.get(-2);if(!Buffer.isBuffer(x)||x.length!==32)fail('COSE_KEY_INVALID');
    jwk={kty:'OKP',crv:'Ed25519',x:x.toString('base64url')};
  }else if(alg===-257&&kty===3){
    const n=cose.get(-1),e=cose.get(-2);if(!Buffer.isBuffer(n)||!Buffer.isBuffer(e)||n.length<256||n.length>512||e.length>8)fail('COSE_KEY_INVALID');
    jwk={kty:'RSA',n:n.toString('base64url'),e:e.toString('base64url')};
  }else fail('COSE_ALGORITHM_UNSUPPORTED');
  let key;try{key=createPublicKey({key:jwk,format:'jwk'});}catch{fail('COSE_KEY_INVALID');}
  return {algorithm:alg,key,spki:key.export({type:'spki',format:'der'})};
}

export function parseAuthenticatorData(bytes,{expectCredential=false}={}){
  if(!Buffer.isBuffer(bytes)||bytes.length<37||bytes.length>4096)fail('AUTHENTICATOR_DATA_INVALID');
  const rpIdHash=bytes.subarray(0,32),flags=bytes[32],signCount=bytes.readUInt32BE(33);
  const result={rpIdHash,signCount,userPresent:!!(flags&0x01),userVerified:!!(flags&0x04),
    backupEligible:!!(flags&0x08),backedUp:!!(flags&0x10),attested:!!(flags&0x40),extensions:!!(flags&0x80)};
  if(expectCredential){
    if(!result.attested||bytes.length<55)fail('AUTHENTICATOR_DATA_INVALID');
    const idLength=bytes.readUInt16BE(53);
    if(idLength<16||idLength>1023||55+idLength>bytes.length)fail('CREDENTIAL_ID_INVALID');
    result.credentialId=Buffer.from(bytes.subarray(55,55+idLength));
    const {value,consumed}=decodeCbor(bytes.subarray(55+idLength));
    result.publicKey=coseToPublicKey(value);
    if(!result.extensions&&55+idLength+consumed!==bytes.length)fail('AUTHENTICATOR_DATA_INVALID');
  }else if(result.attested)fail('AUTHENTICATOR_DATA_INVALID');
  return result;
}

function clientData(json,{type,challenge,origin}){
  const raw=b64urlDecode(json,{max:8192,code:'CLIENT_DATA_INVALID'});
  let data;try{data=JSON.parse(raw.toString('utf8'));}catch{fail('CLIENT_DATA_INVALID');}
  if(!data||typeof data!=='object'||data.type!==type)fail('CLIENT_DATA_TYPE_INVALID');
  if(typeof data.challenge!=='string'||data.challenge!==challenge)fail('CHALLENGE_MISMATCH');
  if(data.origin!==origin)fail('ORIGIN_MISMATCH');
  if(data.crossOrigin===true)fail('CROSS_ORIGIN_FORBIDDEN');
  return raw;
}
function checkFlags(auth,rpId){
  if(!sha256(rpId).equals(auth.rpIdHash))fail('RP_ID_MISMATCH');
  if(!auth.userPresent)fail('USER_PRESENCE_REQUIRED');
  if(!auth.userVerified)fail('USER_VERIFICATION_REQUIRED');
}

/** Verify a registration (navigator.credentials.create) response. */
export function verifyRegistration({response,challenge,origin,rpId}){
  if(!response||typeof response!=='object')fail('REGISTRATION_INVALID');
  clientData(response.clientDataJSON,{type:'webauthn.create',challenge,origin});
  const {value:attestation,consumed}=decodeCbor(b64urlDecode(response.attestationObject,{max:16384,code:'ATTESTATION_INVALID'}));
  if(!(attestation instanceof Map)||typeof attestation.get('fmt')!=='string'||!Buffer.isBuffer(attestation.get('authData')))fail('ATTESTATION_INVALID');
  void consumed;
  // Attestation is not used for trust decisions: enrolment is authorised by the owner's invite.
  const auth=parseAuthenticatorData(attestation.get('authData'),{expectCredential:true});
  checkFlags(auth,rpId);
  const credentialId=auth.credentialId.toString('base64url');
  if(response.id!==undefined&&response.id!==credentialId)fail('CREDENTIAL_ID_MISMATCH');
  const transports=Array.isArray(response.transports)?response.transports.filter(t=>['usb','nfc','ble','internal','hybrid','smart-card'].includes(t)).slice(0,6):[];
  return {credentialId,publicKeySpki:auth.publicKey.spki,algorithm:auth.publicKey.algorithm,signCount:auth.signCount,transports,
    backupEligible:auth.backupEligible};
}

/** Verify an authentication (navigator.credentials.get) response against a stored credential. */
export function verifyAssertion({response,challenge,origin,rpId,credential}){
  if(!response||typeof response!=='object'||!credential)fail('ASSERTION_INVALID');
  const raw=clientData(response.clientDataJSON,{type:'webauthn.get',challenge,origin});
  const authBytes=b64urlDecode(response.authenticatorData,{max:4096,code:'AUTHENTICATOR_DATA_INVALID'});
  const auth=parseAuthenticatorData(authBytes);
  checkFlags(auth,rpId);
  const signature=b64urlDecode(response.signature,{max:1024,code:'SIGNATURE_INVALID'});
  let key;try{key=createPublicKey({key:credential.publicKeySpki,format:'der',type:'spki'});}catch{fail('CREDENTIAL_KEY_INVALID');}
  const signed=Buffer.concat([authBytes,sha256(raw)]);
  const ok=credential.algorithm===-7?verifySignature('sha256',signed,{key,dsaEncoding:'der'},signature):
    credential.algorithm===-257?verifySignature('RSA-SHA256',signed,key,signature):
    credential.algorithm===-8?verifySignature(null,signed,key,signature):fail('COSE_ALGORITHM_UNSUPPORTED');
  if(!ok)fail('SIGNATURE_INVALID');
  const stored=credential.signCount??0;
  if((auth.signCount>0||stored>0)&&auth.signCount<=stored)fail('SIGN_COUNT_REGRESSION');
  return {signCount:auth.signCount,userVerified:true};
}
