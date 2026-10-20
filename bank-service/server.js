const express = require('express');

const PORT = Number(process.env.PORT || 4002);
const DELAY_MS = Number(process.env.DELAY_MS || 0);
const FAIL_RATE = Number(process.env.FAIL_RATE || 0);
const DROP_RATE = Number(process.env.DROP_RATE || 0);
const LIMIT = 20_000_000;

const stats = { connections: 0, requests: 0, charges: 0, duplicates: 0 };
const idempotency = new Map();
const chargedRefs = new Map();
let seq = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function processCharge(reference, amount) {
  if (DELAY_MS > 0) await sleep(DELAY_MS);

  const valid = typeof reference === 'string' && reference.length > 0 &&
    typeof amount === 'number' && Number.isInteger(amount) && amount > 0;
  if (!valid) {
    return { status: 400, body: { error: 'INVALID_AMOUNT', message: 'Số tiền hoặc reference không hợp lệ' } };
  }
  if (amount > LIMIT) {
    return { status: 402, body: { error: 'LIMIT_EXCEEDED', message: `Vượt hạn mức ${LIMIT}đ` } };
  }
  if (Math.random() < FAIL_RATE) {
    return { status: 500, body: { error: 'INTERNAL_ERROR', message: 'Lỗi tạm thời' }, retryable: true };
  }

  const n = (chargedRefs.get(reference) || 0) + 1;
  chargedRefs.set(reference, n);
  if (n > 1) stats.duplicates++;
  stats.charges++;
  return { status: 201, body: { chargeId: `CH${++seq}`, reference, amount, status: 'SUCCEEDED' }, fresh: true };
}

async function chargeOnce(key, reference, amount) {
  if (key && idempotency.has(key)) {
    return { ...(await idempotency.get(key)), fresh: false };
  }
  const p = processCharge(reference, amount);
  if (key) idempotency.set(key, p);
  const result = await p;
  if (key && result.retryable) idempotency.delete(key);
  return result;
}

const app = express();
app.use(express.json());

app.get('/stats', (req, res) => res.json(stats));

app.post('/charges', async (req, res) => {
  stats.requests++;
  const { reference, amount } = req.body || {};
  const result = await chargeOnce(req.get('Idempotency-Key'), reference, amount);

  if (result.fresh && Math.random() < DROP_RATE) {
    req.socket.destroy();
    return;
  }
  res.status(result.status).json(result.body);
});

const server = app.listen(PORT, () => {
  console.log(`[bank] listening :${PORT} DELAY_MS=${DELAY_MS} FAIL_RATE=${FAIL_RATE} DROP_RATE=${DROP_RATE}`);
});

server.on('connection', (socket) => {
  stats.connections++;
  console.log(`[bank] kết nối TCP mới #${stats.connections} từ ${socket.remotePort}`);
});
