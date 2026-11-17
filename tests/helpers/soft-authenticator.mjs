/** Test-only software WebAuthn authenticator: real keys and signatures, deterministic structure. */
import {createHash,generateKeyPairSync,sign,randomBytes} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest();
export function encodeCbor(value){
  const head=(major,n)=>n<24?Buffer.from([major<<5|n]):n<256?Buffer.from([major<<5|24,n]):n<65536?Buffer.from([major<<5|25,n>>8,n&255]):
    (()=>{const b=Buffer.alloc(5);b[0]=major<<5|26;b.writeUInt32BE(n,1);return b;})();
  if(Buffer.isBuffer(value))return Buffer.concat([head(2,value.length),value]);
  if(typeof value==='string'){const b=Buffer.from(value);return Buffer.concat([head(3,b.length),b]);}
  if(Number.isInteger(value))return value>=0?head(0,value):head(1,-1-value);
  if(Array.isArray(value))return Buffer.concat([head(4,value.length),...value.map(encodeCbor)]);
  if(value instanceof Map)return Buffer.concat([head(5,value.size),...[...value].flatMap(([k,v])=>[encodeCbor(k),encodeCbor(v)])]);
  throw Error('unsupported');
}
export function createSoftAuthenticator({rpId,origin,algorithm=-7,userVerified=true,userPresent=true}={}){
  const credentialId=randomBytes(32);let counter=0;
  const pair=algorithm===-7?generateKeyPairSync('ec',{namedCurve:'P-256'}):algorithm===-8?generateKeyPairSync('ed25519'):generateKeyPairSync('rsa',{modulusLength:2048});
  const jwk=pair.publicKey.export({format:'jwk'});
  const cose=algorithm===-7?new Map([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x,'base64url')],[-3,Buffer.from(jwk.y,'base64url')]]):
    algorithm===-8?new Map([[1,1],[3,-8],[-1,6],[-2,Buffer.from(jwk.x,'base64url')]]):
    new Map([[1,3],[3,-257],[-1,Buffer.from(jwk.n,'base64url')],[-2,Buffer.from(jwk.e,'base64url')]]);
  const flags=({attested=false}={})=>(userPresent?1:0)|(userVerified?4:0)|(attested?0x40:0);
  const client=(type,challenge,o=origin)=>Buffer.from(JSON.stringify({type,challenge,origin:o,crossOrigin:false}));
  return {
    credentialId:credentialId.toString('base64url'),
    create({challenge,originOverride,rpIdOverride}={}){
      const count=Buffer.alloc(4);count.writeUInt32BE(counter);
      const len=Buffer.alloc(2);len.writeUInt16BE(credentialId.length);
      const authData=Buffer.concat([sha(rpIdOverride??rpId),Buffer.from([flags({attested:true})]),count,Buffer.alloc(16),len,credentialId,encodeCbor(cose)]);
      return {id:credentialId.toString('base64url'),type:'public-key',response:{
        clientDataJSON:client('webauthn.create',challenge,originOverride).toString('base64url'),
        attestationObject:encodeCbor(new Map([['fmt','none'],['attStmt',new Map()],['authData',authData]])).toString('base64url'),transports:['internal']}};
    },
    get({challenge,originOverride,keepCounter=false,tamper=false}={}){
      if(!keepCounter)counter++;
      const count=Buffer.alloc(4);count.writeUInt32BE(counter);
      const authData=Buffer.concat([sha(rpId),Buffer.from([flags()]),count]);
      const clientData=client('webauthn.get',challenge,originOverride);
      const data=Buffer.concat([authData,sha(clientData)]);
      let signature=algorithm===-7?sign('sha256',data,{key:pair.privateKey,dsaEncoding:'der'}):algorithm===-8?sign(null,data,pair.privateKey):sign('RSA-SHA256',data,pair.privateKey);
      if(tamper)signature=Buffer.from(signature.map((b,i)=>i===10?b^1:b));
      return {id:credentialId.toString('base64url'),type:'public-key',response:{clientDataJSON:clientData.toString('base64url'),
        authenticatorData:authData.toString('base64url'),signature:signature.toString('base64url'),userHandle:null}};
    }
  };
}
