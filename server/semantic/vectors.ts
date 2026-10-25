import { SEMANTIC_DIMENSIONS } from '../../shared/semantic.js'

export class SemanticError extends Error {
  readonly expose = true
  constructor(readonly code: string, message: string, readonly statusCode = 400) { super(message) }
}

export function normalizeVector(input: ArrayLike<number>): Float32Array {
  if (!input || input.length !== SEMANTIC_DIMENSIONS) throw new SemanticError('semantic_invalid_vector', '语义向量必须包含 512 个有限数字')
  let scale = 0
  for (let i = 0; i < input.length; i++) {
    if (typeof input[i] !== 'number' || !Number.isFinite(input[i])) throw new SemanticError('semantic_invalid_vector', '语义向量必须包含 512 个有限数字')
    scale = Math.max(scale, Math.abs(input[i]))
  }
  if (!scale) throw new SemanticError('semantic_invalid_vector', '语义向量不能是零向量')
  let sum = 0
  for (let i = 0; i < input.length; i++) sum += (input[i] / scale) ** 2
  const norm = Math.sqrt(sum)
  return Float32Array.from(input, value => (value / scale) / norm)
}
export function encodeVector(input: ArrayLike<number>): Buffer {
  const vector = normalizeVector(input)
  const bytes = Buffer.alloc(SEMANTIC_DIMENSIONS * 4)
  for (let i = 0; i < vector.length; i++) bytes.writeFloatLE(vector[i], i * 4)
  return bytes
}
export function decodeVector(input: Uint8Array): Float32Array {
  if (input.byteLength !== SEMANTIC_DIMENSIONS * 4) throw new SemanticError('semantic_invalid_vector', '语义向量缓存尺寸错误')
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  return normalizeVector(Array.from({ length: SEMANTIC_DIMENSIONS }, (_, i) => bytes.readFloatLE(i * 4)))
}
/** Inputs are L2-normalized on persistence/read/query boundaries. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let score = 0
  for (let i = 0; i < SEMANTIC_DIMENSIONS; i++) score += a[i] * b[i]
  return Math.max(-1, Math.min(1, score))
}
