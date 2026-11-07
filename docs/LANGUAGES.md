# UI language / Ngôn ngữ giao diện

The dashboard supports **English (EN)** and **Vietnamese (VI)**. English is the default, including when your browser uses Vietnamese.

Use the EN / VI buttons in the header to switch language. The selection is remembered in this browser under `sce-language`, separately from the theme. Labels, cleanup dialogs, notifications, sample prompts, accessibility labels, dates and number formats follow the selected language. If browser storage is unavailable, switching still works for the current page.

Repository names and saved agent reports/context are original data and are never automatically translated or rewritten. Changing language does not change authentication, API requests, cleanup parameters, or stored records.

---

Dashboard hỗ trợ **EN / VI**, mặc định **EN**. Bấm nút ngôn ngữ ở góc trên để chuyển. Lựa chọn được nhớ riêng với theme trên trình duyệt; không lưu token đăng nhập.

Nhãn, hộp thoại dọn lịch sử, thông báo và định dạng ngày/số đổi theo lựa chọn. Nội dung agent, tên repo và dữ liệu đã lưu giữ nguyên. Chọn VI nếu muốn làm theo các hướng dẫn thao tác bằng tiếng Việt.

Implementation: `apps/dashboard/app/i18n/messages.ts` contains both dictionaries and interpolation; `provider.tsx` manages language selection.
