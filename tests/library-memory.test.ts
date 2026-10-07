import test from 'node:test'
import assert from 'node:assert/strict'
import { ref, nextTick } from 'vue'
import { watchLibraryMemory } from '../src/library-memory.js'

test('首次进入来源立即保存；返回未改变的缓存来源也更新记忆', async () => {
  const route=ref('/source/first'), first=ref({view:'library',source:'first',sort:'newest'})
  let saved:unknown
  const save=(value:unknown)=>{saved=JSON.parse(JSON.stringify(value))}
  const stopA=watchLibraryMemory(()=>first.value,()=>route.value,()=>route.value==='/source/first',save)
  assert.equal((saved as any).source,'first')
  route.value='/source/last';await nextTick()
  const last=ref({view:'library',source:'last',sort:'newest'})
  const stopB=watchLibraryMemory(()=>last.value,()=>route.value,()=>route.value==='/source/last',save)
  try {
    assert.equal((saved as any).source,'last','新页面初始化时即应持久化，无需修改筛选')
    first.value.sort='oldest';await nextTick()
    assert.equal((saved as any).source,'last','后台缓存页不能覆盖当前来源')
    route.value='/source/first';await nextTick()
    assert.equal((saved as any).source,'first','回到缓存页面也应保存，即使来源值未改变')
    route.value='/source/last';await nextTick()
    assert.equal((saved as any).source,'last')
    route.value='/works/id';await nextTick()
    first.value.sort='title';last.value.sort='title';await nextTick()
    assert.equal((saved as any).source,'last','作品页不应改变最近来源')
  }finally{stopA();stopB()}
})

test('全部来源与收藏能够保存；存储失败不影响页面',async()=>{
  const route=ref('/library'),state=ref({view:'library',source:''})
  let saved=''
  const stop=watchLibraryMemory(()=>({...state.value}),()=>route.value,()=>true,v=>{saved=JSON.stringify(v)})
  try {
    assert.deepEqual(JSON.parse(saved),{view:'library',source:''})
    state.value={view:'favorites',source:'last'};route.value='/favorites?source=last';await nextTick()
    assert.deepEqual(JSON.parse(saved),{view:'favorites',source:'last'})
  }finally{stop()}
  assert.doesNotThrow(()=>{const dispose=watchLibraryMemory(()=>({source:'a'}),()=>'/source/a',()=>true,()=>{throw Error('quota')});dispose()})
})
