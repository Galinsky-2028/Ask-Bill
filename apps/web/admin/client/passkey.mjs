/** Publisher passkey ceremonies (WebAuthn). Same-origin JSON only; no third-party code. */
const b64 = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const bytes = value => Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/') + '='.repeat((4 - value.length % 4) % 4)),c => c.charCodeAt(0));
const status = text => { const el = document.querySelector('[data-passkey-status]'); if (el) el.textContent = text; };
const messages = {
  INVITE_INVALID: 'That invite code is not valid, has expired, or was already used.',
  PASSKEY_VERIFICATION_FAILED: 'The passkey could not be verified. Try again with the passkey enrolled for this publisher.',
  PUBLISHER_NOT_ENROLLED: 'This passkey is not enrolled for this publisher.',
  AUTH_RATE_LIMITED: 'Too many sign-in attempts. Wait a few minutes and try again.'
};
async function post(path, body) {
  const response = await fetch(path, {method:'POST',credentials:'same-origin',cache:'no-store',
    headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(body)});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error ?? 'REQUEST_FAILED'), {code:data.error});
  return data;
}
const explain = error => error?.name === 'NotAllowedError' ? 'The passkey request was cancelled or timed out.' :
  messages[error?.code] ?? 'The request could not be completed. Try again.';

if (!window.PublicKeyCredential) status('This browser does not support passkeys.');

const login = document.querySelector('[data-passkey-login]');
login?.querySelector('[data-passkey-action]')?.addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true; status('Waiting for your passkey…');
  try {
    const {options} = await post('/admin/auth/passkey/options', {returnTo: login.dataset.returnTo});
    const credential = await navigator.credentials.get({publicKey:{...options,challenge:bytes(options.challenge)}});
    const r = credential.response;
    const result = await post('/admin/auth/passkey/verify', {credential:{id:b64(credential.rawId),type:credential.type,response:{
      clientDataJSON:b64(r.clientDataJSON),authenticatorData:b64(r.authenticatorData),signature:b64(r.signature),
      userHandle:r.userHandle ? b64(r.userHandle) : null}}});
    status('Signed in.'); location.assign(result.location);
  } catch (error) { status(explain(error)); button.disabled = false; }
});

document.querySelector('[data-passkey-enroll]')?.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget, button = form.querySelector('button'); button.disabled = true; status('Checking your invite…');
  try {
    const {options} = await post('/admin/auth/passkey/register/options', {invite: form.elements.invite.value.trim()});
    form.elements.invite.value = '';
    status('Create the passkey on your device…');
    const credential = await navigator.credentials.create({publicKey:{...options,challenge:bytes(options.challenge),
      user:{...options.user,id:bytes(options.user.id)}}});
    const r = credential.response;
    const result = await post('/admin/auth/passkey/register/verify', {credential:{id:b64(credential.rawId),type:credential.type,response:{
      clientDataJSON:b64(r.clientDataJSON),attestationObject:b64(r.attestationObject),transports:r.getTransports?.() ?? []}}});
    status('Passkey created. Signing you in…'); location.assign(result.location);
  } catch (error) { status(explain(error)); button.disabled = false; }
});
