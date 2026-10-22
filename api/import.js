import { body, importLabels, isAdmin, items, json, assignedTo } from "./_lib.js";

// POST /api/import  (header x-admin-token)  {role:"r1", labels:{id:{v,n,t}}}
// Nạp lại nhãn đã có (dùng khi chuyển kho). Chỉ nhận câu giao cho vai đó.
export default async function handler(req, res) {
  if (!isAdmin(req)) return json(res, 401, { error: "Sai khoá admin." });
  if (req.method !== "POST") return json(res, 405, { error: "method" });
  const { role, labels } = await body(req);
  if (!["r1", "r2"].includes(role) || !labels || typeof labels !== "object") return json(res, 400, { error: "Thiếu role/labels." });
  const ok = new Set(items().filter((it) => assignedTo(it, role)).map((it) => it.id));
  const clean = Object.fromEntries(Object.entries(labels).filter(([id, l]) => ok.has(id) && l && ["1", "0", "?"].includes(l.v)));
  try {
    const n = await importLabels(role, clean);
    return json(res, 200, { imported: n, skipped: Object.keys(labels).length - n });
  } catch (e) {
    console.error("import", e?.message);
    return json(res, 500, { error: e?.message || String(e) });
  }
}
