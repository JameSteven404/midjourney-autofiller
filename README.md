# Midjourney Prompt Auto-Filler 1.4.2

## 1.4.2 (16/09/2026) — nghi vấn ảnh ngoài khung nhìn không được nhận là đã xong

Người dùng báo trực tiếp: ảnh đã tạo xong trên Midjourney nhưng tool vẫn báo "Đang tạo", và vì vậy không tự tải ảnh về (điều kiện tự tải đứng sau việc job phải chuyển "Xong"). Hai triệu chứng này cùng gốc: `checkPendingJobs()` không khớp được lưới kết quả với prompt đã gửi thì job không bao giờ qua khỏi "Đang tạo", nên `autoDownload` cũng không có gì để tải.

**Chưa xác nhận được nguyên nhân gốc trên 1 batch thật** (cần thời gian tạo ảnh thật + tài khoản thật, không mô phỏng được bằng Node) — nghi vấn hàng đầu, theo gợi ý đối chiếu với cách các tool tự động hoá khác xử lý: Midjourney nhiều khả năng **ảo hoá/lazy-load ảnh nằm ngoài khung nhìn** hiện tại của trang — lưới kết quả của job nếu rơi ngoài viewport có thể không bao giờ thực sự tải/render `<img>` trong DOM, khiến điều kiện `gridIsFullyLoaded()` (đòi hỏi mọi ảnh trong lưới có `src` CDN thật + `naturalWidth > 0`) không bao giờ đúng.

- **Tự thu nhỏ zoom tab Midjourney xuống 50%** (`chrome.tabs.setZoom`, quyền `tabs` đã có sẵn) trong suốt lúc hàng đợi đang chạy, để nhiều lưới kết quả cùng lúc "lọt" vào khung nhìn hơn; khôi phục lại zoom gốc của trình duyệt ngay khi dừng/tạm dừng/lỗi (mọi nhánh thoát của `processQueue`).
- **Thêm cảnh báo chẩn đoán cụ thể sau 90 giây** chưa khớp được job (thay vì im lặng tới hết 30 phút mới báo "Cần kiểm tra" chung chung): log phân biệt rõ "không tìm thấy lưới kết quả nào" / "có lưới nhưng không đọc được nội dung prompt" / "có lưới đọc được prompt nhưng không cái nào khớp" / "khớp đúng lưới nhưng ảnh bên trong chưa được coi là tải xong" — để biết chính xác selector nào (`mediaGrid`, `promptText`, hay điều kiện tải ảnh) đang lệch với giao diện Midjourney thật, nếu zoom không giải quyết dứt điểm.
- Thêm 6 kiểm thử cho phần chẩn đoán và zoom.

Cần chạy thử trên batch thật để xác nhận: (1) zoom 50% có đủ để lưới kết quả luôn vào khung nhìn không — có thể cần chỉnh `RESULT_GRID_ZOOM` trong background.js nếu chưa đủ, (2) zoom không làm lệch toạ độ click của chế độ Debug/CDP (theo lý thuyết không lệch vì `getBoundingClientRect()` và `Input.dispatchMouseEvent` cùng nằm trong không gian viewport đã zoom, nhưng chưa tự kiểm chứng trực tiếp).

## 1.4.1 (16/09/2026) — dọn rác, sửa lệch regex, bắt đầu dùng git

Đợt review code cùng Claude Code, không đổi hành vi gửi/tải prompt:

