import type { ObjectDirective } from 'vue'

export function releaseVideo(element: HTMLVideoElement) {
  element.pause()
  element.autoplay = false
  element.removeAttribute('src')
  element.load()
}

// 接收正在卸载的节点本身，不能依赖可能已被转场替换的模板 ref。
export const vReleaseVideo: ObjectDirective<HTMLVideoElement> = { beforeUnmount: releaseVideo }

export function releaseVideos(element: Element) {
  element.querySelectorAll('video').forEach(releaseVideo)
}
