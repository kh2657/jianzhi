import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const SIPS = '/usr/bin/sips'
/** Chromium 可直接显示的图片类型；其余（HEIC/TIFF 等）生成 JPEG 显示副本，原件不动 */
const DIRECTLY_DISPLAYABLE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'])

export function sipsAvailable(): boolean {
  return existsSync(SIPS)
}

/** 调用 macOS sips 生成 JPEG 副本（-Z 限制最大边长；原文件不动）；非 macOS 给出可读降级提示 */
export function sipsConvertToJpeg(src: string, dst: string, maxDim: number): Promise<void> {
  if (process.platform !== 'darwin') {
    return Promise.reject(
      new Error('此格式（HEIC/TIFF 等）在 Windows 上暂不支持自动转换：请将照片导出为 JPEG/PNG 后再导入，或先在 Mac 上导入。')
    )
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(SIPS, ['-s', 'format', 'jpeg', '-Z', String(maxDim), src, '--out', dst], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (c) => (stderr += c.toString()))
    child.on('error', (err) => reject(new Error(`无法启动 sips：${err.message}`)))
    child.on('close', (code) => {
      if (code === 0 && existsSync(dst) && statSync(dst).size > 0) resolvePromise()
      else reject(new Error(`sips 转换失败 (exit ${code})：${stderr.trim() || '无输出'}`))
    })
  })
}

/**
 * 图片资产派生文件管理：所有派生文件都在缓存目录（v2: .cache/variants）下、
 * 按 <sha256>.<用途>.jpg 命名，可随时删除重建；原始 HEIC/TIFF 永不改动。
 */
export class ImageVariants {
  constructor(private readonly derivedDir: string) {}

  /** 派生文件绝对路径（目录在装配时保证存在） */
  derivedPath(name: string): string {
    return this.path(name)
  }

  private path(name: string): string {
    if (name.includes('/') || name.includes('..')) throw new Error(`非法派生文件名：${name}`)
    return join(this.derivedDir, name)
  }

  /** 确保存在「可直接显示」的文件；返回应使用的 /api variant */
  async ensureDisplay(asset: { id: string; mediaType: string; absOriginal: string }): Promise<'original' | 'display'> {
    if (DIRECTLY_DISPLAYABLE.has(asset.mediaType)) return 'original'
    const dst = this.path(`${asset.id}.display.jpg`)
    if (!existsSync(dst)) await sipsConvertToJpeg(asset.absOriginal, dst, 2400)
    return 'display'
  }

  /**
   * 缩略图（最大边 480 的 JPEG）。
   * 可直接显示的类型（PNG/JPEG/WebP 等）返回原件路径——浏览器 img 自行缩放，
   * 避免 Windows（无 sips）上缩略图永远生成失败；HEIC/TIFF 仍走 sips 派生。
   */
  async ensureThumb(asset: { id: string; mediaType: string; absOriginal: string }): Promise<{ absPath: string; mediaType: string }> {
    if (DIRECTLY_DISPLAYABLE.has(asset.mediaType)) return { absPath: asset.absOriginal, mediaType: asset.mediaType }
    const dst = this.path(`${asset.id}.thumb.jpg`)
    if (!existsSync(dst)) await sipsConvertToJpeg(asset.absOriginal, dst, 480)
    return { absPath: dst, mediaType: 'image/jpeg' }
  }
}
