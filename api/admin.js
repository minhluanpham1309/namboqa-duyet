import { body, isAdmin, json, redisCmd } from "./_lib.js";

// POST /api/admin  (header x-admin-token)
//   {action:"archive", role:"r1"}  -> đổi tên nb:labels:<role> thành nb:labels:<role>__luu_<thời điểm>
//                                     (giữ nguyên dữ liệu, người đó bắt đầu lại từ trang trống)
//   {action:"list"}                -> các khoá nhãn đang có và số nhãn trong mỗi khoá
export default async function handler(req, res) {
  if (!isAdmin(req)) return json(res, 401, { error: "Sai khoá admin." });
  if (req.method !== "POST") return json(res, 405, { error: "method" });
  const { action, role } = await body(req);
  try {
    if (action === "list") {
      const [keys] = await redisCmd([["KEYS", "nb:labels:*"]]);
      const lens = keys.length ? await redisCmd(keys.map((k) => ["HLEN", k])) : [];
      return json(res, 200, Object.fromEntries(keys.map((k, i) => [k, lens[i]])));
    }
    if (action === "archive" && ["r1", "r2", "r3"].includes(role)) {
      const to = `nb:labels:${role}__luu_${new Date().toISOString().replace(/[:.]/g, "-")}`;
      const [ok] = await redisCmd([["RENAME", `nb:labels:${role}`, to]]);
      return json(res, 200, { ok, archived_to: to });
    }
    return json(res, 400, { error: "action không hợp lệ" });
  } catch (e) {
    return json(res, 500, { error: e?.message || String(e) });
  }
}
