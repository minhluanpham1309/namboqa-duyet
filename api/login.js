import { body, checkPassword, clearSession, json, session, setSession } from "./_lib.js";

// POST {role:"r1"|"r2", password}  -> đặt cookie phiên
// GET                               -> {role} nếu đã đăng nhập
// DELETE                            -> đăng xuất
export default async function handler(req, res) {
  try {
    if (req.method === "GET") return json(res, 200, { role: session(req) });
    if (req.method === "DELETE") { clearSession(res); return json(res, 200, { ok: true }); }
    if (req.method !== "POST") return json(res, 405, { error: "method" });
    const { role, password } = await body(req);
    // chậm lại một chút để đoán mật khẩu tốn thời gian
    await new Promise((r) => setTimeout(r, 400));
    if (!checkPassword(role, password)) return json(res, 401, { error: "Sai vai hoặc mật khẩu." });
    setSession(res, role);
    return json(res, 200, { role });
  } catch (e) {
    return json(res, 500, { error: "Máy chủ chưa cấu hình xong (" + e.message + ")." });
  }
}
