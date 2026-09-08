// （遗留）生成 cordis_define 一键安装载荷 —— 旧版“动态插件”形态
// 用法：node scripts/build-package.mjs > ronaldo.package.json
//
// ⚠️  该产物面向 DSH 旧版的 cordis_define 工具（code.host / code.client 内嵌源码），
//      默认 profile 不启用 runtime Cordis 工具，且会话级注入无法跨重启保留。
//      新用户请改用官方 bundle 安装：dsh plugin --profile web add github:Stellum-Waq/dsh-pet-ronaldo
//      （bundle 入口为根目录 host.js + client/client.js，assets 随包分发、无需改路径）。
//
// 产物可直接粘贴给 cordis_define 工具（code.host / code.client 已内嵌 src/ 源码）
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const host = readFileSync(join(root, 'src', 'host.js'), 'utf-8')
const client = readFileSync(join(root, 'src', 'client.js'), 'utf-8')

const payload = {
  // cordis_define 参数（kind: "new" 创建新插件）
  plugin: { kind: 'new', idPrefix: 'ronaldo' },
  name: 'C罗桌宠',
  purpose: '在 Web 界面右下角显示葡萄牙 7 号 C罗 chibi 桌宠，随 Agent 工作状态切换动作，对话完成跳起 SIU 庆祝并播放提示音，失败戏剧性摔倒；支持导入自定义 spritesheet 精灵图统一管理。（旧版动态插件形态，见 README）',
  code: { host, client },
}

const out = process.argv[2] || join(root, 'ronaldo.package.json')
if (out === '-') {
  process.stdout.write(JSON.stringify(payload, null, 2))
} else {
  writeFileSync(out, JSON.stringify(payload, null, 2))
  console.log('已生成:', out)
  if (!existsSync(join(root, 'assets', 'spritesheet.webp'))) {
    console.warn('⚠️  注意：assets/spritesheet.webp 不存在，请先放入精灵图')
  }
  if (!existsSync(join(root, 'assets', 'siu.mp3'))) {
    console.warn('⚠️  注意：assets/siu.mp3 不存在，请先放入提示音')
  }
  console.log('⚠️  旧版动态形态：使用前请修改 src/host.js 顶部 CONFIG 的 spritePath / voicePath 为你的本机路径')
}
