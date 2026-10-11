import { existsSync, statSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ImageVariants, sipsAvailable, sipsConvertToJpeg } from '../src/main/assets/images'

let derivedDir: string
let variants: ImageVariants

beforeAll(() => {
  derivedDir = mkdtempSync(join(tmpdir(), 'mathwb-img-'))
  variants = new ImageVariants(derivedDir)
})

afterAll(() => {
  rmSync(derivedDir, { recursive: true, force: true })
})

// sips 是 macOS 系统组件；HEIC→JPEG 转换路线在 Windows 上整体跳过（应用内有可读降级提示）
const describeSips = process.platform === 'darwin' ? describe : describe.skip

describeSips('sips 图片派生（HEIC 路线）', () => {
  it('sips 可用（macOS 系统组件）', () => {
    expect(sipsAvailable()).toBe(true)
  })

  it('HEIC → JPEG 显示副本（原件不动）', async () => {
    if (!existsSync('fixtures/photo.heic')) throw new Error('夹具缺失：先 npm run fixtures')
    const srcSize = statSync('fixtures/photo.heic').size
    const v = await variants.ensureDisplay({ id: 'fx1', mediaType: 'image/heic', absOriginal: join('fixtures', 'photo.heic') })
    expect(v).toBe('display')
    const out = join(derivedDir, 'fx1.display.jpg')
    expect(existsSync(out)).toBe(true)
    expect(statSync(out).size).toBeGreaterThan(0)
    expect(statSync('fixtures/photo.heic').size).toBe(srcSize) // 原件未被修改
  })

  it('PNG 无需显示副本', async () => {
    const v = await variants.ensureDisplay({ id: 'fx2', mediaType: 'image/png', absOriginal: join('fixtures', 'photo.png') })
    expect(v).toBe('original')
  })

  it('可直接显示类型（PNG）的缩略图直接返回原件（Windows 无 sips 也能出缩略图）', async () => {
    const t1 = await variants.ensureThumb({ id: 'fx3', mediaType: 'image/png', absOriginal: join('fixtures', 'photo.png') })
    expect(t1.mediaType).toBe('image/png')
    expect(t1.absPath).toBe(join('fixtures', 'photo.png'))
    const t2 = await variants.ensureThumb({ id: 'fx3', mediaType: 'image/png', absOriginal: join('fixtures', 'photo.png') })
    expect(t2).toEqual(t1)
  })

  it('损坏输入产生明确错误', async () => {
    const bad = join(derivedDir, 'bad.heic')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(bad, Buffer.from('not an image'))
    await expect(sipsConvertToJpeg(bad, join(derivedDir, 'bad.jpg'), 480)).rejects.toThrow(/sips/)
  })
})

describe('非 macOS 平台的降级提示', () => {
  it.skipIf(process.platform === 'darwin')('sips 转换给出可读降级提示而非崩溃', async () => {
    expect(sipsAvailable()).toBe(false)
    let msg = ''
    try {
      await sipsConvertToJpeg(join('fixtures', 'photo.png'), join(derivedDir, 'x.jpg'), 100)
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err)
    }
    expect(msg).toContain('暂不支持自动转换')
  })
})
