const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FEE = 'http://localhost:4001';
const BANK = 'http://localhost:4002';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clientAgent = new http.Agent({ keepAlive: true, maxSockets: 50, timeout: 4000 });

function request(method, url, body) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const elapsed = () => Math.round(performance.now() - t0);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(url, {
      method, agent: clientAgent,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch { json = buf; }
        resolve({ status: res.statusCode, body: json, ms: elapsed() });
      });
    });
    req.on('error', (e) => resolve({ status: 0, body: { error: e.message }, ms: elapsed() }));
    req.end(data || undefined);
  });
}

const pay = (id, amount) => request('POST', `${FEE}/students/${id}/payments`, { amount });
const getFees = (id) => request('GET', `${FEE}/students/${id}/fees`);
const bankStats = async () => (await request('GET', `${BANK}/stats`)).body;

const procs = [];

function start(name, script, env) {
  const child = spawn(process.execPath, [path.join(ROOT, script)], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.logs = '';
  child.stdout.on('data', (d) => (child.logs += d));
  child.stderr.on('data', (d) => (child.logs += d));
  procs.push(child);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${name} không khởi động: ${child.logs}`)), 10000);
    const check = () => {
      if (child.logs.includes('listening')) { clearTimeout(t); resolve(child); } else setTimeout(check, 50);
    };
    check();
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const done = new Promise((r) => child.once('exit', r));
  child.kill();
  await done;
  procs.splice(procs.indexOf(child), 1);
}

async function stopAll() {
  for (const c of [...procs]) await stop(c);
  clientAgent.destroy();
  await sleep(200);
}

const startBank = (env = {}) => start('bank', 'bank-service/server.js', env);
const startFee = (mode, env = {}) => start('fee', 'fee-service/server.js', { FEE_MODE: mode, ...env });

async function pool(n, concurrency, fn) {
  const results = new Array(n);
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < n) { const i = next++; results[i] = await fn(i); }
  }));
  return results;
}

const countBy = (arr) => arr.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
const maxMs = (arr) => Math.max(...arr.map((x) => x.ms));

module.exports = {
  ROOT, sleep, pay, getFees, bankStats, startBank, startFee, stop, stopAll, pool, countBy, maxMs,
};
