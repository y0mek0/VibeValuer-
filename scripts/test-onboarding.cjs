#!/usr/bin/env node
// Test runner: starts server, runs mvp-onboarding.cjs, kills server
const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');

const DIR = path.dirname(__dirname);

function killPort4310() {
  // Find PIDs listening on port 4310 and kill only those
  try {
    const output = execSync('netstat -ano | findstr :4310 | findstr LISTENING', { encoding: 'utf8' });
    const lines = output.trim().split('\n');
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && pid !== '0') {
        try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch {}
      }
    }
  } catch {}
  return new Promise(r => setTimeout(r, 1500));
}

function waitForHealth(port, maxMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + maxMs;
    function tryPing() {
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('health timeout'));
        else setTimeout(tryPing, 200);
      });
      req.setTimeout(500, () => { req.destroy(); if (Date.now() > deadline) reject(new Error('health timeout')); });
    }
    tryPing();
  });
}

async function main() {
  await killPort4310();

  console.log('Starting server...');
  const server = spawn('node', ['server.js'], {
    cwd: DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  });

  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d.toString(); });
  server.stderr.on('data', (d) => { serverLog += d.toString(); });

  try {
    await waitForHealth(4310, 10000);
    console.log('Server ready');

    // Run the onboarding test
    console.log('\nRunning mvp-onboarding.cjs...\n');
    const test = spawn('node', ['scripts/mvp-onboarding.cjs'], { cwd: DIR, stdio: 'inherit' });
    test.on('close', (code) => {
      console.log('\n--- Server log ---');
      process.stdout.write(serverLog.slice(-3000));
      console.log('\n--- End log ---');
      server.kill();
      process.exit(code);
    });
  } catch(e) {
    console.error('Server failed to start:', e.message);
    console.log('\n--- Server log ---');
    process.stdout.write(serverLog);
    console.log('\n--- End log ---');
    server.kill();
    process.exit(1);
  }
}

main();
