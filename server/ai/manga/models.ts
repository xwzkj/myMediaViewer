/**
 * 漫画识别模型的下载与就位。
 *
 * 模型文件来自以下 HuggingFace 仓库：
 *  - comic-text-detector（dmMaze/comic-text-detector 的 ONNX 导出）
 *  - manga-ocr-base（kha-white/manga-ocr-base 的 ONNX 导出）
 *
 * 下载实现放在 `server/ai/model-files.ts`，与 CLIP 语义模型共用；这里只描述
 * 漫画需要的文件清单与默认目录。
 */
import path from 'node:path'
import {
  downloadModel as downloadFile, ensureModels, hasModel as fileExists, missingModels as missingFiles,
  modelPath as resolveModelPath, type DownloadProgress, type ModelSpec,
} from '../model-files.js'

export type { DownloadProgress, ModelSpec }

/**
 * 模型根目录。默认 `data/models`（与媒体数据同目录），可用 MANGA_MODEL_DIR 单独指定；
 * 计算端通常指向自己的模型目录。所有函数都接受显式 root，方便测试与双端复用。
 */
export const modelRoot = path.resolve(
  process.env.MANGA_MODEL_DIR || path.join(process.env.MEDIA_DATA_DIR || 'data', 'models'),
)

export const detectorModel: ModelSpec = {
  target: 'comic-text-detector/comic-text-detector.onnx',
  repo: 'mayocream/comic-text-detector-onnx',
  file: 'comic-text-detector.onnx',
}

/** 所有平台共用的 fp16 encoder。 */
export const encoderFp16Model: ModelSpec = {
  target: 'manga-ocr/encoder_model_fp16.onnx',
  repo: 'onnx-community/manga-ocr-base-ONNX',
  file: 'onnx/encoder_model_fp16.onnx',
}

export const decoderModel: ModelSpec = {
  target: 'manga-ocr/decoder_model_quantized.onnx',
  repo: 'onnx-community/manga-ocr-base-ONNX',
  file: 'onnx/decoder_model_quantized.onnx',
}

/** 词表是纯文本，一行一个 token，共 6144 个。 */
export const vocabModel: ModelSpec = {
  target: 'manga-ocr/vocab.txt',
  repo: 'kha-white/manga-ocr-base',
  file: 'vocab.txt',
}

/** 首次翻译必须就位的文件：检测模型 + fp16 encoder + decoder + 词表。 */
export function requiredModels(): ModelSpec[] {
  return [detectorModel, encoderFp16Model, decoderModel, vocabModel]
}

export function modelPath(spec: ModelSpec, root = modelRoot): string {
  return resolveModelPath(spec, root)
}

export function hasModel(spec: ModelSpec, root = modelRoot): boolean {
  return fileExists(spec, root)
}

export function missingModels(specs: ModelSpec[] = requiredModels(), root = modelRoot): ModelSpec[] {
  return missingFiles(specs, root)
}

/** 下载单个模型文件；保留原有参数顺序（spec, onProgress, root）。 */
export function downloadModel(
  spec: ModelSpec,
  onProgress?: (progress: DownloadProgress) => void,
  root = modelRoot,
): Promise<void> {
  return downloadFile(spec, root, onProgress)
}

/** 下载全部缺失的模型文件，已存在的直接跳过。 */
export async function ensureMangaModels(
  specs: ModelSpec[] = requiredModels(),
  onProgress?: (progress: DownloadProgress) => void,
  root = modelRoot,
): Promise<void> {
  await ensureModels(specs, root, onProgress, '本地识别模型')
}
