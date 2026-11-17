/** Test-only passkey sign-in fixture on http://localhost (a secure context for WebAuthn).
 * Uses the real passkey auth and admin handler with an in-memory store; never a production login. */
import {createServer} from 'node:http';
import {createPublisherHandler} from '../../apps/web/admin/server/index.mjs';
import {createPasskeyPublisherAuth} from '../../packages/auth/passkey.mjs';
import {createMemoryPasskeyStore} from '../helpers/memory-passkey-store.mjs';
if(process.env.NODE_ENV!=='test')throw Error('NODE_ENV=test required for the passkey fixture');
const publisherId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ownerUserId='11111111-1111-4111-8111-111111111111';
const digest=process.env.ASK_BILL_TEST_INVITE_DIGEST;if(!/^[a-f0-9]{64}$/.test(digest??''))throw Error('ASK_BILL_TEST_INVITE_DIGEST required');
const server=createServer();
server.listen(0,'127.0.0.1',()=>{
  const origin='http://localhost:'+server.address().port;
  const store=createMemoryPasskeyStore({publisherId,ownerUserId,invites:[digest]});
  const auth=createPasskeyPublisherAuth({expectedOrigin:origin,rpId:'localhost',publisherId,store,allowLoopbackHttpForTests:true});
  const handler=createPublisherHandler({auth,storage:{},expectedOrigin:origin,publisherId,allowLoopbackHttpForTests:true,
    repository:{async listBills(){return [];}}});
  server.on('request',(req,res)=>handler(req,res).then(h=>{if(!h){res.statusCode=404;res.end();}}).catch(()=>{res.statusCode=500;res.end();}));
  process.stdout.write(origin+'\n');
});
for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>server.close(()=>process.exit(0)));
