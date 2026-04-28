# ⚡ GPT Image Batch Pro

Batch image processing using ChatGPT gpt-image-2.

## Install (Dev / Test)

1. Clone/download folder
2. Open Chrome → `chrome://extensions`
3. Enable **Developer Mode** (top right)
4. Click **Load unpacked** → chọn folder
5. Done! Icon xuất hiện trên toolbar

## First Use

1. Đăng nhập ChatGPT Plus tại chatgpt.com
2. Mở extension → nhập License Key
3. Chọn ảnh → nhập prompt → Start Batch

## Dev Mode (test không cần license server)

Mở `config.js` → đặt `DEV_MODE: true` → extension sẽ bypass license check.

> ⚠️ **Trước khi submit Chrome Web Store:** đặt `DEV_MODE: false` trong `config.js`

## Production Build Checklist

- [ ] `config.js` → `DEV_MODE: false`
- [ ] `config.js` → `LICENSE_SERVER` trỏ đúng URL thật
- [ ] `config.js` → `GET_KEY_URL` trỏ đúng link bán key
- [ ] Thêm icon files: `icons/icon48.png` và `icons/icon128.png`
- [ ] Test lại toàn bộ flow trước khi submit

## License Server (để bán key)

Cần deploy server riêng hoặc dùng:
- **Gumroad** license API
- **Lemon Squeezy** license API
- Tự build với Railway + Supabase

Thay URL trong `config.js`:
```
LICENSE_SERVER: 'https://your-server.com/verify'
```
