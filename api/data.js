import { assignedTo, items, json, passages, session } from "./_lib.js";

// GET -> các cặp giao cho người đang đăng nhập + đúng các đoạn tài liệu chúng cần.
// Dữ liệu nằm trong repo private, chỉ trả về sau khi đăng nhập.
export default function handler(req, res) {
  const role = session(req);
  if (!role) return json(res, 401, { error: "Chưa đăng nhập." });
  const mine = items().filter((it) => assignedTo(it, role));
  const need = new Set();
  for (const it of mine) for (const p of it.ctx) need.add(p);
  const P = passages(), pas = {};
  for (const p of need) pas[p] = P[p];
  // đếm số câu giao cho người kia theo hàng, để trang hiện tiến độ của họ
  const other = role === "r1" ? "r2" : "r1";
  const otherTotal = {};
  for (const it of items()) if (assignedTo(it, other)) otherTotal[it.q] = (otherTotal[it.q] || 0) + 1;
  return json(res, 200, { role, items: mine, passages: pas, otherTotal });
}
