#!/usr/bin/env bun
// Validate examples/*.yml against zorb.schema.json.
//
// The schema is consumed by editors (via the yaml-language-server header), not
// by zorb itself — the runtime validator in src/config.ts is the source of
// truth. This script catches drift the other way: if the schema falls behind
// what the parser accepts, IDEs start flagging valid workflows as errors.
//
// Run: bun run validate:schema
//
// Exits non-zero if any example fails the schema, or if the synthetic
// positive/negative cases below disagree with the expected verdict.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import YAML from 'yaml';

const repoRoot = resolve(import.meta.dir, '..');
const schemaPath = join(repoRoot, 'zorb.schema.json');
const examplesDir = join(repoRoot, 'examples');

const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validate = ajv.compile(schema);

let pass = 0;
let fail = 0;

function check(label: string, value: unknown, expected: boolean): void {
  const valid = validate(value);
  const ok = valid === expected;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`);
  if (!ok) {
    if (expected && !valid) {
      for (const err of validate.errors ?? []) {
        console.log(`     ${err.instancePath || '<root>'} ${err.message} ${JSON.stringify(err.params)}`);
      }
    } else {
      console.log(`     expected schema to reject this input`);
    }
    fail += 1;
  } else {
    pass += 1;
  }
}

// 1. Every shipped example should pass.
for (const file of readdirSync(examplesDir).filter((f) => f.endsWith('.yml'))) {
  const doc = YAML.parse(readFileSync(join(examplesDir, file), 'utf8'));
  check(`examples/${file}`, doc, true);
}

// 2. Synthetic positive: exercises secrets[], defaults.action.*, and step bin:.
check(
  'synthetic: secrets + defaults.action + bin',
  {
    version: 1,
    defaults: {
      run: { shell: '/bin/bash' },
      action: { js: { bin: 'bun {0}' }, py: { bin: 'python3 {0}' } },
    },
    secrets: [{ uses: '@zorb/secrets/load-1password', with: { vault: 'Production' } }],
    tasks: {
      deploy: {
        defaults: { action: { js: { bin: 'node {0}' } } },
        steps: [
          { uses: './scripts/version.action.ts', with: { path: 'package.json' }, bin: 'tsx {0}' },
          { run: 'echo done' },
        ],
      },
    },
  },
  true,
);

// 3. Synthetic negatives: parser rejects these, schema should too.
check(
  'reject: run: inside secrets[]',
  {
    secrets: [{ uses: 'x', run: 'echo no' }],
    tasks: { t: { steps: [{ run: 'echo ok' }] } },
  },
  false,
);

check(
  'reject: docker: inside secrets[]',
  {
    secrets: [{ uses: 'x', docker: 'alpine' }],
    tasks: { t: { steps: [{ run: 'echo ok' }] } },
  },
  false,
);

check(
  'reject: bin: without uses:',
  {
    tasks: { t: { steps: [{ run: 'echo ok', bin: 'node {0}' }] } },
  },
  false,
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
