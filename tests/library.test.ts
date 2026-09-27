import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rename, readFile, rm, utimes, unlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import { parseJsonMetadata, parseName, parseMetadata, decodeText } from '../server/parsers.js'
import { isLocalAddress } from '../server/access.js'

test('两种命名规则、数字页码、大小写和双点扩展名', () => {
  assert.deepEqual(parseName('20434537023-92408550_p10.jpg', 'pixiv'), { externalId: '92408550', page: 10, metadata: false, kind: 'image', extension: 'jpg', sequence: 20434537023 })
  assert.equal(parseName('20434537023-92408550-meta.txt', 'pixiv')?.metadata, true)
  assert.equal(parseName('20434537023-92408550.webm', 'pixiv')?.kind, 'animation')
  assert.equal(parseName('20434537023-92408550_p0.webm', 'pixiv')?.kind, 'animation')
  assert.equal(parseName('20434537023-92408550_p2.WEBM', 'pixiv')?.page, 2)
  assert.equal(parseName('20434537023-92408550_p2.WEBM', 'pixiv')?.kind, 'animation')
  assert.equal(parseName('1201_202403_p1.webm', 'telegram')?.kind, 'video')
  assert.equal(parseName('1201_202403_p1.webm', 'telegram')?.sequence, 1201)
  assert.equal(parseName('1201_202403_p1..MP4', 'telegram')?.externalId, '1201_202403')
  assert.equal(parseName('1238_202403.txt', 'telegram')?.metadata, true)
  assert.deepEqual(parseName('33885063179-133752873_p0-meta.json', 'pixiv'), { externalId: '133752873', page: 0, metadata: true, kind: 'image', extension: 'json', sequence: 33885063179 })
  assert.deepEqual(parseName('38757265931-134522682_p0-meta.txt', 'pixiv'), { externalId: '134522682', page: 0, metadata: true, kind: 'image', extension: 'txt', sequence: 38757265931 })
  assert.deepEqual(parseName('30338704345-128976578-meta.json', 'pixiv'), { externalId: '128976578', page: 0, metadata: true, kind: 'image', extension: 'json', sequence: 30338704345 })
  assert.deepEqual(parseName('38757265931-134522682_p0.webm', 'pixiv'), { externalId: '134522682', page: 0, metadata: false, kind: 'animation', extension: 'webm', sequence: 38757265931 })
  assert.equal(parseName('unrelated.txt', 'telegram'), null)
  assert.equal(parseName('1201_202403_p1.exe', 'telegram'), null)
})

test('元数据保留多段描述、解码实体和不同文本编码', () => {
  const parsed = parseMetadata('ID\n12\n\nUser\nPainter\n\nTitle\n夏日&#44;山林\n\nDescription\n第一段\n\n第二段\n\nTags\n#山林\n#風景\n\nDate\n2024-06-01\n', 'pixiv')
  assert.equal(parsed.title, '夏日,山林')
  assert.equal(parsed.description, '第一段\n\n第二段')
  assert.deepEqual(parsed.tags, ['山林', '風景'])
  assert.equal(parsed.date, '2024-06-01')
  assert.equal(parseMetadata('\n\n山间旅行\n\n#自然 #自然', 'telegram').title, '山间旅行')
  assert.deepEqual(parseMetadata('山间旅行\n#自然 #自然', 'telegram').tags, ['自然'])
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('山林', 'utf16le')])), '山林')
  const json = parseJsonMetadata(JSON.stringify({
    idNum: 133752873, id: '133752873_p0', title: 'hacking...', user: 'ei',
    description: 'MP4・FHD(FREE)<br /><a href="https://example.com/a" target="_blank">https://example.com/a</a>',
    tags: ['R-18', 'うごイラ'], tagsWithTransl: ['R-18', 'うごイラ', '动图'],
    date: '2025-08-11T07:01:00+00:00', original: 'https://i.pximg.net/img-zip-ugoira/img/2025/08/11/16/01/53/133752873_ugoira1920x1080.zip',
  }), 'pixiv')
  assert.equal(json.title, 'hacking...')
  assert.equal(json.author, 'ei')
  assert.equal(json.description, 'MP4・FHD(FREE)\nhttps://example.com/a')
  assert.deepEqual(json.tags, ['R-18', 'うごイラ', '动图'])
  assert.equal(json.date, '2025-08-11T07:01:00+00:00')
  assert.equal(json.originalUrl, 'https://www.pixiv.net/i/133752873')
  assert.deepEqual(parseJsonMetadata('{ 坏掉的 json', 'pixiv').title, '')
  assert.deepEqual(parseJsonMetadata(JSON.stringify({ idNum: 5, title: '仅标题' }), 'pixiv').description, '')
})

