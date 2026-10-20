const http = require('http');

const BANK_URL = process.env.BANK_URL || 'http://localhost:4002';
const NAIVE = process.env.FEE_MODE === 'naive';
const DEADLINE_MS = 4000;
const CONNECT_TIMEOUT_MS = 300;
const MAX_ATTEMPTS = 5;
const CONNECT_ERRORS = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'CONNECT_TIMEOUT']);

const agent = new http.Agent({ keepAlive: true, maxSockets: 10, timeout: 4000 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codedError = (message, code) => Object.assign(new Error(message), { code });
const isClientError = (status) => status >= 400 && status < 500;
const backoffMs = (attempt) => Math.min(400, 50 * 2 ** (attempt - 1)) * (0.5 + Math.random());

function postJson(path, payload, { headers = {}, timeoutMs = null, agent: useAgent = false, connectTimeout = true } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(new URL(path, BANK_URL), {
      method: 'POST',
      agent: useAgent,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    });

    let done = false;
    let timer = null;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(value);
    };

    if (timeoutMs != null) {
      timer = setTimeout(() => req.destroy(codedError('Hết thời gian chờ ngân hàng', 'TIMEOUT')), Math.max(1, timeoutMs));
    }

    if (connectTimeout) {
      req.on('socket', (socket) => {
        if (!socket.connecting) return;
        const ct = setTimeout(
          () => req.destroy(codedError('Không kết nối được tới ngân hàng', 'CONNECT_TIMEOUT')),
          CONNECT_TIMEOUT_MS,
        );
        socket.once('connect', () => clearTimeout(ct));
        socket.once('close', () => clearTimeout(ct));
      });
    }

    req.on('response', (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let body = null;
        try { body = buf ? JSON.parse(buf) : null; } catch { body = { raw: buf }; }
        finish(resolve, { status: res.statusCode, body });
      });
      res.on('error', (e) => finish(reject, e));
      res.on('aborted', () => finish(reject, codedError('Đứt kết nối khi đang nhận', 'ECONNRESET')));
    });
    req.on('error', (e) => finish(reject, e));
    req.end(data);
  });
}

async function naiveCharge(reference, amount) {
  try {
    const r = await postJson('/charges', { reference, amount }, { connectTimeout: false });
    if (r.status === 201) return { outcome: 'PAID', charge: r.body };
    if (isClientError(r.status)) return { outcome: 'DECLINED', httpStatus: r.status, body: r.body };
    return { outcome: 'UNKNOWN', error: `HTTP ${r.status}` };
  } catch (e) {
    return { outcome: 'UNKNOWN', error: e.message };
  }
}

async function resilientCharge(reference, amount) {
  const options = { headers: { 'Idempotency-Key': reference }, agent };
  const start = Date.now();
  const remaining = () => DEADLINE_MS - (Date.now() - start);
  let uncertain = false;
  let lastError = '';
  let connectFailures = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (remaining() <= 50) break;
    try {
      const r = await postJson('/charges', { reference, amount }, { ...options, timeoutMs: remaining() });
      if (r.status === 201) return { outcome: 'PAID', charge: r.body };
      if (isClientError(r.status)) return { outcome: 'DECLINED', httpStatus: r.status, body: r.body };
      lastError = `Ngân hàng trả HTTP ${r.status}`;
    } catch (e) {
      lastError = e.message || e.code;
      if (e.code === 'TIMEOUT') { uncertain = true; break; }
      if (!CONNECT_ERRORS.has(e.code)) uncertain = true;
      else if (++connectFailures >= 2) break;
    }
    const wait = backoffMs(attempt);
    if (remaining() <= wait + 50) break;
    await sleep(wait);
  }
  return { outcome: uncertain ? 'UNKNOWN' : 'UNAVAILABLE', error: lastError };
}

const charge = (reference, amount) =>
  NAIVE ? naiveCharge(reference, amount) : resilientCharge(reference, amount);

module.exports = { charge, BANK_URL, NAIVE };
