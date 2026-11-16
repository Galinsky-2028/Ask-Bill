/** Public application composition; every optional provider stays behind a server adapter. */
import {readFile} from 'node:fs/promises';
import {createPublishedSourceServer} from '../source-only/server.mjs';
import {createConversationService} from './conversation.mjs';
import {createApplicationApi} from './api.mjs';
import {createTelemetry,authorizedMetricsRequest} from '../../../packages/telemetry/index.mjs';

const modules=new Map([
  ['/reader-client.mjs','../source-only/reader-client.mjs'],
  ['/browser/packages/ui/reader/client-core.mjs','../../../packages/ui/reader/client-core.mjs'],
  ['/browser/packages/ui/citations/index.mjs','../../../packages/ui/citations/index.mjs'],
  ['/browser/packages/contracts/dist/index.js','../../../packages/contracts/dist/index.js'],
  ['/browser/packages/voice/stt/push-to-talk.mjs','../../../packages/voice/stt/push-to-talk.mjs'],
  ['/browser/packages/voice/playback/controller.mjs','../../../packages/voice/playback/controller.mjs'],
  ['/experience/character-stage.mjs','../experience/character-stage.mjs'],
  ['/browser/packages/character/renderer/stage.mjs','../../../packages/character/renderer/stage.mjs'],
  ['/browser/packages/character/animation/mixer.mjs','../../../packages/character/animation/mixer.mjs'],
  ['/browser/packages/character/attention/targets.mjs','../../../packages/character/attention/targets.mjs'],
  ['/browser/packages/character/layout/registry.mjs','../../../packages/character/layout/registry.mjs'],
  ['/browser/packages/character/renderer/follow.mjs','../../../packages/character/renderer/follow.mjs'],
  ['/browser/packages/character/animation/face.mjs','../../../packages/character/animation/face.mjs']
]);
// three.js is served same-origin (CSP script-src 'self'); its bare 'three' imports are rewritten.
const vendor=new Map([
  ['/vendor/three/three.module.min.js','three/build/three.module.min.js'],
  ['/vendor/three/loaders/GLTFLoader.js','three/examples/jsm/loaders/GLTFLoader.js'],
  ['/vendor/three/utils/BufferGeometryUtils.js','three/examples/jsm/utils/BufferGeometryUtils.js'],
  ['/vendor/three/three.webgpu.min.js','three/build/three.webgpu.min.js'],
  // WebGPU variant: the loader must share the WebGPU build's classes, so its 'three' import differs.
  ['/vendor/three-webgpu/loaders/GLTFLoader.js','three/examples/jsm/loaders/GLTFLoader.js'],
  ['/vendor/three-webgpu/utils/BufferGeometryUtils.js','three/examples/jsm/utils/BufferGeometryUtils.js']
]);
const BACKEND_CHOICES=new Set(['auto','webgpu','webgl2']);
const CHARACTER_ASSET=/^bill-[0-9]{2}\.glb$/;
const security={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin'};
const escape=text=>text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function send(res,status,body,type='text/html; charset=utf-8',head=false,extra={}){
  const bytes=Buffer.from(body);res.writeHead(status,{...security,'Content-Type':type,'Content-Length':bytes.length,...extra});res.end(head?undefined:bytes);
}
function information(title,content){return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'+escape(title)+' — Ask Bill</title><link rel="stylesheet" href="/public-reader.css"></head><body><header><a href="/bills">Ask Bill</a></header><main><h1>'+escape(title)+'</h1>'+content+'</main></body></html>';}
export async function createAskBillApplication({publisherId,origin,stage='production',sessions,lookupPublishedPack,lookupPublishedCatalog,
  provider=null,reviewer=null,speech=null,transcription=null,publisherHandler=null,authorizeSpeechSegment=()=>{},
  readiness=async()=>true,buildSha='development',maxInflight=25,telemetry=createTelemetry(),metricsToken=null,diagnostics=null,character={enabled:false}}={}){
  const conversation=createConversationService({publisherId,lookupPublishedPack,provider,reviewer});
  const api=createApplicationApi({publisherId,origin,stage,sessions,conversation,lookupPublishedPack,speech,transcription,authorizeSpeechSegment,maxInflight});
  const staticFiles=new Map();
  for(const [path,file] of modules)staticFiles.set(path,await readFile(new URL(file,import.meta.url)));
  const characterEnabled=character?.enabled===true;
  if(characterEnabled){
    if(!CHARACTER_ASSET.test(character.assetFile??''))throw Error('INVALID_CHARACTER_ASSET');
    if(!BACKEND_CHOICES.has(character.backend??'auto'))throw Error('INVALID_CHARACTER_BACKEND');
    for(const [path,specifier] of vendor){
      const source=await readFile(new URL('../../../node_modules/'+specifier,import.meta.url),'utf8');
      const core=path.startsWith('/vendor/three-webgpu/')?'/vendor/three/three.webgpu.min.js':'/vendor/three/three.module.min.js';
      staticFiles.set(path,Buffer.from(source.replaceAll("from 'three'","from '"+core+"'")));
    }
  }
  const characterConfig=Buffer.from(JSON.stringify(characterEnabled?{enabled:true,assetUrl:'/experience/assets/bill.glb',backend:character.backend??'auto',follow:character.follow!==false,status:'candidate-not-approved'}:{enabled:false}));
  let characterAsset=null;
  const server=await createPublishedSourceServer({publisherId,lookupPublishedPack,lookupPublishedCatalog,interactive:true,
    requestHandler:async(req,res)=>{
      if(stage==='production')res.setHeader('Strict-Transport-Security','max-age=31536000');
      if(await api.handle(req,res))return true;
      if(publisherHandler&&await publisherHandler(req,res))return true;
      if(!['GET','HEAD'].includes(req.method))return false;
      const head=req.method==='HEAD';
      if(staticFiles.has(req.url)){send(res,200,staticFiles.get(req.url),'text/javascript; charset=utf-8',head);return true;}
      if(req.url==='/experience/character.json'){send(res,200,characterConfig,'application/json',head);return true;}
      if(req.url==='/experience/assets/bill.glb'&&characterEnabled){
        characterAsset??=await readFile(new URL('../../../assets/bill/characters/dist/'+character.assetFile,import.meta.url));
        send(res,200,characterAsset,'model/gltf-binary',head,{'Cache-Control':'public, max-age=86400'});return true;
      }
      if(req.url==='/'){res.writeHead(302,{...security,Location:'/bills'});res.end();return true;}
      if(req.url==='/health/metrics'){
        // Disabled (404) unless an operator token is configured; aggregate counters only.
        if(!authorizedMetricsRequest(req,metricsToken))return false;
        const snapshot=telemetry.snapshot();
        if(diagnostics){try{snapshot.diagnostics=await diagnostics();}catch{snapshot.diagnostics={unavailableCount:1};}}
        send(res,200,JSON.stringify(snapshot),'application/json',head);return true;
      }
      if(req.url==='/health/live'||req.url==='/health/ready'){
        const ready=req.url==='/health/live'||await readiness();
        if(!ready)telemetry.record('readiness_failed');
        send(res,ready?200:503,JSON.stringify({product:'ask-bill',status:ready?'ready':'unavailable',build:buildSha}), 'application/json',head);return true;
      }
      if(req.url==='/privacy'){
        send(res,200,information('Privacy and controls','<p>Reading legislation does not require an account or microphone.</p><p>Questions are sent only after you start an eligible session. Session cookies expire after 30 minutes. The application does not log question text. Accepted answers can be held in encrypted temporary storage for the same session; Clear session removes them. Bookmarks and reading preferences stay in this browser tab.</p><p>When enabled, AI and speech requests are sent to the configured service provider. Its retention settings must be verified by the operator before enabling those features. The application cannot promise that deleting a session deletes data already retained by an external provider.</p><p>Microphone recording starts only when you choose Record. You choose when to send a recording for transcription and review the transcript before asking a question. No microphone data is written to application storage. Guided learning sends no free-text questions or recordings.</p><p>Downloading or sharing is explicit. Source links contain only the bill version and section. Conversation exports stay in the file you choose to save.</p>'),undefined,head);return true;
      }
      if(req.url==='/accessibility'){
        send(res,200,information('Accessibility','<p>Read and search the complete source without JavaScript, sound, graphics or an account. All interactive controls support keyboard use, with visible focus and selectable captions. You can enlarge text, stop speech, and use exact section links.</p><p>Reduced-motion preferences are respected. The 3D character is an optional enhancement and does not replace source text or citations.</p>'),undefined,head);return true;
      }
      if(req.url==='/about'){
        send(res,200,information('About Ask Bill','<p>Ask Bill helps readers explore legislation through exact sources, guided reading and optional AI explanations. Each source card identifies a specific version. A proposed bill is different from enacted or effective law.</p><p>Ask Bill is an independent reading product. It is not a government service or a provider of individual legal advice.</p>'),undefined,head);return true;
      }
      return false;
    }});
  server.on('request',(req,res)=>telemetry.observe(req,res));
  server.telemetry=telemetry;
  const originalDrain=server.beginReaderDrain;
  server.beginReaderDrain=()=>{api.drain();originalDrain();};
  server.applicationCapacity=()=>({reader:server.readerCapacity(),api:api.capacity()});
  return server;
}
