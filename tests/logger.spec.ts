import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { error as logError, info, initFileLogger, logsEnabled, redactPath } from '../src/main/logger'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mathwb-logger-'))
  initFileLogger(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('文件日志', () => {
  it('写当天日志文件，含级别与 scope', () => {
    info('import', 'created abc')
    logError('bootstrap', new Error('启动失败原因'))
    const files = readdirSync(join(dir, 'logs'))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^main-\d{8}\.log$/)
    const text = readFileSync(join(dir, 'logs', files[0]), 'utf8')
    expect(text).toContain('[import] created abc')
    expect(text).toContain('ERROR [bootstrap] 启动失败原因')
    expect(text).toContain('INFO')
  })

  it('redactPath 折叠中间路径，保留根与末两段', () => {
    expect(redactPath('C:\\Users\\kh\\iCloudDrive\\学习工作台数据\\library.db')).toBe('C:\\…\\学习工作台数据\\library.db')
    expect(redactPath('/home/alice/dev/secret/notes.md')).toBe('/…\\secret\\notes.md')
    expect(redactPath('D:\\repo.ts')).toBe('D:\\repo.ts') // 短路径原样
    expect(redactPath('/var/log/app.log')).toBe('/var/log/app.log') // 三段以内原样
  })

  it('初始化后 logsEnabled 为真；重复初始化无害', () => {
    expect(logsEnabled()).toBe(true)
    initFileLogger(dir)
    expect(logsEnabled()).toBe(true)
    info('x', 'still works')
  })

  it('日志目录在 userData 根下', () => {
    expect(existsSync(join(dir, 'logs'))).toBe(true)
  })

  it('消息格式可 grep：时间戳在行首', () => {
    info('t', 'hello')
    const line = readFileSync(join(dir, 'logs', readdirSync(join(dir, 'logs'))[0]), 'utf8').trim().split('\n').pop()!
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('writeFileSync 用于独立临时文件不干扰日志', () => {
    writeFileSync(join(dir, 'other.txt'), 'not a log')
    expect(existsSync(join(dir, 'other.txt'))).toBe(true)
  })
})
