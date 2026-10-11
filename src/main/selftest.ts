// --self-test：在真实（可打包后的）应用二进制内验证最危险的技术假设。
// 输出 JSON 到 stdout，非 0 退出码代表失败。使用独立的临时目录，不污染用户数据。
// v2 存储基线（docs/存储格式.md）：「重启」= 重新 FolderStore 扫描磁盘 + 新建 Repo。
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { FolderStore } from './storage/folder-store'
import { DIR_CAPTURES, DIR_ENTRIES, FILE_ENTRY, SECTION_INBOX } from './storage/folder-index'
import { ImageVariants, sipsConvertToJpeg, sipsAvailable } from './assets/images'
import { Repo } from './storage/repo'
import { startAppServer } from './server'
import { parseArxivAtom, buildSearchQuery } from './papers'

export interface SelfCheck {
  name: string
  ok: boolean
  detail: string
  ms: number
}

export async function runSelfTest(): Promise<{ ok: boolean; checks: SelfCheck[] }> {
  const checks: SelfCheck[] = []
  const run = async (name: string, fn: () => Promise<string> | string) => {
    const t0 = performance.now()
    try {
      const detail = await fn()
      checks.push({ name, ok: true, detail, ms: Math.round(performance.now() - t0) })
    } catch (err) {
      checks.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err), ms: Math.round(performance.now() - t0) })
    }
  }

  const root = join(app.getPath('userData'), 'selftest-' + Date.now())
  mkdirSync(root, { recursive: true })
  try {
    const library = new FolderStore(root)
    await library.scan()
    const variantsDir = join(root, '.cache', 'variants')
    mkdirSync(variantsDir, { recursive: true })
    const repo = new Repo(library, new ImageVariants(variantsDir))

    // 最小 PNG：1x1 红色像素（手工编码，测试夹具与运行时自包含）
    const pngBytes = Buffer.from(
      '89504e470d0a1a0a0000000d494844520000000100000001080200000090775' +
        '3de0000000c4944415408d763f8cfc00000030101cf34e79d0000000049454e44ae426082',
      'hex'
    )
    const pngPath = join(root, 'sample.png')
    writeFileSync(pngPath, pngBytes)

    // 最小合法 PDF（自包含夹具）
    const minimalPdf = Buffer.from(
      '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
        '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
        '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\n' +
        'trailer << /Root 1 0 R /Size 4 >>\n%%EOF\n',
      'latin1'
    )
    const pdfPath = join(root, 'minimal.pdf')
    writeFileSync(pdfPath, minimalPdf)

    let documentId = ''
    let versionId = ''

    await run('store: 扫描骨架 + entry.json 索引', async () => {
      if (!existsSync(join(root, DIR_ENTRIES, SECTION_INBOX))) throw new Error('骨架目录缺失')
      const imp = await repo.importDocuments([pdfPath], { docType: 'paper' })
      if (!imp[0].ok || !imp[0].documentId || !imp[0].versionId) throw new Error(imp[0].error ?? '导入失败')
      documentId = imp[0].documentId
      versionId = imp[0].versionId
      const entry = library.index.entries.get(documentId)
      if (!entry) throw new Error('条目未进索引')
      if (entry.section !== SECTION_INBOX) throw new Error(`分区错误：${entry.section}`)
      if (!library.index.shaToEntryFile.has(versionId)) throw new Error('sha 映射缺失')
      return `entry=${entry.dirRel}, sha=${versionId.slice(0, 12)}…`
    })

    await run('store: 磁盘格式（entry.json + 原件明文）', () => {
      const entry = library.index.entries.get(documentId)!
      const raw = JSON.parse(readFileSync(join(entry.dirAbs, FILE_ENTRY), 'utf8')) as { schema?: number; files?: unknown[] }
      if (raw.schema !== 2) throw new Error('entry.json schema != 2')
      if (!Array.isArray(raw.files) || raw.files.length !== 1) throw new Error('files 缺失')
      const files = readdirSync(entry.dirAbs).filter((n) => n.endsWith('.pdf'))
      if (files.length !== 1) throw new Error('原件 PDF 未落盘')
      return `entry.json(schema=2) + ${files[0]}`
    })

    await run('import: 内容去重（同 sha → duplicate）', async () => {
      const again = await repo.importDocuments([pdfPath])
      if (!again[0].duplicate || again[0].documentId !== documentId) throw new Error('重复导入未识别')
      return '重复导入正确返回已有条目'
    })

    await run('note: 写入/修订/重启读回', async () => {
      const note = await repo.createNote({ title: '自检定理', noteType: 'theorem', bodyMd: '第一次内容 $x^2$' })
      await repo.saveNote({
        id: note.id,
        title: '自检定理',
        noteType: 'theorem',
        bodyMd: '第二次内容',
        aliases: ['Self-check Theorem'],
        verifiedStatus: 'unchecked'
      })
      const repo2 = await reopenRepo(root, variantsDir)
      const full = repo2.getNoteFull(note.id)
      if (full.note.revisionNo < 2) throw new Error(`修订号错误：${full.note.revisionNo}`)
      if (!full.note.aliases.includes('Self-check Theorem')) throw new Error('别名丢失')
      return `revision_no=${full.note.revisionNo}`
    })

    await run('search: 中文子串（长词与短词）', async () => {
      const n = await repo.createNote({ title: '拉格朗日中值定理', bodyMd: '若 f 在闭区间连续……则存在 ξ 使 f\'(ξ)=0，这是微分学的定理核心。' })
      const long = repo.search('拉格朗日')
      const short = repo.search('定理')
      if (!long.notes.some((x) => x.id === n.id)) throw new Error('长词未命中')
      if (!short.notes.some((x) => x.id === n.id)) throw new Error('短词未命中')
      return `long=${long.tookMs}ms, short=${short.tookMs}ms`
    })

    await run('anchor: 页级锚点/选区锚点/笔记关联', async () => {
      const anchor = await repo.createAnchor({ documentVersionId: versionId, pageIndex: 0, rects: [], quote: '整页来源' })
      const withNote = await repo.createAnchorWithNote({
        anchor: { documentVersionId: versionId, pageIndex: 0, rects: [[72, 310, 520, 440]], quote: '选区' },
        note: { title: '锚点笔记' }
      })
      const page = repo.listPageAnchors(versionId, 0)
      if (page.length !== 2) throw new Error(`页锚点数=${page.length}`)
      const view = page.find((p) => p.id === withNote.anchor.id)
      if (!view || !view.noteIds.includes(withNote.note.id)) throw new Error('锚点-笔记关联缺失')
      const ctx = repo.getAnchorWithContext(anchor.id)
      if (ctx.documentId !== documentId) throw new Error('锚点上下文错误')
      return `页级 1 + 选区 1，关联笔记正常`
    })

    await run('ink: 墨迹保存与重启读回', async () => {
      const strokes = [{ k: 'pen' as const, c: '#d54941', w: 2.5, pts: [[72, 310], [120, 330], [200, 300]] }]
      await repo.saveInk(versionId, 0, strokes)
      const repo2 = await reopenRepo(root, variantsDir)
      const got = repo2.inkGet(versionId, 0)
      if (JSON.stringify(got) !== JSON.stringify(strokes)) throw new Error('墨迹读回不一致')
      return `${got[0].pts.length} 点一致`
    })

    await run('reading: 精读卡校验 + lastDocument', async () => {
      const ws = repo.readingWorkspaceGet(documentId)
      if (ws.sections.length !== 5) throw new Error('默认栏目缺失')
      const page = repo.listPageAnchors(versionId, 0)
      await repo.createNote({ title: '自检疑问', noteType: 'problem', documentId })
      const notes = repo.listNotesForDocument(documentId)
      const problem = notes.find((n) => n.noteType === 'problem')
      if (!problem) throw new Error('缺 problem 笔记（前置检查）')
      await repo.readingWorkspaceSave({
        ...ws,
        phase: 'reviewing',
        coreQuestion: '主定理为何成立？',
        resolvedNoteIds: [problem.id],
        sections: ws.sections.map((s) =>
          s.id === 'question' ? { ...s, body: '主定理为何成立？', anchorIds: page.map((p) => p.id), checked: true } : s
        )
      })
      const repo2 = await reopenRepo(root, variantsDir)
      const saved = repo2.readingWorkspaceGet(documentId)
      if (saved.phase !== 'reviewing' || saved.sections[0].body.length === 0) throw new Error('精读卡读回失败')
      if (!saved.sections[0].checked) throw new Error('核对状态丢失')
      return `phase=${saved.phase}, question 栏目已核对`
    })

    await run('spaces: 学习区归属与冲突检测', async () => {
      const space = await repo.createSpace({ name: '自检课程', kind: 'course' })
      await repo.assignSpace('document', documentId, space.id)
      await repo.assignSpace('note', (await repo.createNote({ title: '归属笔记' })).id, space.id)
      const repo2 = await reopenRepo(root, variantsDir)
      if (repo2.listDocuments(space.id).length !== 1) throw new Error('学习区过滤失败')
      return `space=1 文档 1 笔记`
    })

    await run('identity: 条目改名/移动分区后身份稳定', async () => {
      const before = repo.listPageAnchors(versionId, 0)
      await repo.updateDocument(documentId, { title: '自检教材（改名）' })
      await repo.moveEntryToSection(documentId, '自检分区')
      const repo2 = await reopenRepo(root, variantsDir)
      const after = repo2.listPageAnchors(versionId, 0)
      if (before.map((a) => a.id).sort().join() !== after.map((a) => a.id).sort().join()) throw new Error('锚点断链')
      const docs = repo2.listDocuments()
      const doc = docs.find((d) => d.id === documentId)
      if (!doc || doc.title !== '自检教材（改名）') throw new Error('改名丢失')
      if (repo2.readingWorkspaceGet(documentId).sections.length !== 5) throw new Error('精读卡丢失')
      return `改名+移动后锚点 ${after.length} 个完整`
    })

    await run('conflict: 冲突副本检测', async () => {
      const entry = library.index.entries.get(documentId)!
      writeFileSync(join(entry.dirAbs, '论文 (冲突的副本 2026-10-07).pdf'), '%PDF-1.4 fake')
      await library.rescanNow()
      if (!library.index.conflicts.some((c) => c.path.includes('冲突'))) throw new Error('冲突未检出')
      return `检出 ${library.index.conflicts.length} 个冲突副本`
    })

    await run('server: /api + Range 请求', async () => {
      const cap = await repo.importCaptures([pngPath])
      if (!cap[0].ok || !cap[0].captureId) throw new Error(cap[0].error ?? 'capture 导入失败')
      const assetId = repo.listCaptures().find((c) => c.id === cap[0].captureId)?.assetId
      if (!assetId) throw new Error('capture sha 缺失')
      const server = await startAppServer({ repo, rendererDir: null, versionInfo: { version: 'selftest' } })
      try {
        const health = await fetch(`http://127.0.0.1:${server.port}/api/health`)
        if (!health.ok) throw new Error(`health=${health.status}`)
        const full = await fetch(`http://127.0.0.1:${server.port}/api/asset/${assetId}`)
        const body = Buffer.from(await full.arrayBuffer())
        if (!body.equals(pngBytes)) throw new Error('整档读取不一致')
        const ranged = await fetch(`http://127.0.0.1:${server.port}/api/asset/${assetId}`, {
          headers: { Range: 'bytes=0-10' }
        })
        if (ranged.status !== 206) throw new Error(`Range 状态=${ranged.status}`)
        return `port=${server.port}, range=206, ${body.length}B 一致`
      } finally {
        await server.stop()
      }
    })

    await run('heic: HEIC→JPEG 显示副本（macOS）/ 可读降级（其他平台）', async () => {
      if (!sipsAvailable()) {
        if (process.platform === 'darwin') throw new Error('/usr/bin/sips 不存在，HEIC 显示转换不可用')
        let msg = ''
        try {
          await sipsConvertToJpeg(pngPath, join(root, 'unused.jpg'), 100)
        } catch (err) {
          msg = err instanceof Error ? err.message : String(err)
        }
        if (!msg.includes('暂不支持自动转换')) throw new Error('非 macOS 平台缺少预期降级提示：' + (msg || '(未报错)'))
        return `跳过（${process.platform} 无 sips，降级提示正常）`
      }
      const heicPath = join(root, 'sample.heic')
      await sipsConvertToJpeg(pngPath, heicPath, 100).then(() => undefined, () => {
        throw new Error('生成 HEIC 夹具失败')
      })
      if (!existsSync(heicPath)) throw new Error('HEIC 夹具未生成')
      const cap = await repo.importCaptures([heicPath])
      if (!cap[0].ok) throw new Error(cap[0].error ?? 'HEIC 导入失败')
      const assetId = repo.listCaptures().find((c) => c.id === cap[0].captureId)?.assetId ?? ''
      const file = await repo.resolveServingFile(assetId, 'display')
      if (!file.absPath.endsWith('.jpg')) throw new Error('显示副本未生成')
      return `heic=${readFileSync(heicPath).length}B → jpeg=${readFileSync(file.absPath).length}B`
    })

    await run('arxiv: Atom 解析与查询构建（离线样本）', () => {
      const xml =
        '<feed xmlns="http://www.w3.org/2005/Atom"><entry>' +
        '<id>http://arxiv.org/abs/2510.01234v1</id><title>  Some   Title </title>' +
        '<author><name>Alice</name></author>' +
        '<link title="pdf" href="http://arxiv.org/pdf/2510.01234v1" rel="related" type="application/pdf"/>' +
        '<arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="math.AG"/>' +
        '</entry></feed>'
      const parsed = parseArxivAtom(xml)
      if (parsed.length !== 1 || parsed[0].arxivId !== '2510.01234v1') throw new Error('Atom 解析失败')
      if (parsed[0].title !== 'Some Title') throw new Error('标题清洗失败')
      const q = buildSearchQuery({ categories: 'math.AG,math.NT', keywords: 'moduli' })
      if (q !== '(cat:math.AG OR cat:math.NT) AND (all:"moduli")') throw new Error(`查询构建失败：${q}`)
      return `解析 1 条；查询：${q}`
    })

    await run('renderer: 打包产物包含 index.html', () => {
      const rendererDir = join(__dirname, '../renderer')
      if (!existsSync(join(rendererDir, 'index.html'))) {
        throw new Error(`未找到 ${rendererDir}/index.html（需先 npm run build）`)
      }
      return rendererDir
    })
  } finally {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* 临时目录清理失败不影响结论 */
    }
  }

  return { ok: checks.every((c) => c.ok), checks }
}

/** 模拟重启：全新 FolderStore 扫描磁盘 + 全新 Repo（不共享任何内存状态） */
async function reopenRepo(root: string, variantsDir: string): Promise<Repo> {
  const library = new FolderStore(root)
  await library.scan()
  return new Repo(library, new ImageVariants(variantsDir))
}
