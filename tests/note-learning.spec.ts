// WP-8：知识块自评状态存在笔记文件（front-matter 的 learning 字段）。
// 关键不变量：自评**不算内容编辑**（不动修订号 revision、不动 updatedAt、不记学习足迹），
// 但随笔记保存管线落盘（冲突保护/关窗冲刷自动生效），且标题/正文保存不会丢自评。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'
import type { NoteLearningState } from '../src/shared/types'

const LEARNING: NoteLearningState = {
  activeId: 'potential',
  records: { potential: { status: 'understood', fingerprint: 'abc123' } }
}

describe('学习自评随笔记文件保存', () => {
  it('保存自评 → 读回一致、写进 front-matter；正文/修订号/最近更新/足迹都不变', async () => {
    const t: TestRepo = await makeTestRepo('wp8-learning-')
    try {
      const created = await t.repo.createNote({ title: '自评笔记', bodyMd: '## 势函数\n\n正文。' })
      const before = t.repo.getNoteFull(created.id).note
      const eventsBefore = t.repo.activityPanel({ range: 'month' }).summary

      const res = await t.repo.saveNote({
        id: created.id, title: '自评笔记', noteType: created.noteType, bodyMd: '## 势函数\n\n正文。',
        aliases: created.aliases, verifiedStatus: created.verifiedStatus, learning: LEARNING
      })
      expect(res.conflict).toBe(false)

      const after = t.repo.getNoteFull(created.id).note
      expect(after.learning).toEqual(LEARNING)
      expect(after.bodyMd).toBe('## 势函数\n\n正文。')       // 正文未被改写
      expect(after.revisionNo).toBe(before.revisionNo)        // 自评不算内容编辑
      expect(after.updatedAt).toBe(before.updatedAt)          // 「最近更新」不被自评刷走
      expect(t.repo.activityPanel({ range: 'month' }).summary.created).toBe(eventsBefore.created) // 不记足迹

      const fileAbs = t.library.index.notes.get(created.id)!.fileAbs
      expect(readFileSync(fileAbs, 'utf8')).toContain('learning:')

      // 重启（重新扫描）后仍在
      const repo2 = await t.reopen()
      expect(repo2.getNoteFull(created.id).note.learning).toEqual(LEARNING)
    } finally { t.dispose() }
  }, 60000)

  it('标题/正文保存不丢自评；显式 null 清空', async () => {
    const t: TestRepo = await makeTestRepo('wp8-keep-')
    try {
      const created = await t.repo.createNote({ title: '保留自评', bodyMd: '正文一' })
      await t.repo.saveNote({
        id: created.id, title: '保留自评', noteType: 'note', bodyMd: '正文一',
        aliases: [], verifiedStatus: 'unchecked', learning: LEARNING
      })

      // 改标题 + 改正文（不带 learning）→ 自评保留
      await t.repo.saveNote({
        id: created.id, title: '保留自评（改名）', noteType: 'note', bodyMd: '正文二',
        aliases: [], verifiedStatus: 'unchecked'
      })
      const kept = t.repo.getNoteFull(created.id).note
      expect(kept.learning).toEqual(LEARNING)
      expect(kept.revisionNo).toBe(2) // 正文变化 → 修订号 +1

      // 显式清空
      await t.repo.saveNote({
        id: created.id, title: '保留自评（改名）', noteType: 'note', bodyMd: '正文二',
        aliases: [], verifiedStatus: 'unchecked', learning: null
      })
      const cleared = t.repo.getNoteFull(created.id).note
      expect(cleared.learning).toBe(null)
      const fileAbs = t.library.index.notes.get(created.id)!.fileAbs
      expect(readFileSync(fileAbs, 'utf8')).not.toContain('learning:')
    } finally { t.dispose() }
  }, 60000)

  it('非法 learning 形状在解析时被忽略（宽容读取，不拖垮笔记）', async () => {
    const t: TestRepo = await makeTestRepo('wp8-bad-')
    try {
      const created = await t.repo.createNote({ title: '坏自评', bodyMd: '正文' })
      const fileAbs = t.library.index.notes.get(created.id)!.fileAbs
      const raw = readFileSync(fileAbs, 'utf8')
      // 手工塞入非法 learning（模拟同步冲突/手改）
      const patched = raw.replace('sources: []', 'sources: []\nlearning:\n  records:\n    x:\n      status: 乱码\n      fingerprint: 5')
      expect(patched).not.toBe(raw)
      await import('node:fs').then((fs) => fs.writeFileSync(fileAbs, patched))

      const repo2 = await t.reopen()
      const note = repo2.getNoteFull(created.id).note
      expect(note.bodyMd).toBe('正文')      // 笔记本身可用
      expect(note.learning).toBe(null)     // 非法自评按无标记处理
    } finally { t.dispose() }
  }, 60000)
})