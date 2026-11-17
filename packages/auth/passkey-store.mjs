/** PostgreSQL persistence for passkey ceremonies, invites and credentials (publisher scoped, RLS). */
import {AuthError} from './server.mjs';
import {createPostgresAuthStore} from './pg-store.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HEX=/^[a-f0-9]{64}$/;
const fail=code=>{throw new AuthError(code);};
const ms=value=>value instanceof Date?value.getTime():new Date(value).getTime();
const hex=value=>{if(!HEX.test(value??''))fail('PASSKEY_STATE_INVALID');return value;};

export function createPostgresPasskeyStore({pool,publisherId}={}){
  if(!pool||typeof pool.connect!=='function'||!UUID.test(publisherId??''))fail('DURABLE_AUTH_STORE_REQUIRED');
  const publisher=publisherId.toLowerCase(),sessions=createPostgresAuthStore({pool,publisherId});
  async function transaction(request,fn){
    if(request?.publisherId!==publisher)fail('PUBLISHER_FORBIDDEN');
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query("SELECT set_config('ask_bill.publisher_id', $1, true)",[publisher]);
      const result=await fn(client);await client.query('COMMIT');return result;
    }catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}finally{client.release();}
  }
  return Object.freeze({
    ...sessions,
    async saveChallenge(input){
      return transaction(input,async client=>{
        await client.query('DELETE FROM ask_bill.publisher_webauthn_challenges WHERE publisher_id=$1::uuid AND expires_at<=now()',[publisher]);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',[publisher+':passkey-ceremonies']);
        const count=await client.query('SELECT count(*)::int AS count FROM ask_bill.publisher_webauthn_challenges WHERE publisher_id=$1::uuid',[publisher]);
        if(Number(count.rows[0]?.count)>=256)fail('AUTH_RATE_LIMITED');
        await client.query(`INSERT INTO ask_bill.publisher_webauthn_challenges
          (publisher_id,challenge_sha256,binding_sha256,purpose,challenge,invite_sha256,return_path,require_mfa,previous_session_sha256,created_at,expires_at)
          VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[publisher,hex(input.challengeHash),hex(input.bindingHash),input.purpose,input.challenge,
          input.inviteHash?hex(input.inviteHash):null,input.returnTo,input.requireMfa===true,input.previousSessionHash?hex(input.previousSessionHash):null,
          new Date(input.createdAt),new Date(input.expiresAt)]);
      });
    },
    async consumeChallenge(input){
      return transaction(input,async client=>{
        const result=await client.query(`DELETE FROM ask_bill.publisher_webauthn_challenges
          WHERE publisher_id=$1::uuid AND binding_sha256=$2 AND purpose=$3 AND expires_at>$4 AND created_at<=$4
          RETURNING purpose,challenge,invite_sha256,return_path,require_mfa,previous_session_sha256,created_at,expires_at`,
          [publisher,hex(input.bindingHash),input.purpose,new Date(input.now)]);
        if(result.rows.length!==1)return null;const r=result.rows[0];
        return {purpose:r.purpose,challenge:r.challenge,inviteHash:r.invite_sha256,returnTo:r.return_path,requireMfa:r.require_mfa,
          previousSessionHash:r.previous_session_sha256,createdAt:ms(r.created_at),expiresAt:ms(r.expires_at)};
      });
    },
    async inviteAvailable(input){
      return transaction(input,async client=>(await client.query(`SELECT 1 FROM ask_bill.publisher_enrollment_invites
        WHERE publisher_id=$1::uuid AND invite_sha256=$2 AND redeemed_at IS NULL AND expires_at>$3`,[publisher,hex(input.inviteHash),new Date(input.now)])).rows.length===1);
    },
    async redeemInvite(input){
      return transaction(input,async client=>{
        const result=await client.query('SELECT user_id,role FROM ask_bill.redeem_publisher_invite($1,$2,$3,$4,$5,$6,$7)',
          [hex(input.inviteHash),hex(input.identityHash),input.credentialId,input.publicKeySpki,input.algorithm,input.signCount,input.transports??[]]);
        return result.rows.length===1?{userId:result.rows[0].user_id,role:result.rows[0].role}:null;
      });
    },
    async getPasskey(input){
      return transaction(input,async client=>{
        const result=await client.query(`SELECT p.user_id,p.identity_sha256,p.public_key_spki,p.algorithm,p.sign_count,m.role
          FROM ask_bill.publisher_passkeys p
          JOIN ask_bill.publisher_auth_identities i ON i.publisher_id=p.publisher_id AND i.identity_sha256=p.identity_sha256 AND i.user_id=p.user_id AND i.disabled_at IS NULL
          JOIN ask_bill.publisher_memberships m ON m.publisher_id=p.publisher_id AND m.user_id=p.user_id
          WHERE p.publisher_id=$1::uuid AND p.credential_id=$2`,[publisher,input.credentialId]);
        if(result.rows.length!==1)return null;const r=result.rows[0];
        return {userId:r.user_id,identityHash:r.identity_sha256,publicKeySpki:r.public_key_spki,algorithm:r.algorithm,signCount:Number(r.sign_count),role:r.role};
      });
    },
    async recordPasskeyUse(input){
      return transaction(input,async client=>(await client.query(`UPDATE ask_bill.publisher_passkeys SET sign_count=$3,last_used_at=now()
        WHERE publisher_id=$1::uuid AND credential_id=$2 AND sign_count=$4`,[publisher,input.credentialId,input.signCount,input.previousSignCount])).rowCount===1);
    }
  });
}
