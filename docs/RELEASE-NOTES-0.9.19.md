# PhoneBox v0.9.19 (AI Coding & Dev Edition)

**English** · **Tiếng Việt** *(bên dưới / below)*

> Built upon [ersinkoc/phonebox](https://github.com/ersinkoc/phonebox) (**MIT License**).

---

## English

### Highlights (Extended Fork)
- **Hybrid Ultra-Low-Latency Touchpad + Admin UIPI Bypass:** Streams relative cursor movement & scrolling over Raw UDP `:8767` (Wi-Fi / Tailscale) and clicks/drag/keyboard over WebSocket (`60–120 Hz`), with Windows Administrator auto-elevation (`runas`) so cursor/clicks work inside **Administrator PowerShell**, **Task Manager**, and UAC windows.
- **System-Wide Android Floating Overlay Pill:** Persistent Mic + Touchpad toggle pill floating over Android Home and any other app.
- **2-Way PC ↔ Phone Audio:**
  - `PhoneMic` (`48 kHz mono`) → `VB-Audio Virtual Cable` (`CABLE Input`) with Android hardware AEC/NS/AGC.
  - `PhoneSpeaker` (`24 kHz WASAPI Loopback`) → phone speaker with automatic PC Silent Sink switching.
- **Live AI Coding Bridges:** Direct **Antigravity** & **Codex** conversation/project viewers, instant native Win32 **Voice Mode (`Ctrl+M`)** trigger, **Claude Code** permission prompts (`Allow`/`Deny`), and AI quota + GitHub PR/CI tracking.
- **Dynamic Media & FFT Visuals:** 48-band log-spaced FFT spectrum (`30 FPS`), Dynamic Mesh Gradient, **Realme Edge Lighting**, and **Liquid Wave**.
- **USB/ADB Priority Safeguards:** Enforces `ADB_LIBUSB=0` and protects PhoneBox foreground when coexisting with other ADB bridges.
- **New Brand Icon (`#10 - Floating Pill Pro`):** Unified icon for both `PhoneBoxAgent.exe` and the Android APK.

### Release Assets
1. **`PhoneBoxAgent-0.9.19-win-x64.zip`** — Self-contained Windows x64 Desktop Agent (no separate .NET runtime required; extract and run `PhoneBoxAgent.exe`).
2. **`PhoneBox-0.9.19.apk`** — Android panel app (`Android 5.0+` / recommended `Android 7+`).
3. **`SHA256SUMS-0.9.19.txt`** — SHA-256 verification checksums.

---

## Tiếng Việt

### Điểm nổi bật (Bản dành cho Dân Coding & AI Dev)
- **Touchpad lai độ trễ siêu thấp + Vượt quyền UIPI Admin:** Di chuyển/cuộn qua Raw UDP `:8767` (Wi-Fi / Tailscale) và click/kéo thả/phím qua WebSocket (`60–120 Hz`); tự động nâng quyền Administrator cho `PhoneBoxAgent.exe` để điều khiển xuyên qua **Administrator PowerShell**, **Task Manager** không bị Windows chặn.
- **Floating Overlay Pill toàn hệ thống:** Viên thuốc nổi đôi (Mic + Touchpad) bám trên màn hình Android kể cả khi thoát app PhoneBox.
- **Âm thanh 2 chiều PC ↔ Điện thoại:**
  - `PhoneMic` (`48 kHz mono`) → `VB-Audio Virtual Cable` có khử ồn/vang phần cứng.
  - `PhoneSpeaker` (`24 kHz WASAPI Loopback`) → phát loa điện thoại và tự động chuyển PC sang Silent Sink (`pcSilenced`).
- **Cầu nối AI Coding trực tiếp:** Xem luồng chat & đổi phiên **Antigravity**, **Codex** (`codex://`), kích hoạt nhanh **Voice Mode (`Ctrl+M`)** bằng native Win32, duyệt quyền **Claude Code** từ xa, theo dõi hạn mức AI và GitHub PR/CI.
- **Hiệu ứng nhạc FFT & Edge Lighting:** Phổ nhạc 48 dải tần (`30 FPS`), Mesh Gradient, **Realme Edge Lighting** và **Liquid Wave**.
- **Ưu tiên USB/ADB & Icon mới (`#10 - Floating Pill Pro`):** Giữ `ADB_LIBUSB=0`, bảo vệ foreground PhoneBox khi chạy song song bridge ADB khác, đồng bộ icon mới cho cả `.exe` và `.apk`.

### Tệp cài đặt đính kèm
1. **`PhoneBoxAgent-0.9.19-win-x64.zip`** — Bản chạy độc lập Windows x64 (đã kèm sẵn .NET, giải nén và chạy `PhoneBoxAgent.exe`).
2. **`PhoneBox-0.9.19.apk`** — Bộ cài app Android (`Android 5.0+`).
3. **`SHA256SUMS-0.9.19.txt`** — Mã băm SHA-256 đối chiếu tính toàn vẹn tệp.
