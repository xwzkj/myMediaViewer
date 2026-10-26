import { db } from './database.js'
import {
  defaultLibraryState,
  isLibraryScope,
  normalizeLibraryState,
  type LibraryScope,
  type LibraryStateMap,
} from '../shared/library-state.js'

interface StateRow { scope: string; data: string }

function assignScope<S extends LibraryScope>(map: LibraryStateMap, scope: S, value: LibraryStateMap[S]): void {
  map[scope] = value
}

/** 读取全部浏览偏好；缺失或损坏的 scope 一律回退默认值。 */
export function readStoredLibraryState(): LibraryStateMap {
  const state = defaultLibraryState()
  for (const row of db.prepare('SELECT scope, data FROM library_state').all() as unknown as StateRow[]) {
    if (!isLibraryScope(row.scope)) continue
    try {
      assignScope(state, row.scope, normalizeLibraryState(row.scope, JSON.parse(row.data)))
    } catch { /* 单条损坏不拖垮其它 scope，也绝不编造用户没选过的值。 */ }
  }
  return state
}

/** 规范化并写入单个 scope；返回落库后的值，客户端无需再猜测默认值。 */
export function saveStoredLibraryStateScope(scope: LibraryScope, value: unknown): LibraryStateMap[LibraryScope] {
  const normalized = normalizeLibraryState(scope, value)
  db.prepare('INSERT INTO library_state (scope, data, updated) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET data = excluded.data, updated = excluded.updated')
    .run(scope, JSON.stringify(normalized), Date.now())
  return normalized
}
