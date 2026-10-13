import type { Work } from '../../shared/types.js'
import { sourceContainsPixivWorks } from '../../shared/source-identity.js'
import { sources } from '../config.js'

export function localPixivId(work: Pick<Work, 'sourceId' | 'sourceKind' | 'externalId'>): string | null {
  const source = sources.find(source => source.id === work.sourceId)
  const isPixiv = source ? sourceContainsPixivWorks(source) : work.sourceKind === 'pixiv'
  return isPixiv && /^[1-9]\d*$/.test(work.externalId) ? work.externalId : null
}
