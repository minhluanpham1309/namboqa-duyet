# NamBoQA – trang duyệt nhãn

Trang cho hai người duyệt độc lập các cặp hỏi–đáp vòng 3 (gold) và mẫu silver.
Repo **private**: `data/` chứa văn bản tài liệu không phát hành công khai; API chỉ trả dữ liệu sau khi đăng nhập.

- `public/index.html` – giao diện (phím 1 Đạt · 0 Loại · ? Chưa chắc · ←/→ · N câu chưa duyệt)
- `api/login.js` – đăng nhập theo vai r1/r2, cookie ký HMAC 14 ngày
- `api/data.js` – các cặp giao cho người đăng nhập + đoạn tài liệu
- `api/labels.js` – đọc/lưu nhãn của chính mình (Vercel Blob private, `labels/<vai>/<hàng>/b<đợt>.json`)
- `api/export.js` – kéo toàn bộ nhãn, cần header `x-admin-token`

Biến môi trường trên Vercel: `NB_USERS` (`{"r1":"…","r2":"…"}`), `NB_SECRET`, `NB_ADMIN_TOKEN`, `BLOB_READ_WRITE_TOKEN` (tự có khi nối Blob store).
