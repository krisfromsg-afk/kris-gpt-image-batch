# ⚡ GPT Image Batch Pro

Batch image processing using ChatGPT gpt-image-2.

## Install

1. Clone/download folder
2. Open Chrome → `chrome://extensions`
3. Enable **Developer Mode** (top right)
4. Click **Load unpacked** → chọn folder
5. Done! Icon xuất hiện trên toolbar

## First Use

1. Đăng nhập ChatGPT Plus tại chatgpt.com
2. Mở extension → nhập License Key
3. Chọn ảnh → nhập prompt → Start Batch

## License Server (để bán key)

Cần deploy server riêng hoặc dùng:
- **Gumroad** license API
- **Lemon Squeezy** license API
- Tự build với Railway + Supabase

Thay URL trong `popup.js`:
const LICENSE_SERVER = 'https://your-server.com/verify';

## Dev Mode (test không cần server)
Nhập key: `DEV-TEST` để bypass license check.
