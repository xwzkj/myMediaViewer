import { after, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as ort from 'onnxruntime-node'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'media-manga-models-'))
process.env.MEDIA_DATA_DIR = dataDir
const { ensureMangaModels, missingModels, modelRoot } = await import('../server/ai/manga/models.js')
const { MangaOcrRecognizer } = await import('../server/ai/manga/recognizer.js')
after(() => rmSync(dataDir, { recursive: true, force: true }))

test('旧量化 encoder 不满足模型要求，自动下载固定 HuggingFace 文件并用于加载', async () => {
  const ocrDir = path.join(modelRoot, 'manga-ocr')
  mkdirSync(ocrDir, { recursive: true })
  writeFileSync(path.join(ocrDir, 'encoder_model_quantized.onnx'), 'legacy')
  assert.ok(missingModels().some(model => model.target.endsWith('encoder_model_fp16.onnx')))
  const urls: string[] = []
  const fetchMock = mock.method(globalThis, 'fetch', async (url: string) => {
    urls.push(url)
    return new Response('test model')
  })
  try {
    await ensureMangaModels()
    await ensureMangaModels()
    assert.equal(urls.length, 4)
    assert.ok(urls.some(url => url.endsWith('/onnx-community/manga-ocr-base-ONNX/resolve/main/onnx/encoder_model_fp16.onnx')))
    assert.ok(urls.every(url => !url.includes('encoder_model_quantized')))
    assert.deepEqual(missingModels(), [])
    assert.ok(existsSync(path.join(ocrDir, 'encoder_model_fp16.onnx')))
  } finally {
    fetchMock.mock.restore()
  }

  const loaded: string[] = []
  const createMock = mock.method(ort.InferenceSession, 'create', async (file: string) => {
    loaded.push(path.basename(file))
    return { inputNames: ['pixel_values'], outputNames: ['last_hidden_state'], release: async () => {} }
  })
  const recognizer = new MangaOcrRecognizer()
  try {
    await recognizer.load(ocrDir, { encoderProviders: ['cpu'] })
    assert.deepEqual(loaded, ['encoder_model_fp16.onnx', 'decoder_model_quantized.onnx'])
    await recognizer.release()
    createMock.mock.mockImplementation(async (file: string) => {
      loaded.push(path.basename(file))
      throw new Error('fp16 load failed')
    })
    await assert.rejects(recognizer.load(ocrDir), /fp16 load failed/)
    assert.equal(loaded.at(-1), 'encoder_model_fp16.onnx')
    assert.equal(loaded.length, 3)
  } finally {
    await recognizer.release()
    createMock.mock.restore()
  }
})
