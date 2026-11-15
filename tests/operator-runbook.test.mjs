import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const runbook=await readFile(new URL('docs/ops/OPERATOR_RUNBOOK.md',root),'utf8');
const pkg=JSON.parse(await readFile(new URL('package.json',root),'utf8'));
// Paths that may be added by concurrent, not-yet-merged units are listed as optional ("when present").
const OPTIONAL=new Set(['scripts/ops/check-alerts.mjs']);

test('every repository path cited by the operator runbook exists',async()=>{
  const paths=new Set([...runbook.matchAll(/`((?:docs|scripts|tools|tests|infra|packages|assets|registry|apps|\.github)\/[^`\s]*?)`/g)].map(m=>m[1]));
  assert(paths.size>25,'runbook should cite concrete paths');
  const missing=[];
  for(const path of paths){
    if(OPTIONAL.has(path)||path.includes('XXX'))continue;
    try{await access(new URL(path.replace(/<[^>]+>/g,''),root));}catch{missing.push(path);}
  }
  assert.deepEqual(missing,[]);
});

test('every pnpm script named in the runbook exists',()=>{
  const scripts=[...runbook.matchAll(/corepack pnpm ([a-z:]+)/g)].map(m=>m[1]).filter(s=>s!=='install');
  for(const name of scripts)assert(Object.hasOwn(pkg.scripts,name),name);
});

test('runbook names the live service, database and release gate',()=>{
  for(const fact of ['srv-dbsvlm0ae00c7397us50','winter-waterfall-73466147','RENDER_GIT_COMMIT','exact','docs/GITHUB_MERGE_PREFLIGHT.md'])
    assert(runbook.includes(fact),fact);
});
