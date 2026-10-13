import type { Source } from './types.js'

/** Explicit choice wins; old Pixiv sources and presets keep their existing identity. */
export function sourceContainsPixivWorks(source: Pick<Source, 'kind' | 'rules' | 'pixivWorks'>): boolean {
  return source.pixivWorks ?? (source.kind === 'pixiv' || source.rules?.preset === 'pixiv')
}
