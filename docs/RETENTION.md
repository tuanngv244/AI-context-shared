# Tự động cắt lịch sử và kiểm soát dung lượng

## Chính sách mặc định

| Dữ liệu                                  | Giới hạn / cách dọn                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Ghi nhớ phiên (`session_memories`)       | Theo số ngày đã chọn của repo, mặc định 30 ngày; tối đa 10.000 ghi nhớ và 100 MiB nội dung tính phí lưu trữ mỗi repo |
| Khi vượt số lượng hoặc dung lượng        | Loại bản cũ nhất, giữ bản mới nhất; áp dụng trong transaction ghi mới                                                |
| Một ghi nhớ lớn hơn trần dung lượng repo | Từ chối HTTP 413; không xóa lịch sử đang có để nhường chỗ cho bản ghi không thể lưu                                  |
| Outbox đã xử lý                          | Dọn sau 30 ngày hoặc vượt 100.000 bản đã xử lý/project, theo batch 5.000                                             |
| Event log                                | Dọn event quá 30 ngày khi không còn outbox và không phải idempotency của context/handoff đang tồn tại                |
| Audit log                                | 30 ngày hoặc 100.000 dòng/project, dọn theo batch                                                                    |
| Session không còn tham chiếu             | Dọn sau 30 ngày không hoạt động, kèm liên kết session/repo                                                           |
| Lease đã hết hạn                         | Dọn khi đã quá hạn 30 ngày                                                                                           |
| Redis failed jobs                        | Tối đa 30 ngày hoặc 10.000 job; event gốc chưa xử lý vẫn giữ trong PostgreSQL để phục hồi                            |

Dọn định kỳ khoảng **mỗi phút** trong local dev và worker. Với nhiều dữ liệu, backlog event/audit được dọn dần theo batch. Ghi nhớ phiên được kiểm tra trần ngay khi ghi; không đợi cron.

Thời gian lưu ghi nhớ dùng `history_days` đã chọn khi thêm repo. Repo chọn 7 ngày giữ 7 ngày; repo chọn 1 năm giữ tối đa 1 năm, vẫn chịu trần số lượng/dung lượng. Tạm dừng quan sát không tắt retention.

Dashboard hiển thị số ghi nhớ, dung lượng nội dung đã tính và chính sách thời gian/trần cho từng repo. Số MiB này bao gồm nội dung và một khoản overhead cố định cho mỗi bản ghi, **không phải kích thước vật lý toàn bộ database hoặc index**.

## Những gì được giữ lại

- Context fact/decision/contract, handoff chủ động và provenance liên quan không tự bị xóa theo chính sách lịch sử phiên.
- Event/outbox chưa xử lý không bị xóa; queue backlog cần được theo dõi nếu worker lỗi kéo dài.
- Cursor observer và mốc lịch sử đã cắt được giữ để tránh nhập lại bản cũ từ log local sau restart hoặc reset offset.
- Không xóa hoặc sửa file log gốc của Codex/Claude trên máy.

Vì còn dữ liệu dài hạn, số lượng repo và backlog chưa xử lý, đây **không phải hard quota toàn DB**, và không bảo đảm ổ đĩa không bao giờ đầy. Cần theo dõi dung lượng ổ đĩa, backup và queue lag khi triển khai lâu dài.

## Cursor đồng bộ hết hạn

Nếu client tiếp tục từ một cursor cũ hơn log đã được dọn, API trả `410` cùng hướng dẫn resync. Đọc lại `context_bootstrap` hoặc `context_recall`, sau đó dùng cursor hiện tại. Client bắt đầu từ `0` nhận `resyncRequired` khi đã có retention floor; không được coi delta còn lại là toàn bộ lịch sử.

Các tool đọc theo tên repo (`context_recall`) không phụ thuộc cursor delta cũ.

## Dung lượng file có giảm ngay không?

Không nhất thiết. PostgreSQL dùng VACUUM để thu hồi các vùng dữ liệu đã xóa cho việc tái sử dụng; kích thước file có thể giữ nguyên. Local PGlite được chạy `VACUUM (ANALYZE)` khoảng mỗi giờ; PostgreSQL production dùng autovacuum. Không tự chạy `VACUUM FULL` vì nó có thể khóa bảng và cần thêm dung lượng. Xem [PostgreSQL: Routine Vacuuming](https://www.postgresql.org/docs/16/routine-vacuuming.html).

## Bật sau khi cập nhật source

Dừng server cũ rồi chạy lại:

```sh
npm run dev
```

Migration `003_retention.sql` tự bổ sung policy/cột/index. Cron bắt đầu trong chu kỳ xử lý đầu tiên. Không cần sửa MCP hoặc token. Với Compose, rebuild và chạy migration trước khi worker mới khởi động.

Bài test kiểm tra việc xóa trên database fixture, không xóa dữ liệu local hiện tại để thử nghiệm. Test bao gồm dữ liệu hết hạn, quota số dòng/dung lượng, dữ liệu mới, replay, pending events, cursor hết hạn, orphan sessions và VACUUM.

## Dọn thủ công trên UI

Chọn repo → **Dọn context cũ** → chọn số ngày → **Xem trước**. Chỉ khi xác nhận mới xóa số ghi nhớ phiên phù hợp của repo đó. Hủy sẽ không gửi lệnh xóa. Mốc cutoff được giữ từ lúc xem trước; quyết định/contract/handoff và event pending không bị xóa. Sau khi dọn, watermark ngăn cả lịch sử cũ chưa từng được nhập quay trở lại từ log local.

Cần quyền manage, write và organization admin. API không cho client khác tenant dọn dữ liệu của bạn. Chạy lại server để migration 004 được áp dụng trước khi dùng nút mới.
