#!/usr/bin/env node
/**
 * @zhitiaojun/dsh-anysearch-fetch-fallback — 跨平台构建，零 bash 依赖。
 *
 * 用法：
 *   node scripts/build.mjs
 *
 * 本插件只有 host 侧（无 client 半），所以只跑 tsc。
 * 该脚本是 npm `prepare` 的实现：从 GitHub / 市场以 git 依赖安装时会自动执行，
 * 因此「仓库只含源码」也能装完即用（Windows / Linux / macOS 一致）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 解析某个依赖包内的可执行文件；缺失时给出可操作的提示。 */
function requireBin(pkg, rel) {
  const file = join(ROOT, 'node_modules', pkg, rel)
  if (!existsSync(file)) {
    console.error(`build: 缺少构建依赖 ${pkg}（先在项目目录执行 npm install）`)
    process.exit(1)
  }
  return file
}

process.stdout.write('\n=== tsc: src → lib ===\n')
const result = spawnSync(
  process.execPath,
  [requireBin('typescript', join('bin', 'tsc')), '-p', 'tsconfig.json'],
  { cwd: ROOT, stdio: 'inherit' },
)
if (result.error) {
  console.error(`build: tsc 启动失败（${result.error.message}）`)
  process.exit(1)
}
if (result.status !== 0) {
  console.error(`build: tsc 失败（exit ${result.status}）`)
  process.exit(result.status ?? 1)
}

console.log('\n=== build 完成：lib/index.js ===')