- **`{prompt}` bỏ sót đuôi tham số khi gạch ngang bị tự động co lại**: `promptWithoutParams` trước chỉ nhận đúng 2 ký tự gạch ngang để cắt phần `--ar 16:9 --seed …`, trong khi `seedFromPrompt` đã nhận 1-2 ký tự từ bản 1.4.0 (Excel/Word có thể tự co `--` thành 1 gạch ngang dài `–`). Lệch nhau nên gặp đúng trường hợp đó, `{seed}` vẫn lấy đúng nhưng `{prompt}` bị dính cả đuôi tham số. Đã đồng bộ về `{1,2}` cho cả hai. Thêm kiểm thử riêng cho trường hợp này.
- **`state.downloads` không bao giờ được dọn**: mỗi ảnh tải xong thêm một bản ghi tồn tại vĩnh viễn, kể cả sau khi xoá prompt khỏi hàng đợi hoặc bấm "Xoá hàng đợi" — tích tụ vô hạn theo `chrome.storage.local` (giới hạn 10MB, tiện ích chưa xin quyền `unlimitedStorage`), làm mỗi lần đọc/ghi/broadcast state chậm dần theo thời gian dùng. Giờ bản ghi tải bị xoá theo đúng lúc item chủ của nó rời khỏi hàng đợi (xoá từng mục, Xoá mục đã xong, Xoá hàng đợi), và tự dọn một lần lúc khởi động cho phần đã tồn đọng từ trước bản vá này.
- Bỏ handler `SET_ITEMS` trong background.js — không còn nơi nào trong tiện ích gửi message này.
- Bắt đầu quản lý version bằng git (trong chính thư mục này) thay vì tự nén `.zip`/`.rar` thủ công; lịch sử các bản trước đó đã được phục hồi lại từ các bản nén cũ.

## 1.4.0 (15/09/2026) — đổi tên file theo seed

Ở bản 1.3.2 tôi kết luận nhầm rằng Midjourney không lộ seed. Thực tế **seed nằm ngay trong chính prompt** dưới dạng tham số `--seed 52000101` (đúng SOP đang dùng), và Midjourney hiển thị nó thành chip "seed 52000101" cạnh "ar 16:9"/"hd". Lần kiểm tra trước tôi soi nhằm các job không có tham số `--seed` nên không thấy gì.

Vì seed nằm trong prompt mà tiện ích tự gửi đi, nó **không cần đọc DOM** — lấy thẳng từ prompt là chính xác tuyệt đối:

- Thêm biến `{seed}`, lấy bằng `--seed <số>` trong prompt (chấp nhận cả gạch ngang `-`, `–`, `—`).
- **Mẫu mặc định đổi thành `{index}_{seed}_{n}`** → `001_52000101_1` … `001_52000101_4`, `002_…`. Mẫu cũ `{index}_{n}` của người dùng cũ được tự nâng cấp một lần; mẫu tự đặt thì giữ nguyên.
- Prompt không có `--seed` thì phần seed **tự lược bỏ gọn gàng**: `001_1` chứ không phải `001__1`.
- `{prompt}` nay cắt bỏ phần tham số (`--ar 16:9 --seed …`), chỉ giữ nội dung mô tả.
- Ô xem trước tên file đọc seed thật từ prompt đầu tiên trong hàng đợi thay vì số minh hoạ.
- Thêm 3 kiểm thử: trích seed từ đúng prompt SOP thật, thu gọn khi thiếu seed, và `{prompt}` loại bỏ cờ tham số.

## 1.3.2 (15/09/2026) — sửa dropdown

**Dropdown trắng xoá không đọc được**: `select` được cho nền trắng bán trong suốt (`rgba(255,255,255,0.05)`). Popup danh sách do hệ điều hành vẽ không hiểu màu bán trong suốt — nó ghép lên nền trắng thành trắng đục, trong khi chữ vẫn màu trắng → gần như vô hình, chỉ thấy dòng đang chọn nhờ vệt highlight. Đã thêm màu đặc riêng (`--field-solid`) cho `select` và `option` ở cả nền sáng lẫn tối.

Bản này cũng bổ sung `{job}` (12 ký tự đầu của ID job) và `{jobfull}` (ID job đầy đủ) lấy từ link CDN, đối chiếu được bằng cách mở `midjourney.com/jobs/<id>`.

*Ghi chú: bản 1.3.2 từng kết luận nhầm là không lấy được seed — xem lại ở mục 1.4.0.*

# Midjourney Prompt Auto-Filler 1.3.1

