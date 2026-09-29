/**
 * 阶段一验证脚本：只跑 CTD 检测 + manga-ocr 识别，不接翻译、不做回填。
 *
 * 目的：拿真实素材确认「检测框落在哪、每个框识别出什么、置信度多少」，
 * 再决定后续做到什么程度。
 *
 * 用法：
 *   pnpm exec tsx tests/manga-ocr-check.ts [图片路径...]
 *   pnpm exec tsx tests/manga-ocr-check.ts --full    # 不截断 OCR 文本
 *
 * 产物写到 test-results/manga-ocr/：调试图 PNG（框 + 序号）与同名 .json。
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { ComicTextDetector } from '../server/ai/manga/detector.js'
import { MangaOcrRecognizer } from '../server/ai/manga/recognizer.js'
import { judgeRegion, mangaReadingOrder, trimTrailingNoise } from '../server/ai/manga/pipeline.js'
import { boxToRect, type OcrRegion } from '../server/ai/manga/types.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const modelRoot = path.join(root, 'data', 'models')
const outDir = path.join(root, 'test-results', 'manga-ocr')

const SOURCE_ROOT = process.env.MANGA_OCR_TEST_ROOT || ''
const DEFAULT_IMAGES = [
  '37686118981-73643248_p0.png',
  '37686085847-74899974_p0.png',
  '38111783468-78088468_p0.jpg',
  '38111783468-78088468_p22.jpg',
  '38504896775-148818472_p0.png',
  '38504999573-121303126_p8.png',
]

const argv = process.argv.slice(2)
const verbose = argv.includes('--full')
const explicit = argv.filter(a => !a.startsWith('--'))
const requested = explicit.length ? explicit : DEFAULT_IMAGES

/** 按文件名在媒体根目录下递归查找 —— Pixiv 目录是「收藏夹名/作品文件」两层。 */
async function resolveImage(input: string): Promise<string | null> {
  if (path.isAbsolute(input)) return existsSync(input) ? input : null
  if (!SOURCE_ROOT) return null
  const direct = path.join(SOURCE_ROOT, input)
  if (existsSync(direct)) return direct
  const all = await readdir(SOURCE_ROOT, { recursive: true })
  const hit = all.find(entry => path.basename(entry) === input)
  return hit ? path.join(SOURCE_ROOT, hit) : null
}

const targets: string[] = []
for (const input of requested) {
  const resolved = await resolveImage(input)
  if (resolved) targets.push(resolved)
  else console.log(`⚠ 找不到：${input}`)
}

const ms = (t: bigint) => Number(process.hrtime.bigint() - t) / 1e6
const pad = (s: string | number, n: number) => String(s).padEnd(n)

