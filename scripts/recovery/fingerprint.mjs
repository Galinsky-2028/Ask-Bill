/** Restore verification fingerprint (AB-104).
 *
 * Produces a content-free fingerprint of one publisher's durable state: migration journal hashes,
 * per-table row counts, an order-independent digest over immutable source hashes, release packs and
 * audit history, plus row-level-security and runtime-role boundary flags. It reads no question text,
 * drafts or secrets and prints only counts and SHA-256 digests, so it is safe to retain as drill
 * evidence. Compare a production fingerprint with a restored branch's fingerprint.
 *
 * Usage (owner connection; never attach it to a running service):
 *   ASK_BILL_MIGRATION_DATABASE_URL=… ASK_BILL_PUBLISHER_ID=… node scripts/recovery/fingerprint.mjs
 *   node scripts/recovery/fingerprint.mjs --compare before.json after.json
 */
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createApplicationPool} from '../../packages/db/pool.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
/** Durable tables that must survive a restore. Ephemeral session/login tables are counted but not compared. */
export const DURABLE_TABLES=Object.freeze(['publishers','publisher_memberships','publisher_auth_identities','bills','bill_versions',
  'provisions','source_objects','source_import_events','publisher_version_extractions','publisher_version_reviews',
  'publisher_public_packs','release_packs','release_active','search_generations','search_active','search_entries',
  'publisher_tour_drafts','publisher_translation_drafts','audit_events','jobs','outbox_events','publisher_source_requests']);
export const EPHEMERAL_TABLES=Object.freeze(['anonymous_sessions','anonymous_answers','anonymous_usage_daily','sessions',
  'publisher_auth_sessions','publisher_login_transactions','usage_limits','usage_reservations']);
/** Each query returns rows of hash strings only; the digest is order-independent. */
const DIGESTS=Object.freeze({
  sourceVersions:`SELECT id::text||':'||raw_byte_sha256||':'||canonical_text_sha256 AS h FROM ask_bill.bill_versions`,
  sourceObjects:`SELECT sha256 AS h FROM ask_bill.source_objects`,
  releasePacks:`SELECT id::text||':'||manifest_sha256 AS h FROM ask_bill.release_packs`,
  activeReleases:`SELECT bill_id::text||':'||release_id::text AS h FROM ask_bill.release_active`,
  auditEvents:`SELECT id::text AS h FROM ask_bill.audit_events`
});
const sha=value=>createHash('sha256').update(value).digest('hex');
export const setDigest=values=>sha([...values].sort().join('\n'));

export async function fingerprint(pool,{publisherId}){
  if(!UUID.test(publisherId??''))throw Error('FINGERPRINT_PUBLISHER_REQUIRED');
  const client=await pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SELECT set_config('ask_bill.publisher_id',$1,true)",[publisherId.toLowerCase()]);
    const migrations=(await client.query('SELECT path,sha256 FROM ask_bill_meta.schema_migrations ORDER BY path')).rows.map(r=>r.path+':'+r.sha256);
    const counts={};
    for(const table of [...DURABLE_TABLES,...EPHEMERAL_TABLES]){
      const exists=(await client.query("SELECT to_regclass($1) IS NOT NULL AS ok",['ask_bill.'+table])).rows[0].ok;
      counts[table]=exists?Number((await client.query(`SELECT count(*)::bigint AS n FROM ask_bill.${table}`)).rows[0].n):null;
    }
    const digests={};
    for(const [name,sql] of Object.entries(DIGESTS)){
      const rows=(await client.query(sql)).rows;digests[name]={count:rows.length,sha256:setDigest(rows.map(r=>r.h))};
    }
    const rls=(await client.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='ask_bill' AND c.relkind='r' ORDER BY c.relname`)).rows;
    const unprotected=rls.filter(r=>!r.relrowsecurity||!r.relforcerowsecurity).map(r=>r.relname);
    await client.query('COMMIT');
    return {product:'ask-bill',fingerprint:1,publisherId:publisherId.toLowerCase(),
      migrations:{count:migrations.length,sha256:setDigest(migrations)},counts,digests,rls:{tables:rls.length,unprotected}};
  }catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}finally{client.release();}
}

/** Returns a list of human-readable differences; empty means the restore preserved durable state. */
export function compareFingerprints(before,after){
  const diffs=[];
  if(before.publisherId!==after.publisherId)diffs.push('publisher differs');
  if(before.migrations.sha256!==after.migrations.sha256)diffs.push('migration journal differs');
  for(const table of DURABLE_TABLES)if(before.counts[table]!==after.counts[table])
    diffs.push(`${table} rows ${before.counts[table]} -> ${after.counts[table]}`);
  for(const name of Object.keys(DIGESTS))if(before.digests[name]?.sha256!==after.digests[name]?.sha256)
    diffs.push(`${name} digest differs (${before.digests[name]?.count} -> ${after.digests[name]?.count})`);
  if(after.rls.unprotected.length)diffs.push('row-level security missing on '+after.rls.unprotected.join(','));
  return diffs;
}

async function main(){
  const args=process.argv.slice(2);
  if(args[0]==='--compare'&&args.length===3){
    const [before,after]=await Promise.all(args.slice(1).map(async p=>JSON.parse(await readFile(p,'utf8'))));
    const diffs=compareFingerprints(before,after);
    process.stdout.write(JSON.stringify({product:'ask-bill',restoreMatches:diffs.length===0,differences:diffs},null,2)+'\n');
    if(diffs.length)process.exitCode=2;return;
  }
  if(args.length)throw Error('FINGERPRINT_ARGUMENTS');
  const url=process.env.ASK_BILL_MIGRATION_DATABASE_URL;if(!url)throw Error('FINGERPRINT_OWNER_URL_REQUIRED');
  const hosted=!['development','test'].includes(process.env.ASK_BILL_STAGE??'production');
  const pool=await createApplicationPool({connectionString:url,hosted,verifyRole:false,max:1});
  try{process.stdout.write(JSON.stringify(await fingerprint(pool,{publisherId:process.env.ASK_BILL_PUBLISHER_ID}),null,2)+'\n');}
  finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{
  process.stderr.write('Ask Bill restore fingerprint failed. Check the owner connection, publisher ID and migrations.\n');process.exitCode=1;
});
