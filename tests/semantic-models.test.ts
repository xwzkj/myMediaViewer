import { after, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 中文 CLIP 语义模型与漫画模型一样自动下载：
 * 目录由本进程的数据目录决定（主服务 / 计算端各用自己的），不需要环境变量。
 */
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'media-clip-models-'))
process.env.MEDIA_DATA_DIR = dataDir
delete process.env.SEMANTIC_CLIP_MODEL_DIR
const { clipModelRoot, ensureClipModels, missingClipModels, requiredClipModels } = await import('../server/semantic/models.js')
const { LocalClipProvider } = await import('../server/semantic/provider.js')
after(() => rmSync(dataDir, { recursive: true, force: true }))

test('语义模型按数据目录自动下载，重复调用不重复请求', async () => {
  assert.equal(clipModelRoot, path.join(dataDir, 'models', 'chinese-clip-vit-b16'), '默认目录跟随 MEDIA_DATA_DIR')
  assert.equal(missingClipModels().length, 2, '全新环境两个文件都缺')

  const urls: string[] = []
  const progress: Array<{ target: string; received: number; total: number }> = []
  const fetchMock = mock.method(globalThis, 'fetch', async (url: string) => {
    urls.push(url)
    return new Response('model-bytes')
  })
  try {
    await ensureClipModels(clipModelRoot, item => progress.push(item))
    assert.deepEqual(missingClipModels(), [])
    assert.equal(urls.length, 2)
    assert.ok(urls.every(url => url.startsWith('https://huggingface.co/Xenova/chinese-clip-vit-base-patch16/resolve/main/')), JSON.stringify(urls))
    assert.ok(urls.some(url => url.endsWith('/onnx/model_quantized.onnx')), '使用量化权重控制下载体积')
    assert.ok(progress.length >= 2)
    for (const spec of requiredClipModels()) assert.ok(existsSync(path.join(clipModelRoot, spec.target)), spec.target)

    const before = urls.length
    await ensureClipModels(clipModelRoot)
    assert.equal(urls.length, before, '已就位的文件不再下载')
  } finally {
    fetchMock.mock.restore()
  }
})

test('下载失败时给出可操作原因，且不留下半成品文件', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clip-fail-'))
  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('nope', { status: 503 }))
  try {
    await assert.rejects(ensureClipModels(root), /HF_ENDPOINT/)
    assert.equal(existsSync(path.join(root, 'model.onnx')), false)
    assert.deepEqual(readdirSync(root).filter(name => name.endsWith('.part')), [], '临时文件必须清理')
  } finally {
    fetchMock.mock.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('模型缺失时状态可读、错误可重试，绝不伪造向量', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clip-status-'))
  const fetchMock = mock.method(globalThis, 'fetch', async () => { throw new Error('network down') })
  try {
    const provider = new LocalClipProvider({ directory: root })
    const status = await provider.status()
    assert.equal(status.ready, false)
    assert.equal(status.provider, 'local')
    assert.match(String(status.message), /语义模型/)
    await assert.rejects(provider.embedText('a cat'), { code: 'semantic_model_download' })
    // 失败后状态仍要可读：给出下载失败原因，并允许用户稍后重试（冷却期后自动重试）。
    const again = await provider.status()
    assert.equal(again.ready, false)
    assert.match(String(again.message), /下载|network down/)
  } finally {
    fetchMock.mock.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('下载进行中时状态立刻返回进度标记，而不是阻塞或报错', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clip-progress-'))
  // 让下载永远停在等待中：状态查询必须仍然立刻返回。
  const fetchMock = mock.method(globalThis, 'fetch', () => new Promise<Response>(() => {}))
  try {
    const provider = new LocalClipProvider({ directory: root })
    const started = Date.now()
    const status = await provider.status()
    assert.ok(Date.now() - started < 1000, '状态查询不能被下载阻塞')
    assert.equal(status.ready, false)
    assert.equal(status.downloading, true)
    assert.match(String(status.message), /语义模型/)
  } finally {
    fetchMock.mock.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('禁用本地 CLIP 时立即不可用，且不触发任何下载', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => { throw new Error('should not download') })
  try {
    const provider = new LocalClipProvider({ directory: null })
    const status = await provider.status()
    assert.equal(status.ready, false)
    assert.equal(status.provider, 'unavailable')
    assert.equal(fetchMock.mock.callCount(), 0)
  } finally {
    fetchMock.mock.restore()
  }
})
