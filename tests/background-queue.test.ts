import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { BackgroundQueue } from '../server/background/queue.js'
import { normalizeSourceBackground } from '../shared/background.js'

test('background features are opt-in and limits are bounded', () => {
  const defaults=normalizeSourceBackground(undefined)
  assert.equal(defaults.watch,false); assert.equal(defaults.semantic,false); assert.equal(defaults.ocr,false); assert.equal(defaults.autoTranslate,false)
  assert.equal(defaults.localDutyPercent,25)
  const bounded=normalizeSourceBackground({watch:'true',watchIntervalSeconds:0,maxPagesPerDay:0,maxTranslationRequestsPerDay:Infinity,localDutyPercent:101})
  assert.equal(bounded.watch,false); assert.equal(bounded.watchIntervalSeconds,30); assert.equal(bounded.maxPagesPerDay,1); assert.equal(bounded.maxTranslationRequestsPerDay,20); assert.equal(bounded.localDutyPercent,100)
})
test('persistent queue deduplicates, keeps pause/stop and recovers interrupted work safely',()=>{
  const db=new DatabaseSync(':memory:')
  try {
    let q=new BackgroundQueue(db)
    const a=q.enqueue('s','a','v1','ocr'), b=q.enqueue('s','b','v1','translate')
    assert.equal(q.enqueue('s','a','v1','ocr'),a); assert.equal(q.counts('s').queued,2)
    q.setState('s','paused'); assert.equal(q.next('s'),undefined)
    q=new BackgroundQueue(db); assert.equal(q.control('s').state,'paused')
    q.setState('s','running'); q.mark(a,'running'); q.mark(b,'running')
    q=new BackgroundQueue(db)
    assert.equal(q.counts('s').queued,1); assert.equal(q.counts('s').failed,1,'ambiguous paid request must not retry automatically')
    q.setState('s','stopped'); assert.equal(q.next('s'),undefined); assert.equal(q.counts('s').stopped,1)
    q.enqueue('s','c','v1','semantic'); assert.equal(q.counts('s').stopped,2)
    q.setState('s','running'); assert.equal(q.counts('s').queued,2)
    q.retry('s'); assert.equal(q.counts('s').queued,3)
    q.enqueue('s','a','v2','ocr'); assert.equal(q.counts('s').queued,3,'changed fingerprint replaces stale pending version')
    q.removeDisabled('s',['semantic']); assert.equal(q.counts('s').queued,1)
  } finally { db.close() }
})
test('daily budgets are reserved atomically, persist, and reset on UTC day boundary',()=>{
  const db=new DatabaseSync(':memory:')
  try {
    const q=new BackgroundQueue(db), day=Date.parse('2026-10-25T23:59:59Z')
    assert.equal(q.reserve('s','requests',2,day),true); assert.equal(q.reserve('s','requests',2,day),true); assert.equal(q.reserve('s','requests',2,day),false)
    assert.equal(new BackgroundQueue(db).reserve('s','requests',2,day),false)
    q.setState('s','stopped'); q.setState('s','running'); assert.equal(q.usage('s',day).requests,2)
    assert.equal(q.reserve('s','requests',2,day+2000),true)
    assert.equal(q.reserve('s','pages',1,day),true); assert.equal(q.reserve('s','pages',1,day),false)
    assert.deepEqual({...q.usage('s',day)},{pages:1,requests:2})
    q.removeSource('s'); assert.equal(q.usage('s',day).requests,2)
  } finally {db.close()}
})
