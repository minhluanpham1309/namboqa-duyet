// Phần dùng chung cho các API: đăng nhập bằng cookie ký HMAC, đọc dữ liệu, lưu nhãn.
//
// Biến môi trường (đặt trên Vercel, không commit):
//   NB_USERS        JSON {"r1":"<mật khẩu người 1>","r2":"<mật khẩu người 2>"}
//   NB_SECRET       chuỗi ngẫu nhiên dài để ký cookie
//   NB_ADMIN_TOKEN  khoá cho /api/export (Claude kéo nhãn về máy)
//   KV_REST_API_URL, KV_REST_API_TOKEN  Vercel tự thêm khi nối Upstash Redis vào project
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ROLES = ["r1", "r2", "r3"];   // r3 = người kiểm tra chéo (chấm mù 150 câu)
const COOKIE = "nb";
const MAX_AGE = 14 * 24 * 3600;

const secret = () => {
  const s = process.env.NB_SECRET;
  if (!s || s.length < 16) throw new Error("NB_SECRET chưa đặt");
  return s;
};
const sign = (v) => crypto.createHmac("sha256", secret()).update(v).digest("base64url");
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function users() {
  try { return JSON.parse(process.env.NB_USERS || "{}"); } catch { return {}; }
}

export function checkPassword(role, pw) {
  const u = users();
  return ROLES.includes(role) && typeof u[role] === "string" && u[role].length > 0 && same(u[role], pw || "");
}

export function setSession(res, role) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  const v = `${role}.${exp}`;
  res.setHeader("Set-Cookie",
    `${COOKIE}=${v}.${sign(v)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`);
}

export function clearSession(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

export function session(req) {
  const raw = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  if (!raw) return null;
  const [role, exp, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (!role || !exp || !sig || !ROLES.includes(role)) return null;
  if (!same(sign(`${role}.${exp}`), sig)) return null;
  if (+exp < Date.now() / 1000) return null;
  return role;
}

export function isAdmin(req) {
  const t = process.env.NB_ADMIN_TOKEN;
  const got = req.headers["x-admin-token"] || new URL(req.url, "http://x").searchParams.get("token");
  return !!t && t.length >= 16 && !!got && same(t, got);
}

// ---------------------------------------------------------------- dữ liệu
let _items = null, _pas = null;
export function items() {
  if (!_items) _items = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data/items.json"), "utf8"));
  return _items;
}
export function passages() {
  if (!_pas) _pas = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data/passages.json"), "utf8"));
  return _pas;
}
let _kt = null;
const kiemtra = () => (_kt ??= new Set(JSON.parse(fs.readFileSync(path.join(process.cwd(), "data/kiemtra.json"), "utf8")).ids));
export const assignedTo = (it, role) => role === "r3" ? kiemtra().has(it.id) : (it.a === "both" || it.a === role);
// r3 thấy các câu kiểm tra như một hàng riêng "kiemtra", một đợt
export const asSeenBy = (it, role) => role === "r3" ? { ...it, q: "kiemtra", b: 1 } : it;

// ---------------------------------------------------------------- nhãn
// Lưu trong Upstash Redis (REST): mỗi vai một hash  nb:labels:<vai>  {id -> JSON {v,n,t}}.
// Một lần lưu = một lệnh HSET/HDEL; đọc = một lệnh HGETALL. (Vercel Blob bị khoá ngày
// 22/10/2026 vì vượt hạn mức thao tác của gói Hobby, nên bỏ hẳn Blob.)
const rUrl = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const rTok = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = (role) => `nb:labels:${role}`;

async function redis(commands) {
  if (!rUrl() || !rTok()) throw new Error("Chưa nối Upstash Redis (thiếu KV_REST_API_URL/TOKEN)");
  const r = await fetch(rUrl().replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: { Authorization: `Bearer ${rTok()}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) throw new Error(`Redis ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  const bad = j.find((x) => x && x.error);
  if (bad) throw new Error("Redis: " + bad.error);
  return j.map((x) => x.result);
}

export async function readLabels(role) {
  const [flat] = await redis([["HGETALL", KEY(role)]]);
  const out = {};
  for (let i = 0; flat && i < flat.length; i += 2) {
    try { const l = JSON.parse(flat[i + 1]); if (l && l.v) out[flat[i]] = l; } catch {}
  }
  return out;
}

// queue, batch giữ trong chữ ký cho các API cũ; khoá theo vai là đủ
export async function mergeLabels(role, queue, batch, delta) {
  const t = new Date().toISOString(), set = [], delIds = [];
  for (const [id, l] of Object.entries(delta)) {
    if (l && l.v) set.push(id, JSON.stringify({ v: l.v, n: String(l.n || "").slice(0, 2000), t }));
    else delIds.push(id);
  }
  const cmds = [];
  if (set.length) cmds.push(["HSET", KEY(role), ...set]);
  if (delIds.length) cmds.push(["HDEL", KEY(role), ...delIds]);
  if (cmds.length) await redis(cmds);
  return set.length / 2 + delIds.length;
}

// nạp hàng loạt (admin): HSETNX — chỉ điền câu CHƯA có nhãn, không đè nhãn mới hơn
// mà trang duyệt đã gửi lên. Trả về số câu thật sự được điền.
export async function importLabels(role, labels) {
  const cmds = [];
  for (const [id, l] of Object.entries(labels)) if (l && l.v)
    cmds.push(["HSETNX", KEY(role), id, JSON.stringify({ v: l.v, n: String(l.n || ""), t: l.t || new Date().toISOString() })]);
  let n = 0;
  for (let i = 0; i < cmds.length; i += 200) n += (await redis(cmds.slice(i, i + 200))).reduce((a, x) => a + (x ? 1 : 0), 0);
  return n;
}

export function json(res, code, body) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export async function body(req) {
  let b;
  try { b = req.body; } catch { return {}; }          // Vercel ném lỗi khi JSON hỏng
  if (b && typeof b === "object") return b;
  if (typeof b === "string") { try { return JSON.parse(b); } catch { return {}; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; }
}
