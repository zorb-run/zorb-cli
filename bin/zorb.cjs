#!/usr/bin/env node
'use strict';

// Tiny dispatcher: pick the right compiled binary out of ../dist/<platform>/
// and exec it with the user's args. The four supported binaries ship inside
// this package; this shim is here so npm has a cross-platform `bin` entry.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SUPPORTED = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);

const host = `${process.platform}-${process.arch}`;
if (!SUPPORTED.has(host)) {
  process.stderr.write(`zorb: unsupported platform '${host}'. Supported: ${[...SUPPORTED].join(', ')}.\n`);
  process.exit(1);
}

const binPath = path.join(__dirname, '..', 'dist', host, 'zorb');
if (!fs.existsSync(binPath)) {
  process.stderr.write(`zorb: missing binary for '${host}' (expected ${binPath}). Reinstall zorb.\n`);
  process.exit(1);
}

const child = spawn(binPath, process.argv.slice(2), { stdio: 'inherit' });

// Forward common termination signals so the child shuts down with us. The
// platform binary installs its own SIGINT/SIGTERM handlers; we just relay.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
  });
}

child.on('error', (err) => {
  process.stderr.write(`zorb: failed to spawn ${binPath}: ${err.message}\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
