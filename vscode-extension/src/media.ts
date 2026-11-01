// Tạo/sửa ảnh và video qua gateway, theo đúng shape thật trong
// src/Muse2Api/Endpoints.cs (không đoán):
//  - POST /v1/images/generations {prompt, model?, size?, n (1-4),
//    image?: string|string[] (tối đa 4 ảnh tham chiếu),
//    response_format: "url"|"b64_json"} — không async thì trả ngay
//    {created, data: [{url|b64_json, revised_prompt}]}.
//  - POST /v1/images/edits là multipart/form-data: field "image" hoặc
//    "image[]" (tối đa 4 tệp, mỗi tệp ≤ 20 MiB), "prompt", "n", "size",
//    "model", "response_format". Không hỗ trợ mask.
//  - POST /v1/videos {prompt, model?, size?, duration|seconds (1-60),
//    image|input_reference (first frame)} trả VideoTaskView
//    {id, status, progress, result, error}; poll GET /v1/videos/{id} cho
//    tới khi status là succeeded/failed/cancelled (BgTask.Finished).
//    result khi thành công: {url, mime, width, height}.
//  - GET /v1/media/{name} không yêu cầu auth trong code (MapGet không gọi
//    RequireApi), nhưng URL media có đuôi .png/.jpg/.mp4 theo mime nên
//    khi tải về giữ nguyên tên tệp đó.
// Model mặc định: bỏ trống thì gateway Resolve sang muse-image /
// muse-video (ModelRegistry.DefaultByKind).

import * as fs from 'fs';
import * as path from 'path';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export interface GeneratedImage { url?: string; b64?: string; revisedPrompt?: string; }
export interface GeneratedVideo { url: string; mime?: string; width?: number; height?: number; }

function originOf(baseUrl: string): string {
  return baseUrl.replace(/\/v1$/, '').replace(/\/+$/, '');
}

