import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chooseMangaTextLayout, drawMangaRegion, fitHorizontalText, fitVerticalText, isCjkChar, isVerticalFriendly,
  MANGA_COLUMN_PITCH, MANGA_LINE_HEIGHT, wrapCanvasText, type TextDrawContext, type TextMeasureContext,
} from '../src/manga-layout.js'

/**
 * 假测量上下文：全角字符算 1em、其余算 0.5em，和浏览器的量级一致，
 * 足以验证换行与选版逻辑，不需要真的跑 Canvas。
 */
function fakeContext(): TextMeasureContext {
  return {
    font: '',
    measureText(text: string) {
      let width = 0
      for (const char of text) width += isCjkChar(char) ? sizeOf(this.font) : sizeOf(this.font) * 0.5
      return { width }
    },
  }
}
function sizeOf(font: string): number {
  const match = /(\d+(?:\.\d+)?)px/.exec(font)
  return match ? Number(match[1]) : 0
}

test('全角与半角字符判定', () => {
  assert.equal(isCjkChar('中'), true)
  assert.equal(isCjkChar('あ'), true)
  assert.equal(isCjkChar('，'), true)
  assert.equal(isCjkChar('A'), false)
  assert.equal(isCjkChar('1'), false)
  assert.equal(isCjkChar(' '), false)
})

test('以方块字为主的译文才允许竖排', () => {
  assert.equal(isVerticalFriendly([...'你好世界']), true)
  // 标点按半角算，但中文仍然过半
  assert.equal(isVerticalFriendly([...'你好，世界！']), true)
  assert.equal(isVerticalFriendly([...'Hello world']), false)
  // 日文汉字与假名都算方块字
  assert.equal(isVerticalFriendly([...'こんにちは']), true)
})

test('横排换行按可用宽度断开', () => {
  const ctx = fakeContext()
  const lines = wrapCanvasText(ctx, '一二三四五六', 10, '"sans-serif"', 30)
  assert.deepEqual(lines, ['一二三', '四五六'])
})

test('窄高气泡改用竖排，每列字数明显多于横排每行', () => {
  const ctx = fakeContext()
  const layout = chooseMangaTextLayout(ctx, '外景拍完后请把金色比基尼脱掉', 300, 760)
  assert.equal(layout.vertical, true)
  const horizontal = fitHorizontalText(ctx, '外景拍完后请把金色比基尼脱掉', 300, 760)
  assert.ok(layout.lines.length < horizontal.lines.length, '竖排的列数应少于横排的行数')
  assert.ok(layout.lines.every(column => column.length > horizontal.lines[0]!.length), '每列字数应多于横排每行')
})

test('竖排按最大可用字号分列，列内保持阅读顺序', () => {
  const ctx = fakeContext()
  const chars = [...'一二三四五六七八九十']
  const layout = fitVerticalText(ctx, chars, 200, 40)
  assert.ok(layout)
  assert.equal(layout.vertical, true)
  // 复原所有列后应与原文完全一致，且不能有空的尾列
  assert.equal(layout.lines.join(''), chars.join(''))
  assert.ok(layout.lines.every(column => column.length > 0))
  // 除最后一列外每列等长；整体必须落在区域里
  const perColumn = layout.lines[0]!.length
  assert.ok(layout.lines.slice(0, -1).every(column => column.length === perColumn))
  const pitch = layout.size * MANGA_COLUMN_PITCH
  assert.ok(layout.lines.length * pitch <= 200)
  assert.ok(perColumn * pitch <= 40)
  // 字号再大一号就放不下，说明选的是最大可用字号
  const bigger = layout.size + 1
  const biggerPerColumn = Math.max(1, Math.floor(40 / (bigger * MANGA_COLUMN_PITCH)))
  assert.ok(Math.ceil(chars.length / biggerPerColumn) * bigger * MANGA_COLUMN_PITCH > 200)
})

test('竖排不能把字号缩得比横排小太多', () => {
  const ctx = fakeContext()
  // 极窄但很高的区域：竖排能塞下很多字，但字号会掉得厉害，此时应保持横排
  const layout = chooseMangaTextLayout(ctx, '这是一段很长很长的译文内容', 60, 900)
  const horizontal = fitHorizontalText(ctx, '这是一段很长很长的译文内容', 60, 900)
  if (layout.vertical) assert.ok(layout.size >= horizontal.size * 0.85)
  else assert.equal(layout.vertical, false)
})

