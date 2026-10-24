import { assignedTo, body, items, json, mergeLabels, readLabels, session } from "./_lib.js";

// GET  -> {mine: {id:{v,n,t}}, otherDone: {queue: số câu người kia đã duyệt}}
//         Không bao giờ trả nhãn của người kia: hai người duyệt độc lập.
// POST {changes: {id: {v,n} | null}} -> lưu, gom theo hàng × đợt
export default async function handler(req, res) {
  const role = session(req);
  if (!role) return json(res, 401, { error: "Chưa đăng nhập." });
  try {
    if (req.method === "GET") {
      if (role === "r3" || role === "r4" || role === "r5") return json(res, 200, { mine: await readLabels(role), otherDone: {} });
      const other = role === "r1" ? "r2" : "r1";
      const [mine, theirs] = await Promise.all([readLabels(role), readLabels(other)]);
      const otherDone = {};
      const qOf = new Map();
      for (const it of items()) if (assignedTo(it, other)) qOf.set(it.id, it.q);
      for (const id of Object.keys(theirs)) { const q = qOf.get(id); if (q) otherDone[q] = (otherDone[q] || 0) + 1; }
      return json(res, 200, { mine, otherDone });
    }
    if (req.method !== "POST") return json(res, 405, { error: "method" });
    const { changes } = await body(req);
    if (!changes || typeof changes !== "object") return json(res, 400, { error: "Thiếu changes." });
    const index = new Map(items().filter((it) => assignedTo(it, role)).map((it) => [it.id, it]));
    const delta = {};
    for (const [id, l] of Object.entries(changes)) {
      if (!index.has(id)) continue;                         // không phải câu của mình: bỏ qua
      if (l && !["1", "0", "?"].includes(l.v)) continue;
      delta[id] = l && l.v ? { v: l.v, n: l.n || "" } : null;
    }
    const saved = await mergeLabels(role, null, null, delta);
    return json(res, 200, { saved });
  } catch (e) {
    console.error("labels", req.method, role, e?.name, e?.message);
    return json(res, 500, { error: "Lưu thất bại: " + (e?.message || e) });
  }
}
