import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_PAGE_PIXELS, planPageScale, scaleRectToSource } from '../server/ai/manga/page.js'

test('工作尺寸不超过 40 MP，坐标缩放比按实际宽高分别计算', () => {
  const plan = planPageScale(6000, 9450) // 56.7 MP
  assert.ok(plan.width * plan.height <= MAX_PAGE_PIXELS)
  assert.ok(plan.width < 6000 && plan.height < 9450)
  assert.ok(Math.abs(plan.scaleX - 6000 / plan.width) < 1e-12)
  assert.ok(Math.abs(plan.scaleY - 9450 / plan.height) < 1e-12)
  assert.ok(Math.abs(plan.scaleX - plan.scaleY) < 0.01, '等比缩放的 x/y 比例应基本一致')
})

test('未超过上限时完全不动，矩形原样返回', () => {
  const plan = planPageScale(3000, 4000)
  assert.deepEqual(plan, { width: 3000, height: 4000, scaleX: 1, scaleY: 1 })
  assert.deepEqual(scaleRectToSource({ left: 10, top: 20, width: 30, height: 40 }, plan, 3000, 4000), { left: 10, top: 20, width: 30, height: 40 })
  assert.deepEqual(planPageScale(8000, 5000), { width: 8000, height: 5000, scaleX: 1, scaleY: 1 }, '正好 40 MP 不缩放')
})

test('缩放后的矩形映射回原图且不越界', () => {
  const sourceWidth = 6000, sourceHeight = 9450
  const plan = planPageScale(sourceWidth, sourceHeight)
  const rect = scaleRectToSource({ left: 100, top: 200, width: 300, height: 400 }, plan, sourceWidth, sourceHeight)
  assert.ok(rect.left >= 0 && rect.top >= 0)
  assert.ok(rect.left + rect.width <= sourceWidth)
  assert.ok(rect.top + rect.height <= sourceHeight)
  assert.ok(rect.left > 100 && rect.width > 300, '缩小时应放大回原图坐标')

  const edge = scaleRectToSource({ left: plan.width - 2, top: plan.height - 2, width: 2, height: 2 }, plan, sourceWidth, sourceHeight)
  assert.ok(edge.left + edge.width <= sourceWidth)
  assert.ok(edge.top + edge.height <= sourceHeight)
})

test('极端长宽比也能压到上限以内', () => {
  const plan = planPageScale(100_000, 1_000) // 100 MP，100:1
  assert.ok(plan.width >= 1 && plan.height >= 1)
  assert.ok(plan.width * plan.height <= MAX_PAGE_PIXELS)
  assert.ok(plan.width <= 100_000 && plan.height <= 1_000)
})

test('透明覆盖层按原图尺寸输出，最近邻放大不会引入半透明边缘', async () => {
  const sharp = (await import('sharp')).default
  const { encodeOverlayPng } = await import('../server/ai/manga/page.js')
  const raw = Buffer.alloc(80 * 80 * 4)
  const alphaAt = (x: number, y: number) => raw[(y * 80 + x) * 4 + 3]
  for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) {
    const offset = (y * 80 + x) * 4
    raw[offset] = 255; raw[offset + 3] = 255
  }
  assert.equal(alphaAt(10, 10), 255)
  const png = await encodeOverlayPng(raw, 80, 80, 160, 160)
  const meta = await sharp(png).metadata()
  assert.deepEqual([meta.width, meta.height, meta.hasAlpha], [160, 160, true])
  const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const alpha = (x: number, y: number) => decoded.data[(y * decoded.info.width + x) * decoded.info.channels + 3]
  assert.equal(alpha(0, 0), 0)
  assert.equal(alpha(30, 30), 255, '放大后文字区域仍完全不透明')
})
