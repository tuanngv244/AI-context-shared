# Hướng dẫn sử dụng

**Tiếp tục công việc với đầy đủ ngữ cảnh từ những phiên trước.**

Shared Context Engine (SCE) là dịch vụ chạy local, giúp agent dùng lại ngữ cảnh giữa nhiều phiên làm việc và repository. Bạn chọn repo cần theo dõi, xem tóm tắt trên dashboard và cho agent đọc lại lịch sử qua MCP.

[English](../README.md) · [Cấu hình](CONFIGURATION.md) · [API và MCP](api/README.md)

## 1. Khởi động

Cần **Node.js 22.13+**, **npm** và **Git**. Mở terminal tại thư mục source:

```sh
npm ci
npm run dev
```

Mở [localhost:3000](http://localhost:3000), copy nội dung `.local/dev-token` vào ô **Access token** rồi kết nối. Bấm **VI** ở góc trên để chuyển sang tiếng Việt.

Chế độ local tự tạo token và database PGlite; không cần `.env`, Docker hoặc Redis. Dữ liệu nằm trong `.local/`. Dừng bằng **Ctrl+C**; lần chạy tiếp theo dùng lại dữ liệu đã lưu.

## 2. Thêm repository

Nhập tên thư mục của một Git repository, chọn khoảng lịch sử muốn nhập và bấm **Quan sát repo**. Mặc định SCE tìm repo trong thư mục cha của chính nó.

Nếu repo nằm nơi khác, đặt `SCE_WORKSPACE_ROOTS` trước khi khởi động. Có thể khai báo nhiều thư mục gốc theo dấu phân cách đường dẫn của hệ điều hành. Xem [mẫu cấu hình](CONFIGURATION.md).

Observer chỉ nhập các trích đoạn tóm tắt assistant thuộc định dạng được hỗ trợ của repo đã chọn. Log agent phải có trên máy đang chạy SCE. Tạm dừng theo dõi repo trên dashboard khi không muốn nhập thêm lịch sử.

## 3. Kết nối agent qua MCP

Giữ dịch vụ đang chạy, mở terminal khác tại thư mục SCE:

```sh
# Xuất TOML cho Codex
npm run mcp:config

# Xuất JSON cho Claude Code
npm run mcp:config -- claude
```

Gộp server `sce` được in ra vào cấu hình MCP của client tương ứng. Lệnh tính đường dẫn theo máy đang cài, không sửa cấu hình client và không in token. Đầu ra chứa đường dẫn local nên chỉ dùng trên máy của bạn.

Khởi động lại client và mở phiên mới. Khi thêm repo, không cần tạo lại cấu hình MCP.

## 4. Đọc lại và lưu ngữ cảnh

Ví dụ yêu cầu agent, thay `example-app` bằng tên repo đã theo dõi:

> Đọc lịch sử SCE của repository example-app, tóm tắt công việc còn dở rồi tiếp tục thực hiện.

Các tool chính:

| Tool                   | Công dụng                             |
| ---------------------- | ------------------------------------- |
| `context_repositories` | Liệt kê các repo được phép truy cập   |
| `context_recall`       | Tìm lịch sử và ngữ cảnh theo tên repo |
| `context_checkpoint`   | Lưu tóm tắt, việc còn dở và trở ngại  |

Khi đọc repo khác từ phiên hiện tại, gửi tên repo đích và bỏ `cwd` của repo đang mở. Lịch sử do agent báo cáo không thay thế việc kiểm tra code hoặc chạy test.

## 5. Dùng dashboard

- **Lịch sử / Context / Các phiên:** xem tóm tắt phiên, ngữ cảnh dài hạn và thông tin phiên làm việc.
- **Tìm kiếm và lọc agent:** tìm trong tối đa 100 ghi nhớ đang tải trên giao diện.
- **EN / VI, Sáng / Tối / Hệ thống:** lưu tùy chọn trong trình duyệt; token chỉ giữ trong bộ nhớ của trang.
- **Luồng hoạt động / Hướng dẫn:** mở trợ giúp ngay cả trước khi kết nối.
- **Dọn context cũ:** xem trước số ghi nhớ sẽ xóa rồi xác nhận. Thao tác không hoàn tác; quyết định, contract, handoff và event pending được giữ lại.

## 6. Lưu trữ và dữ liệu riêng tư

Mặc định lịch sử được giữ **30 ngày**, tối đa **10.000 ghi nhớ** hoặc **100 MiB nội dung/repo**. Ngữ cảnh dài hạn và event pending được giữ riêng; đây không phải hạn mức cho toàn database. Xem [chính sách lưu trữ](RETENTION.md).

Observer không lưu toàn bộ transcript, prompt, reasoning hoặc tool payload. Nội dung tóm tắt vẫn có thể chứa thông tin riêng tư; bộ lọc secret không bảo đảm nhận diện tất cả. Không chia sẻ `.local/`, `.env`, log hoặc cấu hình MCP đã sinh trên máy.

Public trực tiếp repository này lên GitHub. Xem [hướng dẫn public repo](SHARING.md) để giữ dữ liệu local ngoài Git.

## 7. Chạy bằng Docker

```sh
cp .env.example .env
# Thay tất cả placeholder mật khẩu/token và cập nhật các URL kết nối tương ứng.
docker compose up -d --build --wait
```

Dashboard và API mặc định chỉ mở trên loopback; PostgreSQL và Redis nằm trong mạng Compose. Container không tự đọc log agent trên host. Luồng theo dõi repo local dùng `npm run dev`. Khi triển khai cho team từ xa, cần cấu hình OIDC và cấp quyền thành viên phù hợp.

## 8. Kiểm tra source

```sh
npm run check
npm run build:dashboard
npm run format:check
npm run test:memory-smoke
npx playwright install chromium
npm run test:ui
```

Smoke test dùng database và cổng riêng. Test UI sử dụng dữ liệu mô phỏng.

## Tác giả

[tuanngv244](https://github.com/tuanngv244)

## Giấy phép

Source sử dụng giấy phép [MIT](../LICENSE).
