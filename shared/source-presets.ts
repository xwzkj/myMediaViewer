import type { SourceRules } from './types.js'
import { pixivScript, telegramScript, customScript } from './preset-scripts.js'

export function sourcePreset(kind: 'pixiv' | 'telegram'): SourceRules {
  const pattern = kind === 'pixiv'
    ? String.raw`(?<sequence>\d+)-(?<id>\d+)(?:_p(?<page>\d+))?(?:-meta)?\.+[a-z0-9]+`
    : String.raw`(?<id>(?<sequence>\d+)_(?<month>\d{6}))(?:_p(?<page>\d+))?\.+[a-z0-9]+`
  return {
    version: 1, preset: kind, scope: 'source', duplicates: 'page',
    media: { mode: 'regex', pattern, caseSensitive: false, defaultPage: 0 },
    metadata: [{ mode: 'regex', pattern: pattern.replace('[a-z0-9]+', '(?:txt|json)'), caseSensitive: false }],
    typeOverrides: kind === 'pixiv' ? { webm: 'animation' } : {}, script: kind === 'pixiv' ? pixivScript : telegramScript
  }
}
export function customRules(): SourceRules {
  return { version: 1, scope: 'source', duplicates: 'all', typeOverrides: {},
    media: { mode: 'template', pattern: '{id}[_p{page}].{ext}', caseSensitive: false },
    metadata: [{ mode: 'template', pattern: '{id}.json', caseSensitive: false }],
    script: customScript }
}
