/** Owner-only: store a one-time passkey enrolment invite DIGEST for the publisher's owner.
 * Runs with the owner/migration connection (never the runtime role). The plaintext invite never
 * reaches the server; only its SHA-256 digest is stored. Idempotent: an existing (or redeemed)
 * invite with the same digest is left unchanged and reported without printing the digest.
 */
import {pathToFileURL} from 'node:url';
import {createApplicationPool} from '../packages/db/pool.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function inviteSettings(env){
  const publisherId=env.ASK_BILL_PUBLISHER_ID,digest=env.ASK_BILL_OWNER_INVITE_DIGEST;
  const hours=env.ASK_BILL_OWNER_INVITE_TTL_HOURS===undefined?72:Number(env.ASK_BILL_OWNER_INVITE_TTL_HOURS);
  if(!UUID.test(publisherId??'')||!/^[a-f0-9]{64}$/.test(digest??'')||!Number.isSafeInteger(hours)||hours<1||hours>336)throw Error('INVITE_CONFIGURATION');
  return {publisherId:publisherId.toLowerCase(),digest,hours};
}
export async function createOwnerInvite({pool,settings}){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query("SELECT set_config('ask_bill.publisher_id',$1,true)",[settings.publisherId]);
    const owners=(await client.query("SELECT user_id FROM ask_bill.publisher_memberships WHERE publisher_id=$1 AND role='owner' ORDER BY created_at,user_id",[settings.publisherId])).rows;
    if(owners.length!==1)throw Error('SINGLE_OWNER_REQUIRED');
    const existing=(await client.query('SELECT redeemed_at,expires_at FROM ask_bill.publisher_enrollment_invites WHERE publisher_id=$1 AND invite_sha256=$2',[settings.publisherId,settings.digest])).rows[0];
    let status;
    if(existing)status=existing.redeemed_at?'already-redeemed':(existing.expires_at<new Date()?'expired':'pending');
    else{
      await client.query(`INSERT INTO ask_bill.publisher_enrollment_invites(publisher_id,invite_sha256,user_id,expires_at)
        VALUES($1,$2,$3,clock_timestamp()+make_interval(hours=>$4))`,[settings.publisherId,settings.digest,owners[0].user_id,settings.hours]);
      await client.query("INSERT INTO ask_bill.audit_events(publisher_id,action,detail) VALUES($1,'publisher.invite_created',jsonb_build_object('hours',$2::int))",[settings.publisherId,settings.hours]);
      status='created';
    }
    await client.query('COMMIT');
    return {status,expiresInHours:status==='created'?settings.hours:undefined};
  }catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}finally{client.release();}
}
async function main(){
  const settings=inviteSettings(process.env),url=process.env.ASK_BILL_MIGRATION_DATABASE_URL;if(!url)throw Error('OWNER_URL_REQUIRED');
  const pool=await createApplicationPool({connectionString:url,hosted:!['development','test'].includes(process.env.ASK_BILL_STAGE??'production'),verifyRole:false,max:1});
  try{process.stdout.write(JSON.stringify({product:'ask-bill',ownerInvite:await createOwnerInvite({pool,settings})})+'\n');}finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{
  process.stderr.write('Ask Bill owner invite failed. Check the owner connection, publisher bootstrap and invite digest.\n');process.exitCode=1;
});
