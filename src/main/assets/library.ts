import { extname } from 'node:path'

/** 由扩展名推断的媒体类型（未知扩展按二进制处理，导入时由调用方限制允许的类型） */
const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.heic': 'image/heic',
  '.heif': 'image/heic',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}

export function mediaTypeFor(path: string): string | null {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? null
}

export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.heic', '.heif', '.tif', '.tiff', '.webp', '.gif', '.bmp'])
export const MAX_HTML_BYTES = 10 * 1024 * 1024
export const DOCUMENT_EXTS = new Set(['.pdf', '.html', '.htm'])
export const PDF_EXTS = new Set(['.pdf'])

export interface StoredAsset {
  id: string
  sha256: string
  mediaType: string
  byteSize: number
  relPath: string // 相对 assets 根目录
  originalName: string
  /** 已存在同校验和文件，本次未重新写入 */
  reused: boolean
}

/** sha256Of 原在 AssetStore 上；v2 存储统一走 storage/fsutil 的实现。此文件保留 MIME/常量导出。 */

// ---------- 图片类型识别（笔记插图用：先嗅探文件头，再退回扩展名） ----------

export interface ImageKind {
  ext: string
  mediaType: string
}

/** 按文件魔数识别常见图片格式；识别不出返回 null */
export function sniffImageKind(data: Uint8Array): ImageKind | null {
  const b = data
  const startsWith = (...bytes: number[]): boolean => bytes.every((v, i) => b[i] === v)
  const ascii = (offset: number, text: string): boolean =>
    text.split('').every((ch, i) => b[offset + i] === ch.charCodeAt(0))
  if (b.length >= 8 && startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { ext: '.png', mediaType: 'image/png' }
  if (b.length >= 3 && startsWith(0xff, 0xd8, 0xff)) return { ext: '.jpg', mediaType: 'image/jpeg' }
  if (b.length >= 6 && (ascii(0, 'GIF87a') || ascii(0, 'GIF89a'))) return { ext: '.gif', mediaType: 'image/gif' }
  if (b.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { ext: '.webp', mediaType: 'image/webp' }
  if (b.length >= 2 && startsWith(0x42, 0x4d)) return { ext: '.bmp', mediaType: 'image/bmp' }
  if (b.length >= 4 && (ascii(0, 'II*\u0000') || ascii(0, 'MM\u0000*'))) return { ext: '.tiff', mediaType: 'image/tiff' }
  // ISO-BMFF 容器（HEIC/HEIF）：offset 4 起为 'ftyp'，brand 含 heic/heix/hevc/mif1/msf1
  if (b.length >= 12 && ascii(4, 'ftyp')) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11])
    if (/^(heic|heix|hevc|heim|heis|hevm|hevs|mif1|msf1)/.test(brand)) return { ext: '.heic', mediaType: 'image/heic' }
  }
  return null
}

/** 扩展名兜底识别（嗅探不出的场景，如部分 HEIC 变体） */
export function extImageKind(fileName: string): ImageKind | null {
  const mediaType = mediaTypeFor(fileName)
  if (!mediaType || !mediaType.startsWith('image/')) return null
  const ext = extname(fileName).toLowerCase() || '.bin'
  return { ext: ext === '.jpeg' ? '.jpg' : ext === '.heif' ? '.heic' : ext, mediaType }
}
