// 跨平台「目录只读」测试助手：制造「写盘必然失败」的环境。
//
// POSIX：chmod 0o500 即可阻止目录内新建文件。
// Windows：目录的只读属性（Node chmod 对目录只改 FILE_ATTRIBUTE_READONLY）
//          **不阻止**在其中新建文件——在 Mac 上写的「写盘失败不留幻影」类用例
//          到 Windows 会假失败（写入成功、断言落空）。改用 icacls 给目录对象
//          本身挂 deny W ACE，挡住 atomicWriteFile 建临时文件的第一步。
//          不带 (OI)(CI) 继承标志：ACE 不传播给已有子文件，恢复时 /remove:d
//          干净撤销、不留残留（带继承的 deny 会固化到子文件里撤不掉）。
import { chmodSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

function icacls(args: string[]): void {
  const r = spawnSync('icacls.exe', args, { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) {
    throw new Error(`icacls ${args.join(' ')} 失败：${(r.stderr || r.stdout || '').trim()}`)
  }
}

export function readonly(dir: string): void {
  if (process.platform === 'win32') {
    icacls([dir, '/deny', `${process.env.USERNAME}:W`])
  } else {
    chmodSync(dir, 0o500)
  }
}

/** 恢复可写：尽力而为，失败不抛——恢复阶段的错误不该掩盖真实断言结果 */
export function writable(dir: string): void {
  try {
    if (process.platform === 'win32') icacls([dir, '/remove:d', process.env.USERNAME!])
    else chmodSync(dir, 0o700)
  } catch {
    /* ignore */
  }
}
