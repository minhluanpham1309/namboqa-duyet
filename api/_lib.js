// Phần dùng chung cho các API: đăng nhập bằng cookie ký HMAC, đọc dữ liệu, lưu nhãn.
//
// Biến môi trường (đặt trên Vercel, không commit):
//   NB_USERS        JSON {"r1":"<mật khẩu người 1>","r2":"<mật khẩu người 2>"}
//   NB_SECRET       chuỗi ngẫu nhiên dài để ký cookie
//   NB_ADMIN_TOKEN  khoá cho /api/export (Claude kéo nhãn về máy)
//   BLOB_READ_WRITE_TOKEN  Vercel tự thêm khi nối Blob store vào project
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { del, get, list, put } from "@vercel/blob";

export const ROLES = ["r1", "r2"];
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
export const assignedTo = (it, role) => it.a === "both" || it.a === role;

// ---------------------------------------------------------------- nhãn
// KHÔNG ghi đè blob nào: blob private đọc qua CDN có thể trả bản cũ sau khi bị ghi đè
// (lỗi "ETag mismatch" ngày 22/10). Mỗi lần lưu là một blob mới, tên không trùng:
//   labels/<vai>/<hàng>/b<đợt>/<ts 13 số>-<hex>.json        = delta {id: {v,n,t} | null}
//   labels/<vai>/<hàng>/b<đợt>/<ts 13 số>-zsnap-<hex>.json  = ảnh gộp mọi delta có ts <= ts
// Đọc: liệt kê, sắp theo tên (= theo thời gian), áp lần lượt. Khi một đợt có nhiều delta,
// gộp thành một ảnh mới rồi xoá các delta đã gộp. Blob kiểu cũ labels/<vai>/<hàng>/b<n>.json
// (trước khi sửa) được coi là ảnh nền, áp trước mọi thứ.
const rnd = () => crypto.randomBytes(4).toString("hex");
const pad = (n) => String(n).padStart(13, "0");
const GOP_KHI = 12;

async function readBlob(pathname) {
  // blob mới không bao giờ bị ghi đè nên cache an toàn; blob kiểu cũ thì đọc bỏ qua cache
  const r = await get(pathname, { access: "private", useCache: !/\/b\d+\.json$/.test(pathname) });
  if (!r || r.statusCode !== 200 || !r.stream) return {};
  try { return JSON.parse(await new Response(r.stream).text()) || {}; } catch { return {}; }
}

async function listAll(prefix) {
  const out = [];
  let cursor;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    out.push(...page.blobs.map((b) => b.pathname));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

async function mapLimit(arr, n, fn) {
  const res = new Array(arr.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, arr.length) }, async () => {
    while (i < arr.length) { const k = i++; res[k] = await fn(arr[k]); }
  }));
  return res;
}

// gom theo đợt: "labels/r1/gold3/b1" -> {legacy:[path], parts:[path...] đã sắp}
function groupPaths(paths) {
  const g = new Map();
  for (const p of paths) {
    let m = p.match(/^(labels\/[^/]+\/[^/]+\/b\d+)\.json$/);
    if (m) { if (!g.has(m[1])) g.set(m[1], { legacy: [], parts: [] }); g.get(m[1]).legacy.push(p); continue; }
    m = p.match(/^(labels\/[^/]+\/[^/]+\/b\d+)\/(\d{13})-.+\.json$/);
    if (m) { if (!g.has(m[1])) g.set(m[1], { legacy: [], parts: [] }); g.get(m[1]).parts.push(p); }
  }
  for (const v of g.values()) v.parts.sort();
  return g;
}

function apply(state, data, isDelta) {
  for (const [id, l] of Object.entries(data || {})) {
    if (l && l.v) state[id] = l; else if (isDelta) delete state[id];
  }
}

async function readGroup(dir, { legacy, parts }) {
  const blobs = await mapLimit([...legacy, ...parts], 12, readBlob);
  let state = {};
  blobs.forEach((data, i) => {
    const p = i < legacy.length ? null : parts[i - legacy.length];
    if (p && /-zsnap-/.test(p)) { state = {}; apply(state, data, false); } // ảnh gộp đã chứa mọi thứ trước nó
    else apply(state, data, p !== null);
  });
  // gộp khi nhiều delta: ảnh mới mang ts của delta cuối, rồi xoá các delta đã gộp
  const deltas = parts.filter((p) => !/-zsnap-/.test(p));
  if (deltas.length >= GOP_KHI) {
    try {
      const lastTs = parts[parts.length - 1].slice(dir.length + 1, dir.length + 14);
      await put(`${dir}/${lastTs}-zsnap-${rnd()}.json`, JSON.stringify(state), {
        access: "private", contentType: "application/json", addRandomSuffix: false });
      await del(parts); // legacy giữ lại làm nền (đọc chỉ một lần, không bao giờ ghi lại)
    } catch (e) { console.error("gop", dir, e?.message); }
  }
  return state;
}

export async function readLabels(role) {
  const groups = groupPaths(await listAll(`labels/${role}/`));
  const out = {};
  const states = await mapLimit([...groups], 4, ([dir, g]) => readGroup(dir, g));
  for (const st of states) Object.assign(out, st);
  for (const k of Object.keys(out)) if (!out[k] || !out[k].v) delete out[k];
  return out;
}

export async function mergeLabels(role, queue, batch, delta) {
  const t = new Date().toISOString(), body = {};
  for (const [id, l] of Object.entries(delta)) body[id] = l && l.v ? { v: l.v, n: String(l.n || "").slice(0, 2000), t } : null;
  await put(`labels/${role}/${queue}/b${batch}/${pad(Date.now())}-${rnd()}.json`, JSON.stringify(body), {
    access: "private", contentType: "application/json", addRandomSuffix: false });
  return Object.keys(body).length;
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
