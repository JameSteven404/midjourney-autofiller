# Midjourney Prompt Auto-Filler 1.2.0

Bản cập nhật ngày 14/09/2026: dùng Debug/CDP làm chế độ mặc định, tối ưu bộ theo dõi và hàng đợi, bổ sung báo cáo. Giữ các sửa lỗi tải ảnh/giới hạn prompt và icon của bản 1.1.0.

## Cài / cập nhật

1. Dừng batch hiện tại và kiểm tra các job đang gửi trên Midjourney.
2. Mở `chrome://extensions` hoặc `brave://extensions` ở profile dùng Midjourney.
3. Nếu tiện ích đã nạp từ thư mục này: bấm **Reload / Tải lại**. Bản này thêm quyền `debugger`; nếu trình duyệt yêu cầu bật lại/chấp nhận quyền thì thực hiện trong trang quản lý tiện ích. Nếu chưa nạp: bật Developer mode, chọn **Load unpacked**, chọn thư mục chứa `manifest.json`.
4. Tải lại tab Midjourney để dùng content script mới. Mở side panel và bấm **Gắn tab đang mở**.
5. Trong Cài đặt chọn **Debug / CDP**, giữ **Số prompt đang tạo tối đa = 1** cho lần kiểm tra đầu. Debug là mặc định của bản này. Bật tự tải ảnh nếu cần.
6. Kiểm tra một prompt: nội dung gửi đúng, đúng job, đủ ảnh và Chrome báo từng file hoàn tất. Sau đó mới chạy cả hàng đợi.

## Thay đổi

- Debug/CDP nhập nguyên prompt bằng `Input.insertText`, click bằng `Input.dispatchMouseEvent`, đóng bảng cài đặt bằng Escape qua `Input.dispatchKeyEvent`. Xác minh nội dung textarea sau khi nhập; chỉ chuẩn hóa CRLF thành LF theo quy tắc textarea HTML.
- Kết nối một phiên debugger khi chạy batch, ngắt khi dừng/gửi hết. Hủy debugger, đóng tab hoặc rời Midjourney sẽ dừng gửi. Không tự đổi sang DOM để gửi lần hai khi thiếu xác nhận.
- Chỉ nhận thao tác debug của prompt đang chạy từ main frame của tab đã gắn. Tọa độ click được lấy lại ngay trước thao tác và kiểm tra phần tử có bị che không. Lưu dấu đã thử gửi trước khi click để chặn gửi lặp.
- Cài đặt được click qua CDP và đọc lại giá trị. Thử lại tối đa 3 lần cho mục chưa đúng, chờ đến khi giá trị khớp; chỉ lưu cache cài đặt khi xác minh thành công. Nếu sai cài đặt, giữ prompt chưa gửi.
- Một lần quét lưới mỗi nhịp theo dõi, dùng MutationObserver để kiểm tra khi DOM thay đổi, vẫn có polling dự phòng 4 giây. Có job xong thì đánh thức hàng đợi ngay, không phải đợi đủ một giây polling.
- Side panel không dựng lại toàn bộ hàng đợi khi chỉ có log/cài đặt thay đổi.
- Hiển thị trạng thái Debug, đếm ngược khoảng nghỉ và thời gian gửi trung bình thực đo của batch. Có nút tải ảnh thiếu cho cả hàng đợi và xuất báo cáo JSON chứa các prompt, trạng thái, link tải, log và thời gian gửi. Báo cáo chỉ lưu xuống máy khi bấm nút.