## 1.3.1 (15/09/2026) — giao diện theo phong cách Apple

Viết lại toàn bộ `sidepanel.css` theo ngôn ngữ thiết kế của Apple (Human Interface Guidelines), giữ nguyên toàn bộ class/id nên không đụng tới logic:

- **Chữ**: font hệ thống SF Pro (`-apple-system`), letter-spacing âm nhẹ ở tiêu đề, `font-variant-numeric: tabular-nums` cho số thứ tự và thời gian để không nhảy cột.
- **Màu**: bảng màu hệ thống iOS/macOS (systemPurple, systemGreen, systemOrange, systemRed, systemTeal) với nhãn phân 3 cấp độ. **Tự đổi sáng/tối theo hệ điều hành** qua `prefers-color-scheme`.
- **Chất liệu**: thanh tiêu đề và thanh hành động dính (sticky) dùng hiệu ứng kính mờ `backdrop-filter: saturate(180%) blur(20px)`; modal có nền mờ phía sau.
- **Điều khiển**: tab dạng segmented control kiểu iOS, nút bo tròn hoàn toàn (pill), công tắc kiểu iOS với hiệu ứng trượt mềm, vòng focus màu nhấn, thanh cuộn mảnh kiểu macOS.
- **Hoạt ảnh**: dùng đường cong `cubic-bezier(0.32, 0.72, 0, 1)` của Apple — thẻ trượt lên khi mở tab (so le nhau), mục hàng đợi xuất hiện lần lượt, nút thu nhỏ nhẹ khi bấm, nhãn "Đang gửi/Đang tạo" thở nhẹ, thanh tiến độ chuyển mượt kèm gradient chạy. Tôn trọng `prefers-reduced-motion`.

## 1.3.0 (15/09/2026) — sửa dứt điểm tên file, đánh số theo SOP, cải thiện UI

**Nguyên nhân thật của lỗi tên file/thư mục con** (đo được bằng nút "Chẩn đoán tải file"): yêu cầu tải favicon Google với tên `midjourney-output/_diag_test_….ico` nhưng Brave lưu thành `C:\Users\Admin\Downloads\favicon.ico`. Tức là trình duyệt bỏ qua `filename` với **mọi** file, không riêng link CDN Midjourney.

`filename` truyền vào `downloads.download()` chỉ là **gợi ý ban đầu**; quyết định cuối cùng thuộc về sự kiện `downloads.onDeterminingFilename`. Nếu một tiện ích khác (trình quản lý tải…) đăng ký sự kiện này và gọi `suggest()` mặc định thì gợi ý của mình bị ghi đè — tiện ích này trước đây chưa hề đăng ký sự kiện đó nên luôn thua. Bản 1.3.0 đăng ký `onDeterminingFilename` và khẳng định lại tên ngay trong bước quyết định (có nhánh dự phòng tra lại storage khi service worker vừa khởi động lại), đồng thời nhường quyền cho trình duyệt với các lượt tải không phải của mình.

Nếu vẫn bị ghi đè (do tiện ích khác được cài sau giành quyền), side panel sẽ hiện **cảnh báo ngay tại tab Điều khiển** kèm tên yêu cầu và tên thực tế, thay vì chỉ ghi log rồi báo "thành công" như trước.

- **Đánh số theo SOP**: tên file mặc định `001_1 → 001_4`, `002_1 → 002_4` — `{index}` là số thứ tự prompt theo đúng thứ tự dòng Excel/hàng đợi, `{n}` là số ảnh trong prompt. Số thứ tự gắn cố định lúc thêm vào hàng đợi, không đổi khi xoá bớt mục hay chạy lại.
- **Mẫu tên file tuỳ chỉnh** với biến `{index} {n} {seq} {date} {time} {prompt} {job}`, kèm ô "Số bắt đầu" và xem trước tên file ngay khi gõ.
- **UI**: thanh tiến độ, số thứ tự hiển thị trên từng mục hàng đợi (khớp với tên file), nút "Thử lại mục lỗi" và "Xoá mục đã xong", các nút tự khoá khi không dùng được.
- Thêm 4 kiểm thử tự động cho đúng lớp lỗi này (khẳng định tên trong `onDeterminingFilename`, nhường lượt tải lạ, đánh số bền vững khi xoá mục, 4 ảnh cùng prompt giữ đúng số).

