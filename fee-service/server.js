const express = require('express');
const { charge, BANK_URL, NAIVE } = require('./bankClient');

const PORT = Number(process.env.PORT || 4001);

const students = new Map([
  ['1', { id: '1', debt: 50_000_000 }],
  ['2', { id: '2', debt: 0 }],
  ['3', { id: '3', debt: 3_200_000 }],
]);
const payments = new Map();
let seq = 0;

const errorBody = (p) => ({ error: p.error, paymentId: p.id, status: p.status });
const rejected = (error) => ({ error, paymentId: null, status: 'FAILED' });

function fail(p, status, error) {
  p.status = status;
  p.error = error;
}

async function pay(student, amount) {
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    return { httpStatus: 400, body: rejected('Số tiền không hợp lệ') };
  }
  if (amount > student.debt) {
    return { httpStatus: 400, body: rejected('Số tiền vượt quá công nợ') };
  }

  const p = { id: `P${++seq}`, studentId: student.id, amount, status: 'PROCESSING' };
  payments.set(p.id, p);
  const r = await charge(p.id, amount);

  switch (r.outcome) {
    case 'PAID':
      p.status = 'PAID';
      p.chargeId = r.charge && r.charge.chargeId;
      student.debt -= amount;
      return { httpStatus: 201, body: { paymentId: p.id, studentId: p.studentId, amount, status: p.status, chargeId: p.chargeId } };
    case 'DECLINED':
      fail(p, 'FAILED', (r.body && (r.body.message || r.body.error)) || 'Ngân hàng từ chối');
      return { httpStatus: r.httpStatus, body: errorBody(p) };
    case 'UNAVAILABLE':
      fail(p, 'FAILED', 'Không kết nối được tới ngân hàng');
      return { httpStatus: 503, body: errorBody(p) };
    default:
      if (NAIVE) {
        fail(p, 'FAILED', r.error);
        return { httpStatus: 500, body: errorBody(p) };
      }
      fail(p, 'PENDING', 'Không rõ ngân hàng đã trừ tiền hay chưa');
      return { httpStatus: 504, body: errorBody(p) };
  }
}

const app = express();
app.use(express.json());

app.param('id', (req, res, next, id) => {
  req.student = students.get(id);
  if (!req.student) {
    const error = 'Không tìm thấy sinh viên';
    return res.status(404).json(req.method === 'POST' ? rejected(error) : { error });
  }
  next();
});

app.get('/students/:id/fees', (req, res) => {
  res.json({ studentId: req.student.id, debt: req.student.debt });
});

app.post('/students/:id/payments', async (req, res) => {
  const { httpStatus, body } = await pay(req.student, req.body && req.body.amount);
  res.status(httpStatus).json(body);
});

app.listen(PORT, () => {
  console.log(`[fee] listening :${PORT} BANK_URL=${BANK_URL} mode=${NAIVE ? 'naive' : 'fixed'}`);
});
