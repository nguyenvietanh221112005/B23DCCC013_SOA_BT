# Lab 3 — Kết nối và duy trì kết nối giữa các service

Fee Service (cổng 4001) gọi Ngân hàng giả lập (cổng 4002). Node.js + Express, dữ liệu trong bộ nhớ.

## 1. Cấu trúc

```
bank-service/server.js       Ngân hàng giả lập: POST /charges, GET /stats
fee-service/server.js        Fee Service: GET /students/:id/fees, POST /students/:id/payments
fee-service/bankClient.js    Gọi ngân hàng: keep-alive, timeout, thử lại, Idempotency-Key
scripts/helpers.js           Hàm dùng chung cho script đo (gọi HTTP, bật/tắt service)
scripts/run-scenarios.js     Đo 4 tình huống, ghi results/before.json và results/after.json
results/                     before.json (trước khi sửa), after.json (sau khi sửa)
postman/                     Lab3.postman_collection.json
```

## 2. Cách chạy

```bash
npm install
npm run start:bank
npm run start:fee
npm run measure
```

- Ngân hàng: `DELAY_MS`, `FAIL_RATE`, `DROP_RATE` (khởi động lại để áp dụng).
- Fee Service: `BANK_URL` (mặc định `http://localhost:4002`); `FEE_MODE=naive` là bản trước khi sửa, dùng để lấy số liệu "trước".
- `npm run measure` tự bật/tắt service, chạy 4 tình huống, ghi `results/before.json` và `results/after.json`.
- Thử tay bằng Postman: import `postman/Lab3.postman_collection.json`.

## 3. Cách xử lý

| Vấn đề | Cách làm |
|---|---|
| Ngân hàng tắt (TH1) | Connect timeout 300 ms; lỗi chưa kết nối được → 503 FAILED. Mỗi lệnh tự mở kết nối mới nên ngân hàng lên lại là chạy, không cần khởi động lại Fee Service. |
| Ngân hàng chậm (TH2) | Thời hạn tổng 4 s cho mỗi lệnh (kể cả chờ và thử lại); hết hạn → 504 PENDING. Gọi ngân hàng bất đồng bộ nên `GET /fees` không bị chặn. |
| Duy trì kết nối (TH3) | `http.Agent({ keepAlive: true, maxSockets: 10, timeout: 4000 })`: dùng lại kết nối TCP, đóng kết nối nhàn rỗi sau 4 s (trước khi ngân hàng đóng ở 5 s). |
| Đứt / lỗi tạm thời (TH4a, b) | Thử lại tối đa 5 lần với backoff, luôn gửi `Idempotency-Key = paymentId` nên ngân hàng không trừ hai lần. Đứt kết nối hoặc hết giờ mà chưa rõ kết quả → 504 PENDING; lỗi 500 cả 5 lần (chắc chắn chưa trừ) → 503 FAILED. |
| Bị từ chối (TH4c) | 4xx không thử lại, giữ nguyên mã của ngân hàng (402 FAILED). |

Công nợ chỉ giảm khi ngân hàng trả 201.

## 4. Kết quả đo

### Tình huống 1 — Ngân hàng không kết nối được, rồi chạy lại

| Chỉ số | Trước | Sau | Yêu cầu |
|---|---|---|---|
| Thanh toán khi ngân hàng tắt | 500, `error` rỗng | 503 FAILED, có `error` | 503 + JSON ✅ |
| Thời gian | 55 ms | 83 ms | < 1,5 s ✅ |
| `GET /students/1/fees` | 200, 2 ms | 200, 1 ms | 200 nhanh ✅ |
| Ngân hàng chạy lại (không restart Fee) | 201 | 201 | 201 ✅ |
| `BANK_URL=http://localhost:4999` | 500, 43 ms | 503, 119 ms | giống khi tắt ✅ |

### Tình huống 2 — `DELAY_MS=5000`

| Chỉ số | Trước | Sau | Yêu cầu |
|---|---|---|---|
| Một thanh toán | 201 sau 5062 ms | 504 PENDING sau 4054 ms | 504 PENDING, ≤ 4,5 s ✅ |
| 20 thanh toán cùng lúc — lâu nhất | 5031 ms | 4028 ms | ≤ 4,5 s ✅ |
| `GET /fees` trong lúc chờ | 1–7 ms | 1–5 ms | < 300 ms ✅ |

### Tình huống 3 — 200 thanh toán × 1.000đ, 10 song song

| Chỉ số | Trước | Sau | Yêu cầu |
|---|---|---|---|
| Thành công | 200/200 | 200/200 | 200/200 ✅ |
| Tổng thời gian | 248 ms | 153 ms | — |
| `connections` | 201 | 11 (10 của Fee + 1 của script đọc /stats) | ≤ 20 ✅ |
| Nhàn rỗi 6 s rồi gửi 5 lệnh | 5/5 | 5/5 | thành công ✅ |

### Tình huống 4 — 60 thanh toán × 100.000đ, gửi lần lượt

| Chỉ số | Trước | Sau | Yêu cầu |
|---|---|---|---|
| (a) `DROP_RATE=0.3`: thành công | 39/60 | 60/60 | ≥ 54/60 ✅ |
| (a) lệnh lỗi trả về | 21 × 500 FAILED | không có | 504 PENDING ✅ |
| (a) `charges` / lệnh PAID | 60 / 39 (21 lệnh đã bị trừ tiền nhưng báo thất bại) | 60 / 60 | khớp ✅ |
| (a) `duplicates` | 0 | 0 | 0 ✅ |
| (a) Công nợ giảm = tiền lệnh PAID | 3.900.000 ✅ | 6.000.000 ✅ | ✅ |
| (b) `FAIL_RATE=0.3`: thành công | 42/60 | 59/60 (1 lệnh lỗi 500 cả 5 lần → 503) | ≥ 54/60 ✅ |
| (b) `requests` / `charges` / `duplicates` | 60 / 42 / 0 | 85 / 59 / 0 | không trừ 2 lần ✅ |
| (c) 25.000.000đ | 402, ngân hàng nhận 1 yêu cầu | 402, ngân hàng nhận 1 yêu cầu | 402, đúng 1 ✅ |
| Thời gian lâu nhất | 43 ms | 1565 ms | ≤ 4,5 s ✅ |

## 5. Nhận xét

- Chưa kết nối được thì chắc chắn chưa trừ tiền → 503. Đã gửi mà mất phản hồi thì chưa biết → 504 PENDING.
- Phải có timeout, nếu không thì người dùng phải chờ theo tốc độ của ngân hàng.
- Keep-alive giảm số kết nối TCP từ 201 xuống 10.
- Chỉ thử lại an toàn khi có Idempotency-Key; không thử lại lỗi 4xx.
