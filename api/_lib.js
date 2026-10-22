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
import { BlobPreconditionFailedError, get, list, put } from "@vercel/blob";

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
// Mỗi người × hàng × đợt là một blob private: labels/<role>/<queue>/b<batch>.json
// = {"<id>": {"v":"1"|"0"|"?","n":"ghi chú","t":"ISO"}}. Ghi bằng read-merge-write
// có ifMatch (etag) để hai lần lưu gần nhau không đè mất nhãn của nhau.
const key = (role, queue, batch) => `labels/${role}/${queue}/b${batch}.json`;

async function readBlob(pathname) {
  const r = await get(pathname, { access: "private", useCache: false });
  if (!r || r.statusCode !== 200 || !r.stream) return { data: {}, etag: null };
  const text = await new Response(r.stream).text();
  let data = {};
  try { data = JSON.parse(text) || {}; } catch { data = {}; }
  return { data, etag: r.blob?.etag || null };
}

export async function readLabels(role) {
  const out = {};
  let cursor;
  do {
    const page = await list({ prefix: `labels/${role}/`, cursor, limit: 1000 });
    for (const b of page.blobs) {
      const { data } = await readBlob(b.pathname);
      Object.assign(out, data);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  for (const k of Object.keys(out)) if (!out[k] || !out[k].v) delete out[k];
  return out;
}

export async function mergeLabels(role, queue, batch, delta) {
  const p = key(role, queue, batch);
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, etag } = await readBlob(p);
    for (const [id, l] of Object.entries(delta)) {
      if (l && l.v) data[id] = { v: l.v, n: String(l.n || "").slice(0, 2000), t: new Date().toISOString() };
      else delete data[id];
    }
    try {
      await put(p, JSON.stringify(data), {
        access: "private", contentType: "application/json", addRandomSuffix: false,
        allowOverwrite: true, ...(etag ? { ifMatch: etag } : {}),
      });
      return Object.keys(data).length;
    } catch (e) {
      if (attempt === 3 || !(e instanceof BlobPreconditionFailedError)) throw e;
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 300));
    }
  }
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
