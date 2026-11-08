#!/usr/bin/env node
/**
 * Local provisioning for dsh-plugin-gpustack.
 *
 * The model never runs this script and never sees its input. Run it in your own
 * terminal:
 *
 *   node scripts/dsh-gpustack.mjs setup --base-url http://192.0.2.10:31901
 *   node scripts/dsh-gpustack.mjs set --api-key
 *   node scripts/dsh-gpustack.mjs status
 *   node scripts/dsh-gpustack.mjs test
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { SecretStore } from '../lib/secrets.js'
import { SiteStore, normalizeBaseUrl } from '../lib/site.js'

const API_KEY_REF = 'site:apiKey'

function dataDirFrom(option) {
  if (typeof option === 'string' && option.trim().length > 0) return resolve(option)
  const override = process.env.DSH_GPUSTACK_DATA_DIR
  if (typeof override === 'string' && override.trim().length > 0) return resolve(override)
  const home =
    process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'gpustack')
}

async function promptHidden(question) {
  const stdin = process.stdin
  if (!stdin.isTTY) {
    const chunks = []
    for await (const chunk of stdin) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
  }
  process.stdout.write(question)
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  let value = ''
  return new Promise((resolvePromise, reject) => {
    const finish = (error) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      if (error) reject(error)
    }
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          process.stdout.write('\n')
          finish()
          resolvePromise(value)
          return
        }
        if (char === '\u0003') {
          process.stdout.write('\n')
          finish(new Error('已取消'))
          return
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1)
          continue
        }
        value += char
      }
    }
    stdin.on('data', onData)
  })
}

async function readSecret(values) {
  if (values.stdin === true) {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
  }
  if (typeof values.env === 'string') {
    const value = process.env[values.env]
    if (value === undefined || value.length === 0) throw new Error(`环境变量 ${values.env} 为空`)
    return value
  }
  return promptHidden('GPUStack API Key（输入不回显，形如 gpustack_...）：')
}

async function probe(baseUrl, apiKey, path) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      headers: apiKey === null ? {} : { 'x-api-key': apiKey },
      signal: controller.signal,
    })
    const text = await response.text()
    return { ok: response.ok, status: response.status, text: text.slice(0, 300) }
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      'data-dir': { type: 'string' },
      'base-url': { type: 'string' },
      'api-key': { type: 'boolean' },
      stdin: { type: 'boolean' },
      env: { type: 'string' },
      help: { type: 'boolean' },
    },
  })
  const command = parsed.positionals[0] ?? 'help'
  const values = parsed.values
  const dataDir = dataDirFrom(values['data-dir'])
  const siteStore = new SiteStore({ dir: dataDir })
  const secretStore = new SecretStore({ dir: dataDir })

  if (command === 'help' || values.help === true) {
    console.log('dsh-plugin-gpustack 配置工具')
    console.log('')
    console.log('  setup --base-url <URL>   写入 GPUStack 根地址（可带路径前缀）')
    console.log('  set --api-key            录入 API Key（隐藏输入）')
    console.log('  status                   查看配置与凭据状态')
    console.log('  test                     用已保存的配置访问 /healthz、/version、/v2/users/me')
    console.log('  clear --api-key          删除 API Key')
    console.log('  paths                    打印数据目录')
    console.log('')
    console.log('通用参数：--data-dir <DIR>；set 还支持 --stdin 或 --env <NAME>（脚本化时避免命令行明文）。')
    console.log('也可以在启动 Harness 前设置环境变量 GPUSTACK_BASE_URL / GPUSTACK_API_KEY。')
    console.log(`当前数据目录：${dataDir}`)
    return
  }

  if (command === 'setup') {
    const current = await siteStore.read()
    const baseUrl = values['base-url'] === undefined ? current.baseUrl : normalizeBaseUrl(values['base-url'])
    if (baseUrl === null) throw new Error('缺少 --base-url；示例：--base-url http://192.0.2.10:31901')
    const document = await siteStore.write({ baseUrl })
    console.log(`已写入 ${siteStore.file}`)
    console.log(`  baseUrl: ${document.baseUrl}`)
    console.log('下一步：node scripts/dsh-gpustack.mjs set --api-key')
    return
  }

  if (command === 'status') {
    const site = await siteStore.read()
    console.log(`数据目录: ${dataDir}`)
    console.log(`站点文件: ${siteStore.file}`)
    console.log(`凭据文件: ${secretStore.credentialsFile}`)
    console.log(`baseUrl: ${site.baseUrl ?? '(未配置)'}`)
    console.log(`API Key: ${await secretStore.status(API_KEY_REF)}`)
    if (process.env.GPUSTACK_BASE_URL) console.log('baseUrl: 环境变量 GPUSTACK_BASE_URL 已设置（优先于 site.json）')
    if (process.env.GPUSTACK_API_KEY) console.log('API Key: 环境变量 GPUSTACK_API_KEY 已设置（优先于文件）')
    return
  }

  if (command === 'test') {
    const site = await siteStore.read()
    const baseUrl = process.env.GPUSTACK_BASE_URL || site.baseUrl
    if (!baseUrl) throw new Error('还没有配置 baseUrl；先运行 setup --base-url')
    const apiKey = process.env.GPUSTACK_API_KEY || (await secretStore.get(API_KEY_REF)) || null
    const normalized = normalizeBaseUrl(baseUrl)
    for (const path of ['/healthz', '/version']) {
      const result = await probe(normalized, null, path)
      console.log(`${path}: HTTP ${result.status} ${result.ok ? 'OK' : 'FAILED'} ${result.text.replace(/\s+/g, ' ').slice(0, 120)}`)
    }
    if (apiKey === null) {
      console.log('/v2/users/me: 跳过（还没有录入 API Key）')
      return
    }
    const result = await probe(normalized, apiKey, '/v2/users/me')
    console.log(`/v2/users/me: HTTP ${result.status} ${result.ok ? 'OK' : 'FAILED'} ${result.text.replace(/\s+/g, ' ').slice(0, 200)}`)
    return
  }

  if (command === 'set') {
    if (values['api-key'] !== true) throw new Error('请指定 --api-key')
    const value = await readSecret(values)
    if (value.trim().length === 0) throw new Error('API Key 为空')
    await secretStore.set(API_KEY_REF, value.trim())
    console.log(`已加密保存 API Key：${API_KEY_REF}`)
    console.log('提示：凭据写入本机加密文件，不会进入插件配置或会话记录。')
    return
  }

  if (command === 'clear') {
    if (values['api-key'] !== true) throw new Error('请指定 --api-key')
    console.log(`API Key: ${(await secretStore.delete(API_KEY_REF)) ? '已删除' : '不存在'}`)
    return
  }

  if (command === 'paths') {
    console.log(`数据目录: ${dataDir}`)
    console.log(`站点文件: ${siteStore.file}`)
    console.log(`凭据文件: ${secretStore.credentialsFile}`)
    return
  }

  throw new Error(`未知命令：${command}；运行 node scripts/dsh-gpustack.mjs help`)
}

main().catch((error) => {
  console.error(`错误：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
