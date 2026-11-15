import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {bootstrapSettings} from '../scripts/bootstrap-publisher.mjs';

const run=promisify(execFile);
const script=fileURLToPath(new URL('../infra/start-web.sh',import.meta.url));
const base={ASK_BILL_PUBLISHER_ID:randomUUID(),ASK_BILL_OWNER_USER_ID:randomUUID(),ASK_BILL_PUBLISHER_SLUG:'ask-bill',
  ASK_BILL_PUBLISHER_NAME:'Ask Bill',ASK_BILL_RUNTIME_DB_ROLE:'ask_bill_runtime',ASK_BILL_RUNTIME_DB_PASSWORD:'x'.repeat(40)};

test('deferred owner identity bootstraps without inventing an identity',()=>{
  const settings=bootstrapSettings({...base,ASK_BILL_OWNER_IDENTITY:'deferred'});
  assert.equal(settings.issuer,null);assert.equal(settings.subject,null);
});

test('deferred mode refuses partial or conflicting identity values',()=>{
  assert.throws(()=>bootstrapSettings({...base,ASK_BILL_OWNER_IDENTITY:'deferred',ASK_BILL_OIDC_ISSUER:'https://id.example.test'}),/BOOTSTRAP_CONFIGURATION/);
  assert.throws(()=>bootstrapSettings({...base,ASK_BILL_OWNER_IDENTITY:'deferred',ASK_BILL_OWNER_OIDC_SUBJECT:'subject'}),/BOOTSTRAP_CONFIGURATION/);
  assert.throws(()=>bootstrapSettings({...base,ASK_BILL_OWNER_IDENTITY:'skip'}),/BOOTSTRAP_CONFIGURATION/);
  assert.throws(()=>bootstrapSettings(base),/BOOTSTRAP_CONFIGURATION/);
  const enrolled=bootstrapSettings({...base,ASK_BILL_OIDC_ISSUER:'https://id.example.test',ASK_BILL_OWNER_OIDC_SUBJECT:'subject'});
  assert.equal(enrolled.issuer,'https://id.example.test');
});

async function withStubNode(fn){
  const dir=await mkdtemp(join(tmpdir(),'ask-bill-start-'));
  const log=join(dir,'calls.log');
  // The stub records each invocation and, for the web process, the owner values it can still see.
  await writeFile(join(dir,'node'),`#!/bin/sh
printf '%s|%s|%s\\n' "$*" "\${ASK_BILL_MIGRATION_DATABASE_URL:-}" "\${ASK_BILL_RUNTIME_DB_PASSWORD:-}" >> "${log}"
[ "$1" != "\${FAIL_ON:-none}" ]
`);
  await chmod(join(dir,'node'),0o755);
  try{return await fn({dir,log});}finally{await rm(dir,{recursive:true,force:true});}
}

test('hosted start skips maintenance when no owner URL is configured',async()=>{
  await withStubNode(async({dir,log})=>{
    await run('sh',[script],{env:{PATH:dir+':/usr/bin:/bin'}});
    assert.deepEqual((await readFile(log,'utf8')).trim().split('\n'),['apps/web/application/start.mjs||']);
  });
});

test('hosted start migrates, bootstraps and strips owner values before the web process',async()=>{
  await withStubNode(async({dir,log})=>{
    await run('sh',[script],{env:{PATH:dir+':/usr/bin:/bin',ASK_BILL_MIGRATION_DATABASE_URL:'postgresql://owner:secret@db.example.test/askbill',
      ASK_BILL_RUNTIME_DB_PASSWORD:'runtime-secret',ASK_BILL_OWNER_USER_ID:base.ASK_BILL_OWNER_USER_ID}});
    const lines=(await readFile(log,'utf8')).trim().split('\n');
    assert.deepEqual(lines.map(line=>line.split('|')[0]),['scripts/migrate.mjs','scripts/bootstrap-publisher.mjs','scripts/migrate.mjs --check','apps/web/application/start.mjs']);
    assert.equal(lines.at(-1),'apps/web/application/start.mjs||');
  });
});

test('hosted start never launches the web process after failed maintenance',async()=>{
  await withStubNode(async({dir,log})=>{
    await assert.rejects(run('sh',[script],{env:{PATH:dir+':/usr/bin:/bin',FAIL_ON:'scripts/migrate.mjs',
      ASK_BILL_MIGRATION_DATABASE_URL:'postgresql://owner:secret@db.example.test/askbill'}}));
    assert.deepEqual((await readFile(log,'utf8')).trim().split('\n').map(line=>line.split('|')[0]),['scripts/migrate.mjs']);
  });
});
