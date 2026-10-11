import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 清单目录绝对路径校验（P1-2 修复的防回归锚）：
 * settings.ts 的校验必须同时放行 POSIX 绝对路径与 Windows 盘符路径。
 * electron app 在 vitest 中不可用，故对校验逻辑做静态断言 + 正则行为验证。
 */
describe('清单目录绝对路径校验', () => {
  const re = /^[a-zA-Z]:[/\\]/

  it('Windows 盘符路径（反斜杠/正斜杠）被盘符分支放行', () => {
    expect(re.test('C:\\Users\\kh\\Docs')).toBe(true)
    expect(re.test('C:/Users/kh/Docs')).toBe(true)
    expect(re.test('d:\\temp')).toBe(true)
  })

  it('相对路径不被盘符分支放行（由 startsWith 分支兜底拒绝）', () => {
    expect(re.test('relative/path')).toBe(false)
    expect(re.test('docs/清单')).toBe(false)
  })

  it('settings.ts 含跨平台校验（防回归的静态断言）', () => {
    const src = readFileSync(join(process.cwd(), 'src/main/settings.ts'), 'utf8')
    expect(src).toContain('^[a-zA-Z]:')
    expect(src).toContain("startsWith('/')")
  })
})