---

# Midjourney Prompt Auto-Filler 1.2.4

Bản cập nhật ngày 14/09/2026: dùng Debug/CDP làm chế độ mặc định, tối ưu bộ theo dõi và hàng đợi, bổ sung báo cáo. Giữ các sửa lỗi tải ảnh/giới hạn prompt và icon của bản 1.1.0.

Bản 1.2.1 (15/09/2026): khôi phục việc chuyển ảnh sang **.png** trước khi tải — bản 1.2.0 đã đổi sang giữ nguyên đuôi gốc (.webp) khi chuyển sang tải trực tiếp từ link CDN. Việc chuyển đổi giờ chạy trong một **offscreen document** riêng của extension (`offscreen.html`/`offscreen.js`, quyền `offscreen`) thay vì trong content script: vẫn giữ được độ tin cậy của việc tải thẳng link CDN thật (không bị Chrome Safe Browsing treo thành `.tmp` như link `data:`/`blob:` tạo trong service worker trước đây), đồng thời không phụ thuộc tab Midjourney/content script còn sống — nút "Tải ảnh còn thiếu" vẫn chuyển đúng sang PNG kể cả sau khi đã đóng tab hoặc extension vừa khởi động lại. Nếu chuyển đổi thất bại (ảnh hỏng, mạng lỗi...), tự động tải theo đúng định dạng gốc và ghi log lỗi rõ ràng thay vì bỏ ảnh.

Bản 1.2.2 (15/09/2026), sửa theo phản hồi từ lần chạy thử thật đầu tiên:

- **Bảng cài đặt Midjourney không đóng lại được**: đã kiểm chứng trực tiếp trên trang thật — Escape (kể cả gửi qua CDP, `isTrusted:true`) **không** đóng được bảng cài đặt thật của Midjourney (khác với fixture tự dựng trong bộ test cũ). Chỉ bấm ra ngoài mới đóng được. Đổi sang bấm ra ngoài (`clickOutside`, chọn góc màn hình không dính ảnh/link để tránh điều hướng nhầm) ngay sau khi áp cài đặt xong, có xác minh đã đóng và thử lại tối đa 3 lần.
- **Có thể là nguyên nhân chính gây tràn quá số "Prompt đồng thời" đã đặt (Midjourney giới hạn 13 job)**: bổ sung ngưỡng thời gian tối thiểu 8 giây trước khi chấp nhận 1 job là "xong" (Midjourney không thể xong nhanh hơn vậy), cộng thêm yêu cầu cùng một lưới ảnh phải khớp ổn định qua ít nhất 1.5 giây trước khi xác nhận — chặn các trường hợp khớp nhầm/ảnh xem trước tạm thời khiến hàng đợi tưởng đã xong quá sớm rồi gửi dồn dập, vượt số job đồng thời thật dù đã đặt thấp trong tool.
- **Tên file tải về**: đổi lại theo mốc thời gian ảnh tạo xong (`YYYYMMDD-HHMMSS_prompt.png`) thay vì theo ID ngẫu nhiên của lần gửi; tải lại ảnh lỗi vẫn ra tên gốc (Chrome tự thêm hậu tố nếu trùng).
- **Định vị tab đích**: khi tab đang gắn bị đóng, tự gỡ gắn kết thay vì báo "đã gắn" với 1 tab không còn tồn tại; "Gắn tab đang mở" giờ tìm cả các cửa sổ khác nếu tab đang xem không phải Midjourney; kiểm tra tab còn tồn tại và đúng URL ngay trước khi chạy hàng đợi, báo lỗi rõ ràng thay vì lỗi khó hiểu nếu tab đã đóng.
- **Ô nhập prompt** tự giãn theo độ dài nội dung (thay vì cố định 5 dòng).
- **Prompt đồng thời** và **Thời gian chờ ngẫu nhiên** chuyển từ tab Cài đặt sang tab Điều khiển chính, hiển thị 2 cột.

