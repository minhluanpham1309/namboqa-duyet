import { isAdmin, json, readLabels } from "./_lib.js";

// GET /api/export  (header x-admin-token: <NB_ADMIN_TOKEN>)
// -> {r1: {id:{v,n,t}}, r2: {...}, exportedAt}. Dùng để ghi nhãn vào phiếu CSV.
export default async function handler(req, res) {
  if (!isAdmin(req)) return json(res, 401, { error: "Sai khoá admin." });
  const [r1, r2, r3, r4, r5] = await Promise.all(["r1", "r2", "r3", "r4", "r5"].map(readLabels));
  return json(res, 200, { r1, r2, r3, r4, r5, exportedAt: new Date().toISOString() });
}
