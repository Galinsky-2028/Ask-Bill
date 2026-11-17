/** Private original storage in PostgreSQL: an alternative to S3 that needs no external account.
 *
 * Same interface and guarantees as s3.mjs: content-addressed by SHA-256, immutable source objects,
 * intake scanning before write, and integrity re-verified on every read. Per-object and per-publisher
 * byte caps keep a small free database within quota. Rows are publisher-scoped under FORCE RLS.
 */
import {createHash} from 'node:crypto';
import {scanQuarantinedBytes} from '../content/intake/index.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HEX=/^[a-f0-9]{64}$/;
const SCOPES=new Set(['quarantine','private-source']);
export class PostgresStorageError extends Error{constructor(code){super(code);this.name='PostgresStorageError';this.code=code;}}
const fail=code=>{throw new PostgresStorageError(code);};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

export function createPostgresPrivateStorage({pool,publisherId,maxObjectBytes=10485760,maxTotalBytes=209715200}={}){
  if(!pool||typeof pool.connect!=='function'||!UUID.test(publisherId??'')||!Number.isSafeInteger(maxObjectBytes)||maxObjectBytes<1024||
    maxObjectBytes>26214400||!Number.isSafeInteger(maxTotalBytes)||maxTotalBytes<maxObjectBytes)fail('STORAGE_CONFIGURATION_INVALID');
  const publisher=publisherId.toLowerCase();
  const keyOf=sha256=>publisher+'/sha256/'+sha256;
  function target({scope,publisherId:requested,key,sha256}){
    if(requested!==publisher||!SCOPES.has(scope)||!HEX.test(sha256??''))fail('OBJECT_FORBIDDEN');
    if(key!==undefined&&key!==keyOf(sha256))fail('UNSAFE_OBJECT_KEY');
    return {scope,sha256};
  }
  async function transaction(fn){
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query("SELECT set_config('ask_bill.publisher_id', $1, true)",[publisher]);
      const result=await fn(client);await client.query('COMMIT');return result;
    }catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}finally{client.release();}
  }
  async function read(client,input){
    const {scope,sha256}=target(input);
    const limit=input.maxBytes??maxObjectBytes;if(!Number.isSafeInteger(limit)||limit<1||limit>maxObjectBytes)fail('UPLOAD_LIMIT');
    const rows=(await client.query('SELECT mime,size_bytes,content FROM ask_bill.private_objects WHERE publisher_id=$1::uuid AND scope=$2 AND sha256=$3',
      [publisher,scope,sha256])).rows;
    if(rows.length!==1)fail('OBJECT_NOT_FOUND');
    const row=rows[0],content=Buffer.from(row.content);
    if(row.size_bytes>limit)fail('OBJECT_RESPONSE_LIMIT');
    if(content.length!==row.size_bytes||digest(content)!==sha256||(input.size!==undefined&&input.size!==content.length))fail('OBJECT_INTEGRITY_FAILED');
    return {scope,publisherId:publisher,key:keyOf(sha256),sha256,bytes:content.length,mime:row.mime,content};
  }
  async function write(client,input,scope){
    const {sha256}=target({...input,scope});
    const checked=scanQuarantinedBytes(input.content,input.mime);
    if(checked.sha256!==sha256)fail('OBJECT_INTEGRITY_FAILED');
    if(checked.bytes>maxObjectBytes)fail('UPLOAD_LIMIT');
    // Serialise quota checks per publisher so concurrent uploads cannot jointly exceed the cap.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',[publisher+':private-objects']);
    const existing=(await client.query('SELECT mime FROM ask_bill.private_objects WHERE publisher_id=$1::uuid AND scope=$2 AND sha256=$3',[publisher,scope,sha256])).rows[0];
    if(existing){if(existing.mime!==input.mime)fail('OBJECT_IMMUTABILITY_CONFLICT');}
    else{
      const used=Number((await client.query('SELECT coalesce(sum(size_bytes),0)::bigint AS used FROM ask_bill.private_objects WHERE publisher_id=$1::uuid',[publisher])).rows[0].used);
      if(used+checked.bytes>maxTotalBytes)fail('STORAGE_QUOTA_EXCEEDED');
      await client.query('INSERT INTO ask_bill.private_objects(publisher_id,scope,sha256,mime,size_bytes,content) VALUES($1::uuid,$2,$3,$4,$5,$6)',
        [publisher,scope,sha256,input.mime,checked.bytes,Buffer.from(input.content)]);
    }
    // Re-read inside the same transaction: the stored bytes, not the request, are what we vouch for.
    await read(client,{scope,publisherId:publisher,sha256,size:checked.bytes,maxBytes:checked.bytes});
    return Object.freeze({scope,publisherId:publisher,key:keyOf(sha256),sha256,bytes:checked.bytes,mime:input.mime,objectStoredAndVerified:true});
  }
  return Object.freeze({
    kind:'postgres',publisherId:publisher,maxObjectBytes,maxTotalBytes,
    putQuarantine(input){return transaction(client=>write(client,input,'quarantine'));},
    putPrivateSource(input){return transaction(client=>write(client,input,'private-source'));},
    getPrivateSource(input){return transaction(client=>read(client,{...input,scope:'private-source'}));},
    getQuarantine(input){return transaction(client=>read(client,{...input,scope:'quarantine'}));},
    promoteQuarantine(input){
      return transaction(async client=>{
        const old=await read(client,{...input,scope:'quarantine',size:undefined});
        const stored=await write(client,{...input,content:old.content,mime:input.mime??old.mime},'private-source');
        await client.query("DELETE FROM ask_bill.private_objects WHERE publisher_id=$1::uuid AND scope='quarantine' AND sha256=$2",[publisher,old.sha256]);
        return stored;
      });
    },
    deleteQuarantine(input){
      const {sha256}=target({...input,scope:'quarantine'});
      return transaction(async client=>{await client.query("DELETE FROM ask_bill.private_objects WHERE publisher_id=$1::uuid AND scope='quarantine' AND sha256=$2",[publisher,sha256]);return {deleted:true};});
    },
    async usage(){
      return transaction(async client=>{const r=(await client.query('SELECT count(*)::int AS objects,coalesce(sum(size_bytes),0)::bigint AS bytes FROM ask_bill.private_objects WHERE publisher_id=$1::uuid',[publisher])).rows[0];
        return {objects:r.objects,bytes:Number(r.bytes),maxTotalBytes};});
    }
  });
}