async function postJson(baseUrl: string, apiKey: string, pathSuffix: string, body: unknown): Promise<unknown> {
  const resp = await fetch(`${originOf(baseUrl)}/v1${pathSuffix}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) { throw new Error(`Gateway trả HTTP ${resp.status}: ${text.slice(0, 500)}`); }
  try { return JSON.parse(text) as unknown; } catch { throw new Error('Gateway trả về không phải JSON.'); }
}

async function getJson(baseUrl: string, apiKey: string, pathSuffix: string): Promise<unknown> {
  const resp = await fetch(`${originOf(baseUrl)}/v1${pathSuffix}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const text = await resp.text();
  if (!resp.ok) { throw new Error(`Gateway trả HTTP ${resp.status}: ${text.slice(0, 500)}`); }
  try { return JSON.parse(text) as unknown; } catch { throw new Error('Gateway trả về không phải JSON.'); }
}

export async function generateImages(
  baseUrl: string, apiKey: string,
  opts: { prompt: string; model?: string; size?: string; n: number; referenceDataUrls?: string[] },
): Promise<GeneratedImage[]> {
  if (!opts.prompt.trim()) { throw new Error('Cần nhập mô tả (prompt) để tạo ảnh.'); }
  if (opts.n < 1 || opts.n > 4) { throw new Error('Số ảnh n phải từ 1 đến 4 (giới hạn của gateway).'); }
  if ((opts.referenceDataUrls || []).length > 4) { throw new Error('Tối đa 4 ảnh tham chiếu.'); }
  const body: Record<string, unknown> = { prompt: opts.prompt, n: opts.n, response_format: 'url' };
  if (opts.model) { body.model = opts.model; }
  if (opts.size) { body.size = opts.size; }
  if (opts.referenceDataUrls && opts.referenceDataUrls.length > 0) { body.image = opts.referenceDataUrls; }
  const data = (await postJson(baseUrl, apiKey, '/images/generations', body)) as Record<string, unknown>;
  const arr = Array.isArray(data.data) ? data.data : [];
  return arr.map((item) => {
    const o = item as Record<string, unknown>;
    return { url: typeof o.url === 'string' ? o.url : undefined, b64: typeof o.b64_json === 'string' ? o.b64_json : undefined, revisedPrompt: typeof o.revised_prompt === 'string' ? o.revised_prompt : undefined };
  });
}

export async function editImage(
  baseUrl: string, apiKey: string,
  opts: { prompt: string; imagePaths: string[]; model?: string; size?: string; n: number },
): Promise<GeneratedImage[]> {
  if (!opts.prompt.trim()) { throw new Error('Cần nhập mô tả (prompt) để sửa ảnh.'); }
  if (opts.imagePaths.length < 1 || opts.imagePaths.length > 4) { throw new Error('Sửa ảnh cần 1 đến 4 ảnh gốc.'); }
  if (opts.n < 1 || opts.n > 4) { throw new Error('Số ảnh n phải từ 1 đến 4.'); }
  const form = new FormData();
  for (const p of opts.imagePaths) {
    const buf = fs.readFileSync(p);
    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) { throw new Error(`Ảnh ${path.basename(p)} phải khác rỗng và tối đa 20 MiB.`); }
    const ext = path.extname(p).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/png';
    form.append('image', new Blob([buf], { type: mime }), path.basename(p));
  }
  form.append('prompt', opts.prompt);
  form.append('n', String(opts.n));
  form.append('response_format', 'url');
  if (opts.model) { form.append('model', opts.model); }
  if (opts.size) { form.append('size', opts.size); }
  const resp = await fetch(`${originOf(baseUrl)}/v1/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const text = await resp.text();
  if (!resp.ok) { throw new Error(`Gateway trả HTTP ${resp.status}: ${text.slice(0, 500)}`); }
  const data = JSON.parse(text) as Record<string, unknown>;
  const arr = Array.isArray(data.data) ? data.data : [];
  return arr.map((item) => {
    const o = item as Record<string, unknown>;
    return { url: typeof o.url === 'string' ? o.url : undefined, b64: typeof o.b64_json === 'string' ? o.b64_json : undefined, revisedPrompt: typeof o.revised_prompt === 'string' ? o.revised_prompt : undefined };
  });
}

export async function createVideo(
  baseUrl: string, apiKey: string,
  opts: { prompt: string; model?: string; size?: string; duration?: number; firstFrameDataUrl?: string },
  onProgress: (status: string, progress: number) => void,
): Promise<GeneratedVideo> {
  if (!opts.prompt.trim()) { throw new Error('Cần nhập mô tả (prompt) để tạo video.'); }
  if (opts.duration !== undefined && (opts.duration < 1 || opts.duration > 60)) { throw new Error('Thời lượng video phải từ 1 đến 60 giây.'); }
  const body: Record<string, unknown> = { prompt: opts.prompt };
  if (opts.model) { body.model = opts.model; }
  if (opts.size) { body.size = opts.size; }
  if (opts.duration !== undefined) { body.duration = opts.duration; }
  if (opts.firstFrameDataUrl) { body.image = opts.firstFrameDataUrl; }
  const created = (await postJson(baseUrl, apiKey, '/videos', body)) as Record<string, unknown>;
  const taskId = String(created.id || '');
  if (!taskId) { throw new Error('Gateway không trả về id của video task.'); }
  const deadline = Date.now() + 15 * 60 * 1000;
  for (;;) {
    const task = (await getJson(baseUrl, apiKey, `/videos/${encodeURIComponent(taskId)}`)) as Record<string, unknown>;
    const status = String(task.status || '');
    onProgress(status, typeof task.progress === 'number' ? task.progress : 0);
    if (status === 'succeeded') {
      const result = (task.result || {}) as Record<string, unknown>;
      const url = String(result.url || '');
      if (!url) { throw new Error('Video task thành công nhưng không có URL kết quả.'); }
      return { url, mime: typeof result.mime === 'string' ? result.mime : undefined, width: typeof result.width === 'number' ? result.width : undefined, height: typeof result.height === 'number' ? result.height : undefined };
    }
    if (status === 'failed' || status === 'cancelled') {
      throw new Error(`Tạo video thất bại (task ${taskId}, trạng thái ${status}): ${JSON.stringify(task.error || '').slice(0, 500)}`);
    }
    if (Date.now() > deadline) { throw new Error(`Hết 15 phút chờ video task ${taskId} mà chưa xong. Task vẫn chạy trên gateway; bạn có thể kiểm tra lại bằng dashboard.`); }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

export async function downloadMedia(url: string, destDir: string, fallbackName: string): Promise<string> {
  fs.mkdirSync(destDir, { recursive: true });
  let name = fallbackName;
  try {
    const u = new URL(url);
    const base = path.basename(u.pathname);
    if (base && /^[A-Za-z0-9_\-]+\.[A-Za-z0-9]+$/.test(base)) { name = base; }
  } catch { /* giữ fallbackName */ }
  const dest = path.join(destDir, name);
  const resp = await fetch(url);
  if (!resp.ok) { throw new Error(`Không tải được media (HTTP ${resp.status}): ${url}`); }
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return dest;
}

export function dataUrlOfImageFile(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) { throw new Error(`Ảnh ${path.basename(filePath)} phải khác rỗng và tối đa 20 MiB.`); }
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}