test('访问范围：只放行局域网与保留地址，公网地址被拒绝', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '100.64.0.7', '169.254.10.1', '172.16.5.4', '172.31.255.254', '192.168.31.17', '198.18.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.1.5']) {
    assert.equal(isLocalAddress(address), true, address)
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '203.0.113.9', '2001:db8::1']) {
    assert.equal(isLocalAddress(address), false, address)
  }
})
test('媒体库端到端：目录管理、分组、搜索、收藏、媒体流及离线恢复', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'media-garden-test-'))
  process.env.MEDIA_DATA_DIR = path.join(root, 'database')
  delete process.env.ALLOW_PUBLIC_ACCESS
  const { createApp } = await import('../server/app.js')
  const { scanLibrary, scanStatus } = await import('../server/scanner.js')
  const { db } = await import('../server/database.js')
  const { parseRange } = await import('../server/media.js')
  const app = await createApp(false)
  const folder = path.join(root, 'pixiv')
  const tele = path.join(root, 'telegram')
  await mkdir(folder); await mkdir(tele)
  const image = await sharp({ create: { width: 80, height: 100, channels: 3, background: '#abcbaa' } }).png().toBuffer()
  for (const page of [0, 2, 10]) await writeFile(path.join(folder, `100-12_p${page}.png`), image)
  await writeFile(path.join(folder, '101-12_p0.png'), image)
  await writeFile(path.join(folder, '100-12-meta.txt'), 'Title\n山間旅行\n\nUser\nPainter\n\nDescription\n春天的山林 风景 青绿色\n\nTags\n#自然\n\nDate\n2024-06-01\n')
  await writeFile(path.join(folder, '100-13_p0.png'), image)
  await writeFile(path.join(folder, '100-13-meta.txt'), 'Title\nLandscape\n\nDescription\nA quiet lake\n')
  await writeFile(path.join(folder, '100-13_p0-meta.json'), JSON.stringify({
    idNum: 13, id: '13_p0', title: 'Landscape', user: 'JsonUser', description: '',
    tags: ['lake'], tagsWithTransl: ['lake', '湖泊'], date: '2024-06-02T00:00:00+00:00',
    original: 'https://i.pximg.net/img-original/img/2024/06/02/13_ugoira1920x1080.zip',
  }))
  await writeFile(path.join(tele, '22_202405_p1..MP4'), Buffer.from('0123456789abcdef'))
  await writeFile(path.join(tele, '22_202405.txt'), '林间漫步\n#自然')
  await writeFile(path.join(tele, '23_202405_p1.jpg'), image)

  async function waitScan() {
    for (let i = 0; i < 500 && scanStatus.running; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(scanStatus.running, false)
    assert.deepEqual(scanStatus.errors, [])
  }
  const add = (name: string, dir: string, kind: string) => app.inject({ method: 'POST', url: '/api/sources', payload: { name, path: dir, kind } })
  let sourceId = ''
  let workId = ''
  try {
    await t.test('文件夹选择器：磁盘、中文路径、数字排序、空目录和非法路径', async () => {
      const browse = (directory?: string) => app.inject(`/api/directories${directory ? `?path=${encodeURIComponent(directory)}` : ''}`)
      const roots = await browse()
      assert.equal(roots.statusCode, 200)
      assert.equal(roots.headers['cache-control'], 'no-store')
      assert.equal(roots.json().path, null)
      assert.ok(roots.json().directories.some((entry: { path: string }) => entry.path.toLowerCase() === path.parse(root).root.toLowerCase()))
      const browsing = path.join(root, '目录选择 测试')
      await mkdir(browsing)
      await mkdir(path.join(browsing, '相册10'))
      await mkdir(path.join(browsing, '相册2'))
      await writeFile(path.join(browsing, '不应显示.txt'), 'sample')
      const listing = (await browse(browsing)).json()
      assert.deepEqual(listing.directories.map((entry: { name: string }) => entry.name), ['相册2', '相册10'])
      assert.equal(listing.parent, root)
      assert.equal(listing.breadcrumbs.at(-1).name, '目录选择 测试')
      assert.equal(listing.breadcrumbs.at(-1).path, browsing)
      assert.equal((await browse(path.join(browsing, '相册2'))).json().directories.length, 0)
      assert.equal((await browse('relative/path')).statusCode, 400)
      assert.equal((await browse(path.join(root, 'not-present'))).statusCode, 404)
      assert.equal((await browse(path.join(browsing, '不应显示.txt'))).statusCode, 404)
      assert.equal((await browse('\\\\?\\C:\\')).statusCode, 400)
    })
    await t.test('初始空库、动态添加、去重和路径校验', async () => {
      assert.equal((await app.inject('/api/status')).json().works, 0)
      assert.equal((await add('invalid', 'relative/path', 'pixiv')).statusCode, 400)
      const added = await add('插画', folder, 'pixiv')
      assert.equal(added.statusCode, 201)
      sourceId = added.json().id
      await waitScan()
      assert.equal((await add('duplicate', folder, 'pixiv')).statusCode, 409)
      assert.equal((await add('影像', tele, 'telegram')).statusCode, 201)
      await waitScan()
      const status = (await app.inject('/api/status')).json()
      assert.equal(status.works, 4)
      assert.equal(status.files, 6)
    })
    await t.test('默认只服务局域网，公网地址被拒绝', async () => {
      const lan = await app.inject({ url: '/api/status', remoteAddress: '192.168.31.50' })
      assert.equal(lan.statusCode, 200)
      assert.equal(lan.json().publicAccess, false)
      assert.equal((await app.inject({ url: '/api/works', remoteAddress: '10.0.0.5' })).statusCode, 200)
      const wan = await app.inject({ url: '/api/status', remoteAddress: '203.0.113.7' })
      assert.equal(wan.statusCode, 403)
      assert.match(wan.json().message, /局域网/)
      assert.equal((await app.inject({ url: '/api/works', remoteAddress: '8.8.8.8' })).statusCode, 403)
      assert.equal((await app.inject({ url: '/api/assets/missing/file', remoteAddress: '8.8.8.8' })).statusCode, 403)
      // 经代理转发的请求在只允许局域网的默认模式下同样拒绝，避免本机隧道绕过地址判断。
      assert.equal((await app.inject({ url: '/api/status', headers: { 'x-forwarded-for': '192.168.31.50' } })).statusCode, 403)
      assert.equal((await app.inject({ method: 'POST', url: '/api/scan', remoteAddress: '8.8.8.8' })).statusCode, 403)
    })
    await t.test('作品页码排序、重复导出合并和标题回退', async () => {
      const result = (await app.inject('/api/works?q=山间旅行')).json()
      assert.equal(result.total, 1)
      workId = result.items[0].id
      const detail = (await app.inject(`/api/works/${encodeURIComponent(workId)}`)).json()
      assert.deepEqual(detail.assets.map((a: { page: number }) => a.page), [0, 2, 10])
      assert.equal(detail.assets.length, 3)
      assert.equal(detail.assets[0].path, undefined)
      const missing = (await app.inject('/api/works?q=23_202405')).json()
      assert.match(missing.items[0].title, /23_202405/)
    })
    await t.test('JSON 元文件优先，缺的描述由 txt 补齐', async () => {
      const detail = (await app.inject(`/api/works/${encodeURIComponent(`${sourceId}:13`)}`)).json()
      assert.equal(detail.title, 'Landscape')
      assert.equal(detail.author, 'JsonUser')
      assert.equal(detail.description, 'A quiet lake')
      assert.deepEqual(detail.tags, ['lake', '湖泊'])
      assert.equal(detail.date, '2024-06-02T00:00:00+00:00')
      assert.equal(detail.originalUrl, 'https://www.pixiv.net/i/13')
      assert.equal((await app.inject('/api/works?q=%E6%B9%96%E6%B3%8A')).json().total, 1)
    })

    await t.test('多关键词 AND、简繁、拼音、模糊搜索与筛选', async () => {
      assert.equal((await app.inject('/api/works?q=山间%20自然')).json().total, 1)
      assert.equal((await app.inject('/api/works?q=山间%20不存在')).json().total, 0)
      assert.equal((await app.inject('/api/works?q=shanji')).json().total, 1)
      assert.equal((await app.inject('/api/works?q=landscpe')).json().total, 0)
      const fuzzy = (await app.inject('/api/works?q=landscpe&fuzzy=true&sort=relevance')).json()
      assert.equal(fuzzy.total, 1); assert.equal(fuzzy.items[0].approximate, true)
      assert.equal((await app.inject('/api/works?kind=video')).json().total, 1)
    })
    await t.test('标签搜索、标签建议与拼音建议', async () => {
      const tagged = (await app.inject('/api/works?q=%23自然')).json()
      assert.equal(tagged.total, 2)
      assert.ok(tagged.items.every((item: { approximate?: boolean }) => !item.approximate))
      assert.equal((await app.inject('/api/works?q=%23自然%20山间')).json().total, 1)
      assert.equal((await app.inject('/api/works?q=%23不存在的标签')).json().total, 0)
      assert.equal((await app.inject('/api/works?q=%23自然&fuzzy=true&sort=relevance')).json().total, 2)
      const suggestions = await app.inject('/api/tags?q=%E8%87%AA')
      assert.equal(suggestions.statusCode, 200)
      assert.equal(suggestions.headers['cache-control'], 'no-store')
      assert.deepEqual(suggestions.json().items[0], { name: '自然', count: 2 })
      assert.equal((await app.inject('/api/tags?q=zir')).json().items[0].name, '自然')
      const allTags = (await app.inject('/api/tags')).json().items
      assert.deepEqual(allTags[0], { name: '自然', count: 2 })
      assert.ok(allTags.some((item: { name: string }) => item.name === '湖泊'))
    })
    await t.test('收藏在扫描和修改目录路径后保留', async () => {
      const url = `/api/works/${encodeURIComponent(workId)}/favorite`
      assert.equal((await app.inject({ method: 'PUT', url, payload: { favorite: true } })).statusCode, 200)
      await scanLibrary()
      assert.equal((await app.inject('/api/works?favorites=true')).json().total, 1)
      const moved = path.join(root, 'moved')
      await rename(folder, moved)
      assert.equal((await app.inject({ method: 'PUT', url: `/api/sources/${sourceId}`, payload: { name: '移动后的插画', path: moved, kind: 'pixiv' } })).statusCode, 200)
      await waitScan()
      assert.equal((await app.inject('/api/works?favorites=true')).json().total, 1)
      await rename(moved, folder)
      await scanLibrary()
      assert.equal(scanStatus.errors.length, 1)
      assert.equal((await app.inject('/api/works?favorites=true')).json().total, 1)
      await rename(folder, moved)
      await scanLibrary()
    })
    await t.test('缩略图、Range、HEAD、非法请求及不存在资源', async () => {
      const imageDetail = (await app.inject(`/api/works/${encodeURIComponent(workId)}`)).json()
      const thumb = await app.inject(imageDetail.assets[0].thumbnail)
      assert.equal(thumb.statusCode, 200)
      assert.match(thumb.headers['content-type']!, /image\/webp/)
      const videoWork = (await app.inject('/api/works?kind=video')).json().items[0]
      const detail = (await app.inject(`/api/works/${encodeURIComponent(videoWork.id)}`)).json()
      const url = detail.assets[0].url
      const range = await app.inject({ url, headers: { range: 'bytes=2-5' } })
      assert.equal(range.statusCode, 206); assert.equal(range.body, '2345')
      assert.equal(range.headers['content-range'], 'bytes 2-5/16')
      assert.equal((await app.inject({ url, headers: { range: 'bytes=-3' } })).body, 'def')
      assert.equal((await app.inject({ url, headers: { range: 'bytes=40-' } })).statusCode, 416)
      assert.equal((await app.inject({ url, method: 'HEAD' })).headers['content-length'], '16')
      assert.equal(parseRange('bytes=0-1,4-5', 16), null)
      assert.equal((await app.inject('/api/assets/missing/file')).statusCode, 404)
      assert.equal((await app.inject({ method: 'POST', url: '/api/scan', headers: { origin: 'https://unrelated.example' } })).statusCode, 403)
    })
    await t.test('移除目录不删除原文件；配置可持久化', async () => {
      const moved = path.join(root, 'moved')
      assert.equal((await app.inject({ method: 'DELETE', url: `/api/sources/${sourceId}` })).statusCode, 200)
      assert.equal((await readFile(path.join(moved, '100-12_p0.png'))).length, image.length)
      assert.equal((await app.inject('/api/status')).json().works, 2)
      assert.equal((await app.inject('/api/works?favorites=true')).json().total, 0)
      const persisted = JSON.parse(await readFile(path.join(root, 'database', 'sources.json'), 'utf8'))
      assert.equal(persisted.length, 1)
    })
    await t.test('排序：默认按文件名开头的收藏编号，可切回发布日期', async () => {
      const sorted = path.join(root, 'sorting')
      await mkdir(sorted)
      // 收藏编号与发布日期故意相反：编号最大的作品发布于最早。
      await writeFile(path.join(sorted, '300-21_p0.png'), image)
      await writeFile(path.join(sorted, '300-21-meta.txt'), 'Title\nA 最晚收藏\n\nDate\n2020-01-05\n')
      await writeFile(path.join(sorted, '200-22_p0.png'), image)
      await writeFile(path.join(sorted, '200-22-meta.txt'), 'Title\nB 最晚发布\n\nDate\n2023-05-05\n')
      await writeFile(path.join(sorted, '100-23_p0.png'), image)
      await writeFile(path.join(sorted, '100-23-meta.txt'), 'Title\nC 居中发布\n\nDate\n2021-03-05\n')
      const added = await add('排序测试', sorted, 'pixiv')
      assert.equal(added.statusCode, 201)
      const sortSourceId = added.json().id
      await waitScan()
      const ids = (response: { items: Array<{ externalId: string }> }) => response.items.map(item => item.externalId)
      const collected = (await app.inject(`/api/works?source=${sortSourceId}&sort=newest&by=collected`)).json()
      assert.deepEqual(ids(collected), ['21', '22', '23'])
      assert.equal(collected.items[0].collected, 300)
      assert.deepEqual(ids((await app.inject(`/api/works?source=${sortSourceId}&sort=oldest&by=collected`)).json()), ['23', '22', '21'])
      assert.deepEqual(ids((await app.inject(`/api/works?source=${sortSourceId}&sort=newest&by=published`)).json()), ['22', '23', '21'])
      assert.deepEqual(ids((await app.inject(`/api/works?source=${sortSourceId}&sort=oldest&by=published`)).json()), ['21', '23', '22'])
      // 不指定排序依据时保持原来的发布日期排序，标题排序也不受影响。
      assert.deepEqual(ids((await app.inject(`/api/works?source=${sortSourceId}&sort=newest`)).json()), ['22', '23', '21'])
      assert.deepEqual(ids((await app.inject(`/api/works?source=${sortSourceId}&sort=title`)).json()), ['21', '22', '23'])
    })
    await t.test('Pixiv 动图：WebM 独立识别、优先于 GIF、页码与大小写、重新扫描回退', async () => {
      const animations = path.join(root, 'animations')
      await mkdir(animations)
      // Container bytes are unnecessary for indexing; streaming must return the chosen file unchanged.
      const webm = Buffer.from('webm-index-and-stream-fixture')
      const gif = Buffer.from('gif-index-and-stream-fixture')
      for (const filename of ['100-31.webm', '100-32.webm', '100-33_p0.webm', '100-34_p2.WEBM', '100-34_p10.webm']) {
        const file = path.join(animations, filename)
        await writeFile(file, webm)
        await utimes(file, new Date('2020-01-01'), new Date('2020-01-01'))
      }
      for (const filename of ['100-31.gif', '100-33_p0.gif', '100-34_p2.GIF', '100-35.gif']) {
        const file = path.join(animations, filename)
        await writeFile(file, gif)
        await utimes(file, new Date('2025-01-01'), new Date('2025-01-01'))
      }
      const added = await add('动图测试', animations, 'pixiv')
      assert.equal(added.statusCode, 201)
      const animationSourceId = added.json().id
      await waitScan()
      const listing = (await app.inject(`/api/works?source=${animationSourceId}&kind=animation`)).json()
      assert.equal(listing.total, 5)
      assert.equal((await app.inject(`/api/works?source=${animationSourceId}&kind=video`)).json().total, 0)
      for (const externalId of ['31', '32', '33', '34', '35']) {
        const detail = (await app.inject(`/api/works/${encodeURIComponent(`${animationSourceId}:${externalId}`)}`)).json()
        const extension = externalId === '35' ? 'gif' : 'webm'
        assert.equal(detail.kind, 'animation')
        assert.equal(detail.count, externalId === '34' ? 2 : 1)
        assert.equal(detail.assets.length, detail.count)
        assert.ok(detail.assets.every((asset: { kind: string; extension: string }) => asset.kind === 'animation' && asset.extension === extension))
        assert.ok(detail.cover.includes(detail.assets[0].id))
        if (externalId === '34') assert.deepEqual(detail.assets.map((asset: { page: number }) => asset.page), [2, 10])
        const streamed = await app.inject(detail.assets[0].url)
        assert.equal(streamed.statusCode, 200)
        assert.equal(streamed.headers['content-type'], extension === 'webm' ? 'video/webm' : 'image/gif')
        assert.deepEqual(streamed.rawPayload, extension === 'webm' ? webm : gif)
      }
      const pairedId = `${animationSourceId}:31`
      await app.inject({ method: 'PUT', url: `/api/works/${encodeURIComponent(pairedId)}/favorite`, payload: { favorite: true } })
      await unlink(path.join(animations, '100-31.webm'))
      await scanLibrary()
      const fallback = (await app.inject(`/api/works/${encodeURIComponent(pairedId)}`)).json()
      assert.equal(fallback.assets.length, 1)
      assert.equal(fallback.assets[0].extension, 'gif')
      assert.equal(fallback.favorite, true)
      assert.deepEqual(await readFile(path.join(animations, '100-31.gif')), gif)
    })
  } finally {
    await app.close()
    db.close()
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('media-garden-test-'))
    await rm(root, { recursive: true, force: true })
  }
})
