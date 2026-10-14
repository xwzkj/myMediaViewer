import { createHash } from 'node:crypto'
import { PixivApiError } from './errors.js'

// CeuiLiSA/Pixiv-Shaft: loxia/HeaderInterceptor.kt and PixivHeaders.kt.
export const PIXIV_USER_AGENT = 'PixivIOSApp/7.13.4 (iOS 16.0.3; iPhone13,3)'
export const PIXIV_API_ORIGIN = 'https://app-api.pixiv.net'
const HASH_SECRET = '28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c'

export function pixivHeaders(now = new Date()): Record<string, string> {
  const time = now.toISOString().replace(/\.\d{3}Z$/, '+00:00')
  return {
    Accept: 'application/json',
    'Accept-Language': 'zh-CN',
    'app-os': 'ios',
    'app-os-version': '16.0.3',
    'app-version': '7.13.4',
    'User-Agent': PIXIV_USER_AGENT,
    'x-client-time': time,
    'x-client-hash': createHash('md5').update(time + HASH_SECRET).digest('hex'),
  }
}

export function pixivApiUrl(value: string): URL {
  let url: URL
  try { url = new URL(value, PIXIV_API_ORIGIN) }
  catch { throw new PixivApiError('不允许访问该 Pixiv 地址', 400, 'invalid_url') }
  if (url.origin !== PIXIV_API_ORIGIN || url.username || url.password || url.hash) {
    throw new PixivApiError('不允许访问该 Pixiv 地址', 400, 'invalid_url')
  }
  return url
}

export function pixivIllustId(value: string): string {
  if (!/^[1-9]\d*$/.test(value)) throw new PixivApiError('Pixiv 作品 ID 无效', 400, 'invalid_id')
  return value
}

/** 画师 ID 与作品 ID 同规则：严格纯数字，不做字符剥离。 */
export function pixivUserId(value: string): string {
  if (!/^[1-9]\d*$/.test(value)) throw new PixivApiError('Pixiv 画师 ID 无效', 400, 'invalid_id')
  return value
}

export function pixivPageUrl(value: string, firstPage: string): string {
  const url = pixivApiUrl(value)
  const expected = pixivApiUrl(firstPage)
  if (url.pathname !== expected.pathname) throw new PixivApiError('分页游标与当前接口不匹配', 400, 'invalid_cursor')
  for (const [key, item] of expected.searchParams) {
    if (['word', 'sort', 'search_target', 'illust_id', 'user_id', 'restrict', 'type'].includes(key) && url.searchParams.get(key) !== item) throw new PixivApiError('分页游标与当前查询不匹配', 400, 'invalid_cursor')
  }
  return url.toString()
}
