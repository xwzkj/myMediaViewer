/**
 * 中文 CLIP 语义模型的下载与就位。
 *
 * 与漫画模型一样自动下载，不需要任何环境变量：默认落在 `<数据目录>/models/chinese-clip-vit-b16`。
 * 主服务和远程计算端各自按自己进程的数据目录解析，因此:
 *  - 两端在不同机器上：各自下载自己的一份；
 *  - 同一台机器上：共用同一份下载结果，不会重复占空间。
 *
 * 需要自定义位置时仍可用 `SEMANTIC_CLIP_MODEL_DIR` 显式覆盖（例如计算端单独放大盘）。
 *
 * 选型说明：Chinese-CLIP（ViT-B/16 + 中文 BERT 文本塔）是单图双塔导出，中文检索显著
 * 优于 OpenAI CLIP 的英文文本塔，英文查询也仍然可用。量化后约 182 MB，纯 CPU 推理。
 */
import path from 'node:path'
import {
  ensureModels, missingModels, modelPath, type DownloadProgress, type ModelSpec,
} from '../ai/model-files.js'

export type { DownloadProgress, ModelSpec }

export const clipModelRoot = path.resolve(
  process.env.SEMANTIC_CLIP_MODEL_DIR || path.join(process.env.MEDIA_DATA_DIR || 'data', 'models', 'chinese-clip-vit-b16'),
)

const repo = 'Xenova/chinese-clip-vit-base-patch16'

/** 双塔在同一张图里：输入 input_ids / attention_mask / pixel_values，输出 text_embeds / image_embeds。 */
export const clipModel: ModelSpec = {
  target: 'model.onnx',
  repo,
  file: 'onnx/model_quantized.onnx',
}

/** BERT WordPiece 词表（21128 词），中文逐字成词。 */
export const clipTokenizerModel: ModelSpec = {
  target: 'tokenizer.json',
  repo,
  file: 'tokenizer.json',
}

export function requiredClipModels(): ModelSpec[] {
  return [clipModel, clipTokenizerModel]
}

export function missingClipModels(root = clipModelRoot): ModelSpec[] {
  return missingModels(requiredClipModels(), root)
}

export function clipModelsReady(root = clipModelRoot): boolean {
  return missingClipModels(root).length === 0
}

export function clipModelPath(spec: ModelSpec, root = clipModelRoot): string {
  return modelPath(spec, root)
}

/** 下载全部缺失的文件；已存在的跳过。 */
export async function ensureClipModels(
  root = clipModelRoot,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<void> {
  await ensureModels(requiredClipModels(), root, onProgress, 'CLIP 语义模型')
}
