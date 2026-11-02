// ensure-extension-icon.js — khôi phục logo package của extension trước khi đóng gói.
//
// Bối cảnh (v0.8.14): quy trình snapshot-push của repo chỉ chở file text UTF-8,
// nên file binary images/icon.png không bao giờ lên được GitHub. Ai build
// extension từ source trên GitHub sẽ đóng gói ra vsix thiếu logo danh sách
// extension (package.json trường "icon" trỏ tới images/icon.png), VS Code
// hiện icon mặc định, tức là "mất logo". File text images/icon.png.base64
// mang theo đúng nội dung của icon.png nên snapshot-push chở được nó; script
// này khôi phục lại icon.png từ đó trước mọi lần vsce package.
//
// Cách dùng (bắt buộc, đa nền tảng, chỉ dùng built-in của Node):
//   node scripts/ensure-extension-icon.js
// Chạy từ bất kỳ thư mục nào cũng được (script tự tìm gốc extension qua
// __dirname). Thoát mã khác 0 kèm thông báo rõ ràng nếu không khôi phục
// được — đóng gói phải DỪNG LẠI chứ không được lén ra vsix thiếu logo.
//
// Hành vi:
//   - File base64 thiếu hoặc giải mã không ra PNG hợp lệ -> lỗi, thoát 1.
//   - images/icon.png thiếu hoặc nội dung khác với base64 đã giải mã -> ghi
//     lại từ base64 (ghi đè hoàn toàn, không sửa từng phần).
//   - Sau khi ghi (hoặc khi đã khớp sẵn), kiểm tra: file tồn tại, đúng chữ
//     ký PNG, chunk IHDR khai 128x128, và package.json trường "icon" vẫn
//     trỏ tới "images/icon.png". Kiểm tra nào hỏng cũng thoát 1.
//   - Artwork không thay đổi: script chỉ khôi phục đúng byte đã lưu trong
//     file base64, không vẽ lại, không đổi màu/hình.

'use strict';

const fs = require('fs');
const path = require('path');

function fail(message) {
  console.error(`ensure-extension-icon: LỖI: ${message}`);
  process.exit(1);
}

const extensionRoot = path.resolve(__dirname, '..');
const pngPath = path.join(extensionRoot, 'images', 'icon.png');
const base64Path = path.join(extensionRoot, 'images', 'icon.png.base64');
const packageJsonPath = path.join(extensionRoot, 'package.json');

if (!fs.existsSync(base64Path)) {
  fail(`không tìm thấy ${base64Path}. Không có nguồn base64 thì không thể khôi phục logo — dừng đóng gói, đừng ra vsix thiếu logo.`);
}

let expected;
try {
  const text = fs.readFileSync(base64Path, 'utf8');
  expected = Buffer.from(text.replace(/\s+/g, ''), 'base64');
} catch (err) {
  fail(`không đọc/giải mã được ${base64Path}: ${err.message}`);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function checkPng(buffer, label) {
  if (buffer.length < 24) {
    fail(`${label} quá ngắn (${buffer.length} byte), không phải PNG hợp lệ.`);
  }
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail(`${label} không có chữ ký PNG đúng.`);
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') {
    fail(`${label} không có chunk IHDR ở vị trí chuẩn.`);
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width !== 128 || height !== 128) {
    fail(`${label} có kích thước ${width}x${height}, kỳ vọng 128x128.`);
  }
}

checkPng(expected, `nội dung giải mã từ ${base64Path}`);

let current = null;
try {
  current = fs.readFileSync(pngPath);
} catch (err) {
  if (err.code !== 'ENOENT') {
    fail(`không đọc được ${pngPath}: ${err.message}`);
  }
}

if (current === null) {
  console.log('ensure-extension-icon: images/icon.png đang thiếu, khôi phục từ images/icon.png.base64…');
  fs.writeFileSync(pngPath, expected);
} else if (!current.equals(expected)) {
  console.log('ensure-extension-icon: images/icon.png hiện tại khác với base64 đã lưu, ghi lại từ base64…');
  fs.writeFileSync(pngPath, expected);
} else {
  console.log('ensure-extension-icon: images/icon.png đã khớp với base64, không cần ghi lại.');
}

// Kiểm tra lại từ file trên đĩa sau khi ghi (hoặc khi đã khớp sẵn).
let restored;
try {
  restored = fs.readFileSync(pngPath);
} catch (err) {
  fail(`không đọc lại được ${pngPath} sau khi khôi phục: ${err.message}`);
}
if (!restored.equals(expected)) {
  fail(`${pngPath} sau khi ghi vẫn khác với base64 đã lưu.`);
}
checkPng(restored, pngPath);

let packageJson;
try {
  packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
} catch (err) {
  fail(`không đọc được ${packageJsonPath}: ${err.message}`);
}
if (packageJson.icon !== 'images/icon.png') {
  fail(`package.json trường "icon" đang là ${JSON.stringify(packageJson.icon)}, kỳ vọng "images/icon.png".`);
}

console.log(`ensure-extension-icon: OK — images/icon.png đã sẵn sàng (${restored.length} byte, PNG 128x128), package.json trỏ đúng tới nó.`);