test('英文窄高气泡保持横排', () => {
  const ctx = fakeContext()
  const layout = chooseMangaTextLayout(ctx, 'Hello there my friend', 100, 400)
  assert.equal(layout.vertical, false)
})

test('宽扁气泡不竖排', () => {
  const ctx = fakeContext()
  const layout = chooseMangaTextLayout(ctx, '今天的天气真不错', 400, 90)
  assert.equal(layout.vertical, false)
})

test('横排放不下时回落到最小字号而不是空结果', () => {
  const ctx = fakeContext()
  const layout = fitHorizontalText(ctx, '这是一段塞不进小气泡的超长译文', 24, 24)
  assert.equal(layout.size, 7)
  assert.ok(layout.lines.length > 0)
})

test('两种排法都选择能放下的最大字号', () => {
  const ctx = fakeContext()
  const horizontal = fitHorizontalText(ctx, '一二三四五六', 200, 60)
  // 字号再大一号就会超出行高或行宽
  const biggerSize = horizontal.size + 1
  const biggerLines = wrapCanvasText(ctx, '一二三四五六', biggerSize, '"sans-serif"', 200)
  const biggerFits = biggerLines.every(line => ctx.measureText(line).width <= 200)
    && biggerLines.length * biggerSize * MANGA_LINE_HEIGHT <= 60
  assert.equal(biggerFits, false)
  assert.ok(horizontal.lines.length * horizontal.size * MANGA_LINE_HEIGHT <= 60)

  const vertical = fitVerticalText(ctx, [...'一二三四五六'], 200, 60)
  assert.ok(vertical)
  const pitch = vertical.size * MANGA_COLUMN_PITCH
  assert.ok(vertical.lines.length * pitch <= 200)
})

/** 在假测量上下文之上记录 fillText 调用，用来验证竖排的列顺序。 */
function recordingContext() {
  const calls: Array<{ text: string; x: number; y: number }> = []
  const ctx: TextDrawContext = {
    ...fakeContext(),
    save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
    fillText(text, x, y) { calls.push({ text, x, y }) },
    fillStyle: '#000',
    textAlign: 'center',
    textBaseline: 'middle',
  }
  return { ctx, calls }
}

test('竖排从右往左排，列内自上而下', () => {
  const { ctx, calls } = recordingContext()
  // 窄高气泡：宽 120、高 300，足够放下多列
  drawMangaRegion(ctx, { x: 0, y: 0, width: 120, height: 300, translation: '一二三四五六七八九十' })
  assert.ok(calls.length > 1, '应该画出了多个字')
  // 同一列内的字：x 相同、y 递增
  const byX = new Map<number, Array<{ text: string; y: number }>>()
  for (const call of calls) {
    const list = byX.get(call.x) ?? []
    list.push({ text: call.text, y: call.y })
    byX.set(call.x, list)
  }
  for (const column of byX.values()) {
    for (let i = 1; i < column.length; i++) assert.ok(column[i]!.y > column[i - 1]!.y, '列内应自上而下')
  }
  // 列与列之间：先画的列 x 更大，即整体从右往左
  const firstColumnX = calls[0]!.x
  const lastColumnX = calls[calls.length - 1]!.x
  assert.ok(lastColumnX < firstColumnX, '后画的列应在左侧，整体从右往左')
})

test('竖排整块文字在气泡里居中', () => {
  const { ctx, calls } = recordingContext()
  const width = 120
  drawMangaRegion(ctx, { x: 0, y: 0, width, height: 300, translation: '一二三四五六七八九十' })
  const xs = [...new Set(calls.map(call => call.x))].sort((a, b) => a - b)
  assert.ok(xs.length > 1, '应该有多个列')
  const pitch = xs[1]! - xs[0]!
  const leftMargin = xs[0]! - pitch / 2
  const rightMargin = width - (xs[xs.length - 1]! + pitch / 2)
  assert.ok(Math.abs(leftMargin - rightMargin) < 0.001, '左右留白应相等')
})
