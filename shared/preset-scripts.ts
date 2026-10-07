// Self-contained user-editable scripts. Helpers are appended as source, never imported by the sandbox.
const helpers = String.raw`
// 以下是通用小工具；通常只需修改上面的 extract 中的字段映射。

// 同一组可能重复导出过：每种扩展名只取最新文件；时间相同时按路径稳定选择。
function latest(files, extension) {
  return files.filter(f => f.extension === extension)
    .sort((a, b) => b.modified - a.modified || a.relativePath.localeCompare(b.relativePath))[0];
}

// JSON 缺失/损坏时用空对象，让 TXT 仍可补齐；脚本不会读取任何额外文件。
function readJson(file) {
  try {
    const data = JSON.parse((file?.text || '').replace(/^\uFEFF/, ''));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

// 兼容不同下载器的字段别名，按顺序选第一个非空字符串/数字。
function pick(data, ...keys) {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

// 合并原标签、翻译标签和 TXT 标签，去掉 #、空标签及重复项。
function tags(...lists) {
  return [...new Set(lists.filter(Array.isArray).flat()
    .filter(tag => typeof tag === 'string').map(tag => tag.trim().replace(/^#/, '')).filter(Boolean))];
}

// 元文件可能包含 HTML 实体，例如 &#44;；保留原文本中的换行。
function decode(text) {
  return text.replace(/&#(x[0-9a-f]+|\d+);/gi, (raw, value) => {
    const code = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : raw;
  }).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

// JSON 简介经常是 HTML，转成适合显示/搜索的纯文本。
function plain(text) {
  return decode(text).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// JSON 日期只接受年-月-日开头，缺失时交给 TXT、预设回退或扫描器。
function jsonDate(data) {
  const date = pick(data, 'date', 'uploadDate');
  return /^\d{4}-\d{2}-\d{2}/.test(date) ? date : '';
}
`

export const pixivScript = String.raw`// Pixiv 预设：最新 JSON 优先，缺少的字段由最新 TXT 补齐。
// input.files 是本组匹配元文件的只读快照；input.media 是媒体文件描述。
// 修改下方 return 的字段映射即可定制，下面的小工具一般无需改动。
export async function extract(input) {
  const json = readJson(latest(input.files, 'json'));
  const txt = readSections(latest(input.files, 'txt')?.text || '');
  const id = pick(json, 'idNum', 'id');
  const original = pick(json, 'original', 'url', 'webUrl');
  // 下载器的 original 可能是图片/ZIP 地址，有作品 ID 时改为作品页面。
  const url = /^https?:\/\/(?:www\.)?pixiv\.net\/i\/\d+/.test(original)
    ? original : id ? 'https://www.pixiv.net/i/' + id : original;
  return {
    title: pick(json, 'title') || txt.Title || '',
    author: pick(json, 'user', 'userName', 'author') || txt.User || '',
    description: plain(pick(json, 'description')) || txt.Description || '',
    tags: tags(json.tags, json.tagsWithTransl, json.tagsTranslOnly, (txt.Tags || '').split('\n')),
    date: jsonDate(json) || txt.Date || '',
    originalUrl: url || txt.URL || ''
  };
}

// TXT 用 Title / User / Description 等标题分段；不能按空行切分，否则会丢失多段简介。
function readSections(text) {
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  const headings = [...text.matchAll(/^(ID|URL|Original|Thumbnail|xRestrict|AI|User|UserID|Title|Description|Tags|Size|Bookmark|Date)\n/gm)];
  const fields = {};
  headings.forEach((heading, index) => {
    const start = heading.index + heading[0].length;
    fields[heading[1]] = decode(text.slice(start, headings[index + 1]?.index ?? text.length).trim());
  });
  return fields;
}
` + helpers

export const telegramScript = String.raw`// Telegram 预设：最新 JSON 优先，缺少的字段由最新 TXT 补齐。
// TXT 第一行作为标题，全文作为简介，#标签 作为标签。
// 如果只有 TXT，JSON 相关字段会自动留空，无需改脚本。
export async function extract(input) {
  const json = readJson(latest(input.files, 'json'));
  const text = (latest(input.files, 'txt')?.text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  const description = plain(pick(json, 'description', 'desc', 'content'));
  // 分组 ID 示例：1201_202403。没有发布日期时使用该月第一天。
  const month = /^\d+_(\d{4})(\d{2})$/.exec(input.id);
  return {
    title: pick(json, 'title', 'name') || firstLine(description) || firstLine(text),
    author: pick(json, 'user', 'userName', 'author', 'channel'),
    description: description || text,
    tags: tags(json.tags, json.tagsWithTransl, json.tagsTranslOnly, text.match(/#[^\s#]+/gu) || []),
    date: jsonDate(json) || (month ? month[1] + '-' + month[2] + '-01' : ''),
    originalUrl: pick(json, 'original', 'url', 'webUrl')
  };
}

// 标题取第一条非空行，最多 100 字；完整内容仍保留在 description。
function firstLine(text) {
  return text.split('\n').find(line => line.trim())?.trim().slice(0, 100) || '';
}
` + helpers

export const customScript = String.raw`// 自定义示例：有 JSON 时取 JSON，否则使用媒体规则捕获的字段。
// 不需要元文件时，可删除全部元文件规则，脚本仍会执行。
export async function extract(input) {
  const media = input.media[0];
  const fields = media?.captures || {};
  const file = input.files.find(f => f.extension === 'json');
  const json = file ? JSON.parse(file.text) : {};

  // relativePath 始终提供，使用 / 分隔。也可以不增加规则，直接在这里解析：
  // const parts = (media?.relativePath || '').split('/');
  // const author = parts.length > 1 ? parts[0] : '';
  // media.directory / directoryName 分别是相对目录路径和直属目录名。
  return {
    title: json.title || fields.title || input.id,
    author: json.author || fields.author || '',
    description: json.description || '',
    tags: json.tags || [],
    date: json.date || '',
    originalUrl: json.originalUrl || ''
  };
}
`
