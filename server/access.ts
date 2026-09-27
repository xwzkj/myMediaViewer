import { isIPv4 } from 'node:net'

// 只放行局域网与保留地址，公网地址默认拒绝：10/8、100.64/10（运营商级 NAT）、127/8、
// 169.254/16（链路本地）、172.16/12、192.168/16、198.18/15（基准测试网段，常见于 TUN 虚拟网卡）。
const v4Ranges: Array<[string, number]> = [
  ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['198.18.0.0', 15],
]

function v4ToInt(address: string): number {
  return address.split('.').reduce((value, part) => (value << 8) + Number(part), 0) >>> 0
}

const v4Masks = v4Ranges.map(([base, bits]) => ({ base: v4ToInt(base), mask: (0xffffffff << (32 - bits)) >>> 0 }))

function isLocalV4(address: string): boolean {
  const value = v4ToInt(address)
  return v4Masks.some(range => (value & range.mask) === (range.base & range.mask))
}

/** 判断对端地址是否属于局域网或保留网段：IPv4 私有段、回环、链路本地，以及 IPv6 回环、唯一本地地址和链路本地。 */
export function isLocalAddress(address: string): boolean {
  const ip = address.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  if (isIPv4(ip)) return isLocalV4(ip)
  // IPv4 映射地址（::ffff:192.168.1.5）按内层 IPv4 判断。
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isLocalV4(mapped[1])
  if (ip === '::1' || ip === '::') return true
  const first = ip.split(':')[0]
  if (/^f[cd][0-9a-f]{2}$/.test(first)) return true // fc00::/7 唯一本地地址
  if (/^fe[89ab][0-9a-f]$/.test(first)) return true // fe80::/10 链路本地
  return false
}