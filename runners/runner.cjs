#!/usr/bin/env node
'use strict';

// zorb action runner — Node.js / Bun.
//
// Usage:
//   runner.cjs <action-target> <input-file> <result-file>
//
// <action-target> is either:
//   - an absolute path to a local action file (.js/.cjs/.mjs/.ts), or
//   - an NPM specifier (e.g. "@zorb/aws/s3/sync") — in which case input-file
//     must carry a `package.anchor` field pointing at the directory whose
//     node_modules the spec should be resolved against. Node's own
//     createRequire then handles exports / conditions / wildcards.
//
// Protocol:
//   input-file (in):  {"inputs": {...}, "context": {...}, "package"?: {"anchor": "..."}}
//   result-file (out): {"outputs": {...}, "secrets": [{"name","value"}, ...], "env": [...]}

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

async function main() {
  const [, , actionTarget, inputFile, resultFile] = process.argv;
  if (!actionTarget || !inputFile || !resultFile) {
    process.stderr.write('runner.cjs: expected <action-target> <input-file> <result-file>\n');
    process.exit(2);
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  } catch (err) {
    process.stderr.write(`runner.cjs: failed to read input file ${inputFile}: ${err && err.message}\n`);
    process.exit(2);
  }

  const inputs = payload.inputs || {};
  const ctxInfo = payload.context || {};

  const secrets = [];
  const env = [];

  const log = {
    debug: (msg) => process.stderr.write(`[debug] ${stringify(msg)}\n`),
    info: (msg) => process.stderr.write(`${stringify(msg)}\n`),
    warn: (msg) => process.stderr.write(`[warn] ${stringify(msg)}\n`),
    error: (msg) => process.stderr.write(`[error] ${stringify(msg)}\n`),
  };

  const context = {
    cwd: ctxInfo.cwd,
    taskName: ctxInfo.taskName,
    stepId: ctxInfo.stepId,
    log,
    setSecret(name, value) {
      assertStringArg('setSecret', 'name', name, true);
      assertStringArg('setSecret', 'value', value, false);
      secrets.push({ name, value });
    },
    setEnv(name, value) {
      assertStringArg('setEnv', 'name', name, true);
      assertStringArg('setEnv', 'value', value, false);
      env.push({ name, value });
    },
  };

  const pkgInfo = payload.package;
  let actionFn;
  try {
    actionFn = pkgInfo && pkgInfo.anchor
      ? await loadPackageAction(actionTarget, pkgInfo.anchor)
      : await loadAction(actionTarget);
  } catch (err) {
    process.stderr.write('failed to load action:\n');
    process.stderr.write(formatErr(err) + '\n');
    process.exit(1);
  }

  const actionLabel = pkgInfo && pkgInfo.anchor ? actionTarget : path.basename(actionTarget);
  let result;
  try {
    result = await actionFn(inputs, context);
  } catch (err) {
    process.stderr.write(`action ${actionLabel} threw:\n`);
    process.stderr.write(formatErr(err) + '\n');
    process.exit(1);
  }

  const outputs = result && typeof result === 'object' && !Array.isArray(result) ? result : {};

  try {
    fs.writeFileSync(resultFile, JSON.stringify({ outputs, secrets, env }));
  } catch (err) {
    process.stderr.write(`runner.cjs: failed to write result file ${resultFile}: ${err && err.message}\n`);
    process.exit(2);
  }

  process.exit(0);
}

async function loadAction(file) {
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (importErr) {
    // .cjs / .js modules that use module.exports = fn may not present an
    // `action` named export via dynamic import on some runtimes — retry with require.
    if (file.endsWith('.cjs') || file.endsWith('.js')) {
      try {
        mod = require(file);
      } catch (_requireErr) {
        throw importErr;
      }
    } else {
      throw importErr;
    }
  }
  const fn = pickActionExport(mod);
  if (typeof fn !== 'function') {
    throw new Error(`action file must export an 'action' function: ${file}`);
  }
  return fn;
}

// Resolve an NPM spec via the user's project, then load the resulting file
// the same way as a local action. createRequire just needs a path to anchor
// — the file at that path doesn't need to exist.
async function loadPackageAction(spec, anchor) {
  const userRequire = createRequire(path.join(anchor, 'noop.js'));
  let resolvedPath;
  try {
    resolvedPath = userRequire.resolve(spec);
  } catch (err) {
    throw new Error(`failed to resolve '${spec}' from '${anchor}': ${err && err.message}`);
  }
  return loadAction(resolvedPath);
}

function pickActionExport(mod) {
  if (!mod) return undefined;
  if (typeof mod.action === 'function') return mod.action;
  // ESM default export wrapping a CJS module: { default: { action } }
  if (mod.default && typeof mod.default.action === 'function') return mod.default.action;
  // module.exports = function action(inputs, context) {}
  if (typeof mod === 'function') return mod;
  if (typeof mod.default === 'function') return mod.default;
  return undefined;
}

function assertStringArg(fn, argName, value, nonEmpty) {
  if (typeof value !== 'string') {
    throw new TypeError(`${fn}(${argName}): must be a string, got ${typeof value}`);
  }
  if (nonEmpty && value === '') {
    throw new TypeError(`${fn}(${argName}): must be a non-empty string`);
  }
}

function stringify(v) {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function formatErr(err) {
  if (err && typeof err === 'object' && 'stack' in err && err.stack) return String(err.stack);
  return String(err);
}

main();
