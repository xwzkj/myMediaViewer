export type InferencePriority = 'manual' | 'background'
/** Non-preemptive: an executing native call completes, then manual work wins. */
export function createPriorityQueue() {
  type Entry = { priority:InferencePriority; run:()=>Promise<unknown>; resolve:(value:any)=>void; reject:(error:unknown)=>void; signal?:AbortSignal }
  const entries:Entry[]=[]
  let busy=false
  async function pump() {
    if (busy) return
    const manual=entries.findIndex(entry=>entry.priority==='manual')
    const entry=entries.splice(manual>=0?manual:0,1)[0]
    if (!entry) return
    busy=true
    try { entry.signal?.throwIfAborted(); entry.resolve(await entry.run()) }
    catch(error) {entry.reject(error)}
    finally {busy=false; void pump()}
  }
  return <T>(run:()=>Promise<T>,priority:InferencePriority='manual',signal?:AbortSignal):Promise<T> => new Promise((resolve,reject)=>{
    if (entries.length>=1000) {reject(new Error('计算队列已满，请稍后再试'));return}
    entries.push({run,priority,signal,resolve,reject});void pump()
  })
}
