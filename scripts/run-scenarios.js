const path = require('path');
const fs = require('fs');
const {
  ROOT, sleep, pay, getFees, bankStats, startBank, startFee, stop, stopAll, pool, countBy, maxMs,
} = require('./helpers');

async function scenario1(mode) {
  const out = {};

  let fee = await startFee(mode);
  const r1 = await pay(1, 100000);
  const f1 = await getFees(1);
  out.bankDown = {
    payStatus: r1.status, payMs: r1.ms, payBody: r1.body,
    feesStatus: f1.status, feesMs: f1.ms, feeAlive: fee.exitCode === null,
  };

  const bank = await startBank();
  const r2 = await pay(1, 100000);
  out.bankBackUp = { payStatus: r2.status, payMs: r2.ms, payBody: r2.body };
  await stop(fee);
  await stop(bank);

  fee = await startFee(mode, { BANK_URL: 'http://localhost:4999' });
  const r3 = await pay(1, 100000);
  const f3 = await getFees(1);
  out.bankUrl4999 = { payStatus: r3.status, payMs: r3.ms, payBody: r3.body, feesStatus: f3.status, feesMs: f3.ms };

  await stopAll();
  return out;
}

async function scenario2(mode) {
  const out = {};
  await startBank({ DELAY_MS: '5000' });
  await startFee(mode);

  const r = await pay(1, 100000);
  out.single = { status: r.status, ms: r.ms, body: r.body };

  const t0 = performance.now();
  const burst = Promise.all(Array.from({ length: 20 }, () => pay(1, 100000)));
  await sleep(300);
  const fees = [];
  for (let i = 0; i < 5; i++) {
    fees.push((await getFees(1)).ms);
    await sleep(200);
  }
  const res = await burst;
  out.burst20 = {
    statuses: countBy(res),
    maxMs: maxMs(res),
    totalMs: Math.round(performance.now() - t0),
    feesDuringBurstMs: fees,
    feesMaxMs: Math.max(...fees),
  };

  await stopAll();
  return out;
}

async function scenario3(mode) {
  const out = {};
  await startBank();
  await startFee(mode);

  const t0 = performance.now();
  const res = await pool(200, 10, () => pay(1, 1000));
  out.run200 = {
    statuses: countBy(res),
    totalMs: Math.round(performance.now() - t0),
    bankStats: await bankStats(),
  };

  await sleep(6000);
  const after = [];
  for (let i = 0; i < 5; i++) after.push(await pay(1, 1000));
  out.afterIdle6s = { statuses: countBy(after), bankStats: await bankStats() };

  await stopAll();
  return out;
}

async function sequential60(mode, bankEnv) {
  const AMOUNT = 100000;
  await startBank(bankEnv);
  await startFee(mode);

  const debtBefore = (await getFees(1)).body.debt;
  const res = [];
  for (let i = 0; i < 60; i++) res.push(await pay(1, AMOUNT));

  const paid = res.filter((x) => x.status === 201).length;
  const debtDecrease = debtBefore - (await getFees(1)).body.debt;
  const out = {
    statuses: countBy(res),
    paid,
    nonSuccessBodies: [...new Set(res.filter((x) => x.status !== 201).map((x) => `${x.status} ${x.body && x.body.status}`))],
    maxMs: maxMs(res),
    bankStats: await bankStats(),
    debtDecrease,
    debtMatchesPaid: debtDecrease === paid * AMOUNT,
  };

  await stopAll();
  return out;
}

async function scenario4(mode) {
  const out = {
    a_drop: await sequential60(mode, { DROP_RATE: '0.3' }),
    b_fail: await sequential60(mode, { FAIL_RATE: '0.3' }),
  };

  await startBank();
  await startFee(mode);
  const r = await pay(1, 25_000_000);
  out.c_declined = { status: r.status, ms: r.ms, body: r.body, bankStats: await bankStats() };
  await stopAll();
  return out;
}

const SCENARIOS = { 1: scenario1, 2: scenario2, 3: scenario3, 4: scenario4 };
const FILES = { naive: 'before.json', fixed: 'after.json' };

async function runMode(mode, which) {
  const outFile = path.join(ROOT, 'results', FILES[mode]);
  const data = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {};
  for (const s of which) {
    console.log(`\n=== [${mode}] Tình huống ${s} ===`);
    data[`scenario${s}`] = await SCENARIOS[s](mode);
    console.log(JSON.stringify(data[`scenario${s}`], null, 2));
    fs.writeFileSync(outFile, JSON.stringify(data, null, 2));
  }
  return outFile;
}

(async () => {
  const modeArg = process.argv[2] || 'both';
  const which = process.argv.slice(3).length ? process.argv.slice(3) : Object.keys(SCENARIOS);
  const modes = modeArg === 'both' ? ['naive', 'fixed'] : [modeArg];
  fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });

  const written = [];
  try {
    for (const mode of modes) written.push(await runMode(mode, which));
  } finally {
    await stopAll();
  }
  console.log(`\nĐã ghi ${written.join(', ')}`);
})().catch(async (e) => { console.error(e); await stopAll(); process.exit(1); });