Chưa tự xác minh trực tiếp trên 1 batch thật nhiều prompt (cần thời gian tạo ảnh thật, không mô phỏng được bằng Node) — cần chạy thử lại để xác nhận số job đồng thời thật không còn vượt mức đã đặt.

Bản 1.2.3 (15/09/2026): bản 1.2.2 vẫn không đóng được bảng cài đặt trên thực tế (log thật cho thấy y hệt lỗi cũ, lặp lại mỗi lần chạy). Tìm ra 2 lỗi trong cách đóng panel của 1.2.2, cả hai đã kiểm chứng trực tiếp trên tab Midjourney thật:

1. Việc chọn điểm "bấm ra ngoài" chỉ thử đúng 4 góc màn hình cố định; nếu cả 4 góc đó đã bị ảnh trong lưới kết quả che (trang càng nhiều ảnh thì càng dễ xảy ra) thì code **âm thầm bấm đại vào góc dưới-phải** thay vì báo lỗi — có thể trúng ảnh, không đóng được panel mà cũng không hiện lỗi rõ ràng. Đổi sang nhận diện đúng lớp phủ dùng để đóng panel (một `div` `position:fixed` phủ gần toàn bộ khung nhìn, không phải bằng cách loại trừ ảnh/link) và quét một lưới điểm rộng hơn (5x5) thay vì 4 góc.
2. Bước xác minh "đã đóng chưa" kiểm tra sai: nút tuỳ chọn đã chọn (vd. "Landscape") **vẫn còn trong DOM** kèm class đã chọn ngay cả khi panel đã đóng thật (Midjourney chỉ ẩn đi, không gỡ khỏi trang) — nên dù bấm đóng thành công, code vẫn tưởng panel còn mở, báo lỗi "Không đóng được bảng cài đặt" và dừng hàng đợi. Đổi sang kiểm tra hiển thị thật (kích thước/vị trí trên trang) thay vì chỉ kiểm tra có mặt trong DOM.

## Bỏ chuyển đổi PNG (1.2.4) — ưu tiên đúng tên file + thư mục con

Sau khi khôi phục bước chuyển `.webp` sang `.png` (qua offscreen document, bản 1.2.1), người dùng test thật vẫn thấy ảnh tải về mang **tên UUID ngẫu nhiên**, nằm thẳng ở Downloads gốc, không vào thư mục con — dù code gửi đúng `filename` (kèm thư mục con) cho `chrome.downloads.download()`.

Nguyên nhân xác định được: `chrome.downloads.download()` **bỏ qua tham số `filename`** (gồm cả phần thư mục con) khi `url` truyền vào là `blob:` hoặc `data:` — Chrome tự đặt tên file theo UUID nội bộ của chính blob/data đó, không dùng tên đã chỉ định. Tham số này chỉ được tôn trọng đúng khi `url` là một link `https://` thật. Đây là giới hạn của Chrome, không phải lỗi trong extension — đã xảy ra giống hệt với cả hai cách thử (`data:` URL ở bản đầu, `blob:` URL qua offscreen document ở bản 1.2.1), củng cố kết luận này.

Người dùng chọn ưu tiên đặt tên file + thư mục con đúng thay vì giữ định dạng .png. Bản 1.2.4 bỏ hẳn bước chuyển đổi PNG (xoá `offscreen.html`/`offscreen.js`, quyền `offscreen`) — tải thẳng link CDN `https://` thật, giữ nguyên định dạng ảnh gốc (`.webp` trong hầu hết trường hợp). Tên file theo mốc thời gian ảnh tạo xong + prompt, đúng thư mục con đã đặt trong Cài đặt.

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
