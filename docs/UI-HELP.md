# Trợ giúp ngay trên dashboard

Hai nút **How it works** và **Docs** (tiếng Việt: **Luồng hoạt động**, **Hướng dẫn**) nằm dưới thanh đầu trang, mở được cả trước khi kết nối token.

- **How it works**: sơ đồ sáu bước có animation, chạy/dừng, chọn bước hoặc chuyển bước; giải thích observer, API, DB, MCP recall và checkpoint. Phần lưu trữ phân biệt local dev, log agent gốc, Docker, trình duyệt và spool CLI tùy chọn. Khi hệ điều hành bật giảm chuyển động, animation mặc định dừng.
- **Docs**: cách khởi động, thêm repo, cấu hình MCP cho từng client, đọc lịch sử giữa các phiên/dự án và dọn context cũ.

Hai modal hỗ trợ EN/VI, light/dark mode, bàn phím và màn hình nhỏ. Nhấn Escape hoặc Close để đóng.

Tác giả: [tuanngv244](https://github.com/tuanngv244). Liên kết GitHub xuất hiện ở cuối phần **Docs / Hướng dẫn** trên dashboard. Nếu muốn tùy chỉnh, sửa `name` và `githubUrl` trong `apps/dashboard/app/config/author.ts`, sau đó build lại dashboard. `githubUrl` nhận liên kết HTTPS tới hồ sơ GitHub; để trống khi không cần hiển thị liên kết.
