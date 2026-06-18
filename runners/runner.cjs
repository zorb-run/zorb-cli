#!/usr/bin/env node
'use strict';

// zorb action runner — Node.js / Bun.
//
// Usage:
//   runner.cjs <action-file> <input-file> <result-file>
//
// Protocol:
//   input-file (in):  {"inputs": {...}, "context": {"cwd": "...", "taskName": "..."}}
//   result-file (out): {"outputs": {...}, "secrets": [{"name","value"}, ...], "env": [...]}
//
// The action module is loaded via dynamic import (supports .js/.cjs/.mjs/.ts under Bun)
// with a CommonJS require() fallback for legacy .cjs/.js shapes that don't expose
// a CJS-friendly module record through dynamic import.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const [, , actionFile, inputFile, resultFile] = process.argv;
  if (!actionFile || !inputFile || !resultFile) {
    process.stderr.write('runner.cjs: expected <action-file> <input-file> <result-file>\n');
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

  let actionFn;
  try {
    actionFn = await loadAction(actionFile);
  } catch (err) {
    process.stderr.write('failed to load action:\n');
    process.stderr.write(formatErr(err) + '\n');
    process.exit(1);
  }

  let result;
  try {
    result = await actionFn(inputs, context);
  } catch (err) {
    process.stderr.write(`action ${path.basename(actionFile)} threw:\n`);
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
