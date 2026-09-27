// Visual QA uses an isolated library of generated landscapes, never private media.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { spawn } from 'node:child_process'

const root = path.resolve('.cache/preview')
const illustrations = path.join(root, 'illustrations')
const films = path.join(root, 'films')
const data = path.join(root, 'data')
await Promise.all([mkdir(illustrations, { recursive: true }), mkdir(films, { recursive: true }), mkdir(data, { recursive: true })])
const names = ['山野之间，慢慢呼吸', '暮色与远方', '把夏天装进口袋', '湖面上的第一束光', '一场温柔的日落', '海边来信', '林深时见鹿', '月亮也有自己的花园', '风吹过的地方', '日常里的小小宇宙', '云层之上', '山间旅行手记']
const palettes = [
  ['#d6dfc9','#f8efcf','#a1b68f','#698e75','#426858'], ['#dbccbf','#fbeac6','#bda297','#877e91','#555970'],
  ['#e7e4cd','#fff5cc','#cfb58c','#a18e61','#6b795c'], ['#ccddd6','#fbefcc','#a9c5b9','#6a9994','#497875'],
  ['#eed2bd','#ffebae','#daa38c','#b47e7e','#7c696e'], ['#d4e4e5','#fff5d8','#b0cdd4','#86adb7','#5b8c9c'],
]
for (let i = 0; i < names.length; i++) {
  const [sky, sun, far, middle, front] = palettes[i % palettes.length]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="780" viewBox="0 0 640 780"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="${sky}"/><stop offset="1" stop-color="${sun}"/></linearGradient><filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.55" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope=".065"/></feComponentTransfer><feBlend in="SourceGraphic" mode="multiply"/></filter></defs><rect width="640" height="780" fill="url(#sky)"/><circle cx="${170 + (i % 3) * 140}" cy="${160 + i % 4 * 30}" r="${52 + i % 3 * 12}" fill="${sun}"/><path d="M-50 530 180 270 370 460 560 310 760 540V900H-50" fill="${far}"/><path d="M-60 650Q130 390 360 520T750 480V900H-60" fill="${middle}"/><path d="M-80 630Q120 730 350 640T750 680V900H-80" fill="${front}"/><path d="M${220 + i*10} 900Q470 700 340 620T350 520" stroke="${sun}" fill="none" stroke-width="${9 + i}" opacity=".35"/><rect width="640" height="780" fill="transparent" filter="url(#grain)"/></svg>`
  for (let page = 0; page < (i % 4) + 1; page++) {
    await sharp(Buffer.from(svg)).png().toFile(path.join(illustrations, `${100000 + i}-${900000 + i}_p${page}.png`))
  }
  await writeFile(path.join(illustrations, `${100000 + i}-${900000 + i}-meta.txt`), `ID\n${900000 + i}\n\nUser\n${['mori studio', '青野', 'Sunday & Slow', '小岛绘画室'][i % 4]}\n\nTitle\n${names[i]}\n\nDescription\n在山野之间，收集一点平凡的美好。\n\n这是一组用于界面验证的生成风景，包含多段描述与同组图片。\n\nTags\n#风景\n#插画\n#自然\n\nDate\n2026-09-${String(26 - i).padStart(2, '0')}T10:00:00Z\n`)
}
function ffmpeg(args: string[]) { return new Promise<void>((resolve, reject) => { const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-v','error','-nostdin', ...args], { windowsHide: true }); child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))) }) }
await ffmpeg(['-f','lavfi','-i','testsrc2=size=320x240:rate=12','-t','2','-c:v','libx264','-pix_fmt','yuv420p','-y',path.join(films,'10_202609_p1.mp4')])
await ffmpeg(['-i',path.join(films,'10_202609_p1.mp4'),'-t','1','-vf','fps=6,scale=160:-1','-y',path.join(illustrations,'200000-990000.gif')])
await writeFile(path.join(films,'10_202609.txt'),'彩色的瞬间\n\n视频播放、进度拖动与兼容转换验证。\n#影像 #测试')
await writeFile(path.join(illustrations,'200000-990000-meta.txt'),'Title\n流动的色彩\n\nDescription\n动图播放验证\n\nDate\n2026-09-26\n')
await writeFile(path.join(data, 'sources.json'), JSON.stringify([{ id:'demo-pixiv', name:'山野插画集', kind:'pixiv', path:illustrations }, { id:'demo-films', name:'生活影像', kind:'telegram', path:films }], null, 2))
console.log(`Preview data ready: ${data}`)
