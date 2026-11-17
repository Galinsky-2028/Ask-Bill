/** Test-only in-memory passkey store with the same contract as passkey-store.mjs. */
export function createMemoryPasskeyStore({publisherId,ownerUserId,invites=[]}){
  const challenges=new Map(),passkeys=new Map(),sessions=new Map(),identities=new Set(),invitations=new Map(invites.map(h=>[h,{redeemed:false,expiresAt:Date.now()+3600000}]));
  const scoped=input=>{if(input.publisherId!==publisherId)throw Error('PUBLISHER_FORBIDDEN');};
  return {
    state:{challenges,passkeys,sessions,identities,invitations},
    async saveChallenge(i){scoped(i);challenges.set(i.bindingHash,{...i});},
    async consumeChallenge(i){scoped(i);const c=challenges.get(i.bindingHash);challenges.delete(i.bindingHash);
      return c&&c.purpose===i.purpose&&c.expiresAt>i.now?{purpose:c.purpose,challenge:c.challenge,inviteHash:c.inviteHash,returnTo:c.returnTo,
        requireMfa:c.requireMfa,previousSessionHash:c.previousSessionHash,createdAt:c.createdAt,expiresAt:c.expiresAt}:null;},
    async inviteAvailable(i){scoped(i);const v=invitations.get(i.inviteHash);return !!v&&!v.redeemed&&v.expiresAt>i.now;},
    async redeemInvite(i){scoped(i);const v=invitations.get(i.inviteHash);if(!v||v.redeemed)return null;v.redeemed=true;
      identities.add(i.identityHash);passkeys.set(i.credentialId,{userId:ownerUserId,identityHash:i.identityHash,publicKeySpki:i.publicKeySpki,algorithm:i.algorithm,signCount:i.signCount,role:'owner'});
      return {userId:ownerUserId,role:'owner'};},
    async getPasskey(i){scoped(i);const p=passkeys.get(i.credentialId);return p&&identities.has(p.identityHash)?{...p}:null;},
    async recordPasskeyUse(i){scoped(i);const p=passkeys.get(i.credentialId);if(!p||p.signCount!==i.previousSignCount)return false;p.signCount=i.signCount;return true;},
    async saveSession(i){scoped(i);sessions.set(i.sessionHash,{...i});},
    async getSession(i){scoped(i);const s=sessions.get(i.sessionHash);return s&&identities.has(s.identityHash)?{...s}:null;},
    async deleteSession(i){scoped(i);sessions.delete(i.sessionHash);},
    async resolveMembership(i){scoped(i);return i.userId===ownerUserId?'owner':null;}
  };
}
