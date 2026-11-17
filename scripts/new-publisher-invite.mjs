/** Generate a one-time publisher enrolment invite LOCALLY (AB-008 passkey path).
 *
 * Run this on your own computer. It prints the invite code (keep it private; you will type it once
 * at /admin/enroll) and its SHA-256 digest (the only value that ever leaves your computer: set it as
 * ASK_BILL_OWNER_INVITE_DIGEST on the hosting service). Nothing is sent anywhere or written to disk.
 *
 *   node scripts/new-publisher-invite.mjs
 * Equivalent without Node:  code=$(openssl rand 32 | basenc --base64url | tr -d '=\n'); printf %s "$code" | sha256sum
 */
import {randomBytes,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const inviteDigest=code=>{
  if(!/^[A-Za-z0-9_-]{43}$/.test(code??''))throw Error('INVITE_FORMAT');
  return createHash('sha256').update(code).digest('hex');
};
export function newInvite(){const code=randomBytes(32).toString('base64url');return {code,digest:inviteDigest(code)};}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const {code,digest}=newInvite();
  process.stdout.write(`Invite code (private, single use, type it at /admin/enroll):\n  ${code}\n\nDigest (set as ASK_BILL_OWNER_INVITE_DIGEST on the server):\n  ${digest}\n`);
}
