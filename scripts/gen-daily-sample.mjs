// 每日论文清单：样本生成器 + 你的邮件脚本对接说明。
//
// 给脚本作者（两行接入）：
//   1. 脚本发完邮件后，把当天候选论文按下面的 JSON 结构写到清单文件夹（默认
//      ~/Documents/数学学习工作台-论文清单/），文件名任意、扩展名 .json；
//   2. 用「临时文件 + 原子改名」写入（如 write tmp.json 然后 rename），避免应用读到半截文件。
//   应用端：每日论文页 →「读取清单文件夹」，或开启「每天自动读取」（仅读本地文件，不联网）。
//
// 运行 `npm run gen:daily-sample` 在清单文件夹生成一份示例（含一个坏条目演示容错）。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const folder = process.env.MATHWB_DAILY_FOLDER ?? join(process.env.HOME ?? '~', 'Documents', '数学学习工作台-论文清单')
mkdirSync(folder, { recursive: true })

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: 'daily-paper-mailer',
  items: [
    {
      provider: 'arxiv',
      providerId: '2601.12345',
      version: 'v2',
      title: 'Moduli Spaces of Stable Sheaves on K3 Surfaces（示例条目）',
      authors: ['Alice Author', 'Bob Collaborator'],
      abstract: '这是脚本生成的示例条目，用于演示清单导入与去重。',
      publishedAt: new Date().toISOString(),
      url: 'https://arxiv.org/abs/2601.12345v2',
      matchedFeeds: ['代数几何每日']
    },
    {
      provider: 'arxiv',
      providerId: '2601.00567',
      title: 'A Note on Calabi-Yau Manifolds（示例条目）',
      authors: ['Carol Chen'],
      abstract: '第二个示例条目，matchedFeeds 留空也能导入。',
      publishedAt: new Date().toISOString(),
      matchedFeeds: []
    },
    {
      provider: 'arxiv',
      providerId: 'not-an-arxiv-id',
      title: '坏条目示例：ID 不合法，导入时会被跳过，不影响其他条目',
      authors: [],
      abstract: '',
      publishedAt: new Date().toISOString()
    }
  ]
}

const target = join(folder, `daily-${new Date().toISOString().slice(0, 10)}.json`)
writeFileSync(target, JSON.stringify(manifest, null, 2))
console.log(`[daily-sample] 已生成 ${target}`)
console.log('[daily-sample] 应用端：每日论文 → 读取清单文件夹（或开启「每天自动读取」）')