- Tải trực tiếp từ link CDN, giữ đuôi định dạng nguồn. Không còn phụ thuộc bước chuyển preview thành PNG/blob trong tab.
- Lưu trạng thái từng lượt tải. Có mã download chỉ được xem là bắt đầu; trạng thái `complete` từ Chrome mới được xem là tải xong.
- Nút **Tải ảnh còn thiếu** tải lại URL thất bại, bỏ qua URL đã tải xong hoặc còn đang tải. Lượt tải chưa đối chiếu được sau khi worker khởi động lại có thông báo yêu cầu kiểm tra Downloads.
- Hiển thị số prompt đã tạo, đang tạo, lý do tạm dừng và số ảnh đã tải cho từng prompt.
- Giới hạn số prompt đang tạo do người dùng đặt, mặc định 1. Đây là mức trần cục bộ của tool, không phải hạn mức được xác nhận của gói Midjourney.
- Chế độ liên tục bỏ khoảng nghỉ khi còn chỗ trống, vẫn chờ khi đủ số job đang tạo.
- Đọc thông báo lỗi trước khi gửi và sau khi click, kể cả khi ô nhập chưa xóa. Dừng gửi khi trang báo giới hạn, giữ các prompt chưa gửi.
- Thông báo lỗi chung trên trang không còn khiến toàn bộ job đã gửi bị xóa khỏi bộ theo dõi.
- Nếu chưa xác nhận kết quả sau 30 phút, chuyển sang **Cần kiểm tra** và dừng hàng đợi. Kiểm tra trên Midjourney rồi dùng nút **Đã kiểm tra trên Midjourney — bỏ qua**; tool không tự gửi lại prompt chưa rõ kết quả.
- Dừng trong lúc gửi không đưa prompt đó về Chờ; tránh gửi trùng khi tiếp tục. Các cập nhật hàng đợi, kết quả và cài đặt được ghi tuần tự để tránh ghi đè lẫn nhau.
- Ghép kết quả bằng nội dung prompt đã chuẩn hóa, loại các grid đã có trước lúc gửi và grid đã nhận cho job khác trong phiên. Không dùng tiền tố gần giống để tự chọn ảnh.
- Icon thanh công cụ, trang quản lý tiện ích và side panel dùng `icons/portrait.png`, sao chép nguyên ảnh người dùng. Trình duyệt thu nhỏ khi hiển thị.

## Đối chiếu code tham khảo

Nguồn do người dùng chỉ định:
`C:/Users/Admin/Documents/ĐỒ ĐI ĂN TRỘM KKKKKK/fnmijgmnjpealnnadjpjilaanhhambeb/3.4.3.0_0/`

Đã đọc manifest và các bundle chức năng liên quan; không thay đổi thư mục tham khảo, không nhập bundle đó vào tool Midjourney.

| Nguồn Flow Automation | Cách áp dụng vào Midjourney |
| --- | --- |
| `assets/index.ts-i876q9vg.js`: `PROMPT_GROUP_STATUS`, `processedCount`, `totalCount`, `results` | Tiến độ hàng đợi và trạng thái kết quả theo từng prompt |
| Cùng file: `DOWNLOAD_RESOURCE` mang URL, filename, folder | Tách lấy link ảnh khỏi việc tải, dùng URL CDN trực tiếp |
| `assets/index.ts-B2QzyOff.js`: `chrome.downloads.download` trả `downloadId` | Bắt đầu tải bằng API Chrome; bổ sung đối chiếu `onChanged`/`search` trước khi báo hoàn tất |
| Content bundle: `CANCEL_PROMPT_GROUP`, cờ hủy cho nhóm đang chạy | Dừng gửi tiếp; giữ kết quả của prompt đã gửi |
| Background bundle: `CA`, `CD`, `CIT`, `CK`, `CC` và các lệnh CDP | Transport Debug/CDP riêng, xác minh tab/request và chặn click gửi lặp |
| Content bundle: `delayRemainingSeconds`, `downloadRetryCountByIndex`, hàng đợi tải riêng | Đếm ngược, tải lại các ảnh thiếu cả batch và tiến độ theo prompt |

Nguồn tham khảo có nhánh ghi log “downloaded” sau khi bắt đầu tải. Bản này tự triển khai xác nhận hoàn tất riêng, không coi log đó là bằng chứng file đã tải xong.

### Về thanh thông báo “đã bắt đầu gỡ lỗi cho trình duyệt này”

Service worker của code tham khảo sử dụng `chrome.debugger.attach`, `Input.insertText`, `Input.dispatchKeyEvent`, `Input.dispatchMouseEvent`; nhánh attach cũng có `Network.enable` và `Network.setCacheDisabled`.

Bản 1.2.0 đã triển khai điều khiển input qua Chrome DevTools Protocol làm mặc định theo yêu cầu người dùng. Giữ chế độ DOM có thể chọn trước khi chạy. Không sao chép phần tắt cache của nguồn tham khảo; giữ cache trình duyệt để tránh tải lại tài nguyên không cần thiết. Debugger không tăng hạn mức prompt của tài khoản và không thay thế việc xác nhận file tải hoàn tất.