async function main() {
  await mkdir(outDir, { recursive: true })
  console.log(`模型目录：${modelRoot}`)
  console.log(`待测图片：${targets.length} 张\n`)

  const detector = new ComicTextDetector()
  const recognizer = new MangaOcrRecognizer()

  let t = process.hrtime.bigint()
  await detector.load(path.join(modelRoot, 'comic-text-detector', 'comictextdetector.pt.onnx'))
  await recognizer.load(path.join(modelRoot, 'manga-ocr'))
  console.log(`模型加载完成 ${ms(t).toFixed(0)} ms`)
  console.log(`manga-ocr 输入尺寸：${recognizer.imageSize}（来自模型/配置）\n`)

  const summary: Array<Record<string, unknown>> = []

  for (const imagePath of targets) {
    const name = path.basename(imagePath)
    console.log('='.repeat(78))
    console.log(name)

    let fileBuffer: Buffer
    try {
      fileBuffer = await readFile(imagePath)
    } catch {
      console.log('  读取失败，跳过\n')
      continue
    }

    // ── 检测 ──
    t = process.hrtime.bigint()
    const detection = await detector.detect(imagePath)
    const detectMs = ms(t)
    const { pageWidth, pageHeight, textMask } = detection
    const shortEdge = Math.min(pageWidth, pageHeight)
    console.log(`  ${pageWidth}x${pageHeight}  CTD: ${detection.boxes.length} 框 / ${detectMs.toFixed(0)} ms` +
      (textMask ? `, mask ${textMask.data.reduce((a, b) => a + b, 0)} px` : ', 无 mask'))

    if (!detection.boxes.length) { console.log('  未检测到文本框\n'); continue }

    // ── 识别（整页 raw 只解一次，crop 从内存里切）──
    const pageRaw = await sharp(fileBuffer, { limitInputPixels: 500_000_000 })
      .removeAlpha().toColourspace('srgb').raw().toBuffer()
    const crops = detection.boxes.map(b => boxToRect(b, pageWidth, pageHeight))

    t = process.hrtime.bigint()
    const ocrResults = await recognizer.recognizeBatch(pageRaw, pageWidth, pageHeight, crops)
    const ocrMs = ms(t)

    const regions: OcrRegion[] = detection.boxes.map((b, i) => ({
      text: trimTrailingNoise(ocrResults[i]!.text),
      cx: b.cx, cy: b.cy, width: b.width, height: b.height,
      prob: b.confidence,
      confidence: ocrResults[i]!.confidence,
    }))

    const ordered = mangaReadingOrder(regions)
    console.log(`  OCR: ${ocrMs.toFixed(0)} ms（${(ocrMs / regions.length).toFixed(0)} ms/框, 编码批量 1 次）`)

    // ── 逐个报告 ──
    console.log(`  ${pad('#', 3)}${pad('text', 34)}${pad('recog', 7)}${pad('det', 7)}${pad('box', 12)}判定`)
    const verdicts = ordered.map((r, i) => {
      const v = judgeRegion(r, shortEdge)
      const text = verbose ? r.text : (r.text.length > 16 ? r.text.slice(0, 16) + '…' : r.text)
      const box = `${Math.round(r.width)}x${Math.round(r.height)}`
      console.log(`  ${pad(i + 1, 3)}${pad(text || '(空)', 34)}${pad(r.confidence.toFixed(2), 7)}` +
        `${pad(r.prob.toFixed(2), 7)}${pad(box, 12)}${v.keep ? 'OK' : '× ' + v.reasons.join('; ')}`)
      return { index: i + 1, ...r, keep: v.keep, reasons: v.reasons }
    })

    const kept = verdicts.filter(v => v.keep).length
    console.log(`  → 保留 ${kept} / ${verdicts.length}`)

    // ── 调试图 ──
    const svg = buildOverlaySvg(verdicts, pageWidth, pageHeight)
    const outPng = path.join(outDir, name.replace(/\.[^.]+$/, '') + '-boxes.png')
    await sharp(fileBuffer, { limitInputPixels: 500_000_000 })
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .png()
      .toFile(outPng)
    await writeFile(
      path.join(outDir, name.replace(/\.[^.]+$/, '') + '.json'),
      JSON.stringify({ image: name, pageWidth, pageHeight, detectMs, ocrMs, regions: verdicts }, null, 2),
      'utf8',
    )
    console.log(`  调试图：${path.relative(root, outPng)}\n`)

    summary.push({
      image: name, size: `${pageWidth}x${pageHeight}`,
      boxes: verdicts.length, kept,
      detectMs: Math.round(detectMs), ocrMs: Math.round(ocrMs),
    })
  }

  console.log('='.repeat(78))
  console.log('汇总')
  console.table(summary)
  await detector.release()
  await recognizer.release()
}

/** 画检测框 + 序号。刻意不画文字，避免 Windows 上 librsvg 找不到 CJK 字体。 */
function buildOverlaySvg(
  regions: Array<OcrRegion & { keep: boolean; reasons: string[] }>,
  width: number,
  height: number,
): string {
  const stroke = Math.max(2, Math.round(Math.min(width, height) / 400))
  const fontSize = Math.max(14, Math.round(Math.min(width, height) / 45))
  const parts: string[] = []
  for (const r of regions) {
    const x = r.cx - r.width / 2
    const y = r.cy - r.height / 2
    const color = r.keep ? '#00e400' : (r.reasons.some(s => s.startsWith('ocr')) ? '#ffae00' : '#ff3b30')
    parts.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${r.width.toFixed(1)}" height="${r.height.toFixed(1)}"` +
      ` fill="none" stroke="${color}" stroke-width="${stroke}"/>`,
    )
    const w = Number(r.index) >= 10 ? fontSize * 1.6 : fontSize
    parts.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(0)}" height="${fontSize}" fill="${color}"/>` +
      `<text x="${(x + 2).toFixed(1)}" y="${(y + fontSize * 0.8).toFixed(1)}" font-size="${fontSize}"` +
      ` font-family="monospace" fill="#000">${r.index}</text>`,
    )
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join('')}</svg>`
}

main().catch(err => { console.error(err); process.exit(1) })
