import { asSeenBy, assignedTo, items, json, passages, readLabels, session } from "./_lib.js";

// GET /api/data                 -> chỉ mục gọn {id,q,b} của mọi câu giao cho người đăng nhập
// GET /api/data?queue=Q&b=N     -> chi tiết các câu của một đợt + đoạn tài liệu chúng cần
// Hàng dd3 (diễn đạt lại gold vòng 3): ẩn câu có câu gốc đã bị chấm Loại.
const ORDER = ["kiemtra", "gold3", "silver_mau", "silver", "dd1", "dd3"];

async function rejectedSources() {
  const all = await Promise.all([readLabels("r1"), readLabels("r2"), readLabels("r4")]);
  const rej = new Set();
  for (const L of all) for (const [id, l] of Object.entries(L)) if (l.v === "0") rej.add(id);
  return rej;
}

export default async function handler(req, res) {
  const role = session(req);
  if (!role) return json(res, 401, { error: "Chưa đăng nhập." });
  try {
    const u = new URL(req.url, "http://x");
    const queue = u.searchParams.get("queue"), b = +u.searchParams.get("b");
    const rej = await rejectedSources();
    const visible = (it) => !(it.q === "dd3" && it.goc && rej.has(it.goc.id));
    const mine = items().filter((it) => assignedTo(it, role) && (role === "r3" || visible(it))).map((it) => asSeenBy(it, role));
    if (!queue) {
      const other = role === "r1" ? "r2" : role === "r2" ? "r1" : null;
      const otherTotal = {};
      if (other) for (const it of items()) if (assignedTo(it, other) && visible(it)) otherTotal[it.q] = (otherTotal[it.q] || 0) + 1;
      const qs = ORDER.filter((q) => mine.some((it) => it.q === q));
      return json(res, 200, { role, queues: qs, index: mine.map((it) => [it.id, it.q, it.b]), otherTotal,
                              hiddenDd3: items().filter((it) => assignedTo(it, role) && !visible(it)).length });
    }
    const sel = mine.filter((it) => it.q === queue && it.b === b);
    const P = passages(), pas = {};
    for (const it of sel) for (const p of it.ctx) pas[p] = P[p];
    return json(res, 200, { items: sel, passages: pas });
  } catch (e) {
    console.error("data", e?.message);
    return json(res, 500, { error: "Không tải được dữ liệu: " + (e?.message || e) });
  }
}