Tài liệu: [Chrome Downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads), [Chrome Debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger).

## Kiểm chứng

Chạy từ thư mục tiện ích:

```powershell
node --test tests/regression.test.cjs
node --check background.js
node --check content-scripts/midjourney.js
node --check sidepanel/sidepanel.js
```

27 kiểm thử tự động vượt qua trên Node, dùng chính file JavaScript của tiện ích với Chrome API/DOM được mô phỏng. Bao gồm hủy debugger, lỗi attach, stop trong lúc attach, đúng tab/main frame/request, chặn submit lần hai và chỉ quét một lần cho 100 job. Ba kiểm thử về mất URL khi chuyển PNG lỗi, bỏ sót queue-full khi ô nhập không xóa và timeout báo thành công đã chạy lại trên bản sao code cũ: cả ba thất bại.

### Kiểm thử trình duyệt thực

`node tests/browser-smoke.cjs` dùng Chrome for Testing với tiện ích Load unpacked thật và trang fixture được chặn toàn bộ request bằng Playwright. Không đăng nhập, không gửi yêu cầu tạo ảnh tới Midjourney.

Đã vượt qua ba nhóm kiểm tra:

1. Input qua CDP có `isTrusted=true`, giữ tiếng Việt/dấu nháy/xuống dòng, gửi hai prompt riêng và nhận 4 URL/job mô phỏng, tự nhường slot và detach khi gửi hết.
2. Click cài đặt có `isTrusted=true`, đọc lại Landscape/Relax đúng, Escape đóng bảng, không mở lại cài đặt cho prompt thứ hai cùng batch.
3. Đóng tab tạo sự kiện debugger onDetach thật; hàng đợi dừng và prompt kế tiếp vẫn Chờ. Hủy từ thanh thông báo được kiểm tra bằng sự kiện `canceled_by_user` trong bộ test mô phỏng.

Harness dùng Playwright từ bundle Codex trên máy này; có thể đặt `PLAYWRIGHT_MODULE` và `PLAYWRIGHT_BROWSERS_PATH` nếu chạy ở máy khác. Chromium test nằm ngoài thư mục tiện ích, trong `../.test-runtime/browsers`. Extension khi sử dụng không cần Node/Playwright.

Kiểm thử quét lưới với 100 job: bản 1.1.0 thực hiện 100 lần quét; bản 1.2.0 thực hiện 1 lần mỗi nhịp. Đây là đo số lần gọi trong fixture, không phải mức tăng tốc tạo ảnh thực tế.

## Giới hạn chưa kiểm chứng trực tiếp

- Đã kiểm thử Load unpacked và CDP thật trên trang fixture; chưa chạy pilot trên tài khoản Midjourney thật, chưa xác minh tải ảnh thật hay mức tăng tốc trên production.
- URL lấy từ ảnh trong lưới, chưa đảm bảo ảnh gốc/full resolution. Giữ định dạng nguồn không làm tăng độ phân giải.
- DOM của Midjourney vẫn cần kiểm tra thực tế. Prompt bị cắt ngắn hoặc được trang biến đổi, grid bị ảo hóa khỏi DOM, số ảnh chưa hiển thị đủ, hoặc job thủ công có prompt giống hệt có thể cần kiểm tra riêng. Ghép chính xác và loại grid cũ giảm nhầm lẫn nhưng chưa phải ánh xạ bằng ID job từ phản hồi máy chủ.
- Mức trần chỉ đếm job do tiện ích theo dõi. Job gửi thủ công, thiết bị khác hoặc giới hạn của gói vẫn có thể khiến Midjourney từ chối; khi đó tool dừng.
- File `done` cũ không có URL nguồn từ phiên bản trước không thể tự khôi phục link tải chỉ từ trạng thái đã lưu.

## Icon

File nguồn được sao chép nguyên nội dung vào `icons/portrait.png`.
SHA-256: `286746162824c676737a4ee341f7d28b7c5abeb5a06547d66318c4238a1e06b0`.
