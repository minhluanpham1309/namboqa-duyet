import { body, isAdmin, json, redisCmd } from "./_lib.js";

// POST /api/admin  (header x-admin-token)
//   {action:"archive", role:"r1"}  -> đổi tên nb:labels:<role> thành nb:labels:<role>__luu_<thời điểm>
//                                     (giữ nguyên dữ liệu, người đó bắt đầu lại từ trang trống)
//   {action:"move_since", role, since:"ISO"} -> tách nhãn có t >= since sang nb:labels:<role>__tach_<thời điểm>
//   {action:"list"}                -> các khoá nhãn đang có và số nhãn trong mỗi khoá
export default async function handler(req, res) {
  if (!isAdmin(req)) return json(res, 401, { error: "Sai khoá admin." });
  if (req.method !== "POST") return json(res, 405, { error: "method" });
  const { action, role, since } = await body(req);
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
    if (action === "move_since" && ["r1", "r2", "r3"].includes(role) && /^\d{4}-\d\d-\d\dT/.test(since || "")) {
      // Tách các nhãn có t >= since sang khoá riêng (không xoá dữ liệu); người đó chấm lại các câu này.
      const src = `nb:labels:${role}`;
      const [flat] = await redisCmd([["HGETALL", src]]);
      const move = [];
      for (let i = 0; flat && i < flat.length; i += 2) {
        let l; try { l = JSON.parse(flat[i + 1]); } catch { continue; }
        if (l && l.t && l.t >= since) move.push(flat[i], flat[i + 1]);
      }
      if (!move.length) return json(res, 200, { moved: 0 });
      const to = `nb:labels:${role}__tach_${new Date().toISOString().replace(/[:.]/g, "-")}`;
      const ids = move.filter((_, i) => i % 2 === 0);
      await redisCmd([["HSET", to, ...move]]);
      await redisCmd([["HDEL", src, ...ids]]);
      return json(res, 200, { moved: ids.length, archived_to: to, ids });
    }
    return json(res, 400, { error: "action không hợp lệ" });
  } catch (e) {
    return json(res, 500, { error: e?.message || String(e) });
  }
}
