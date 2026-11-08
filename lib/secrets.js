/**
 * Encrypted credential store for the GPUStack API key.
 *
 * Values are encrypted with AES-256-GCM under a random 32-byte master key in
 * the same directory (mode 0600, best-effort on Windows). This is not an OS
 * keychain: it prevents accidental reads, not code running as the same user.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile, ensureDir, readJson } from './fs-util.js'
import { registerSecret } from './redact.js'
import { GpuStackError } from './errors.js'

const CREDENTIALS_FILE = 'credentials.json'
const MASTER_KEY_FILE = 'master.key'

export class SecretStore {
  /** @param {{dir: string}} options */
  constructor(options) {
    this.dir = options.dir
    this.credentialsFile = join(options.dir, CREDENTIALS_FILE)
    this.masterKeyFile = join(options.dir, MASTER_KEY_FILE)
    /** @type {Promise<unknown>} */
    this.queue = Promise.resolve()
  }

  /** Whether a value is available without reading/decrypting it. */
  async status(ref) {
    const document = await this.#readDocument()
    const entry = document.entries[ref]
    if (entry === undefined) return 'missing'
    try {
      await readFile(this.masterKeyFile, 'utf8')
      return 'available'
    } catch {
      return 'unavailable'
    }
  }

  /** Resolve one credential; the value stays in this process. */
  async get(ref) {
    const document = await this.#readDocument()
    const entry = document.entries[ref]
    if (entry === undefined) return undefined
    const key = await this.#readMasterKey(false)
    if (key === undefined) {
      throw new GpuStackError('SECRET_KEY_MISSING', '凭据文件存在，但主密钥 master.key 缺失', {
        hint: '请恢复主密钥，或删除 credentials.json 后重新录入 API Key。',
      })
    }
    const value = this.#decrypt(key, ref, entry)
    registerSecret(value)
    return value
  }

  /** Store or replace one credential. */
  async set(ref, value) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new GpuStackError('SECRET_EMPTY', '凭据不能为空', { hint: '请提供非空的 GPUStack API Key。' })
    }
    const run = this.queue.then(async () => {
      await ensureDir(this.dir, 0o700)
      const key = await this.#readMasterKey(true)
      if (key === undefined) {
        throw new GpuStackError('SECRET_KEY_MISSING', '无法创建主密钥', { hint: '请检查数据目录权限。' })
      }
      const document = await this.#readDocument()
      document.entries[ref] = this.#encrypt(key, ref, value)
      await atomicWriteFile(this.credentialsFile, `${JSON.stringify(document, null, 2)}\n`, 0o600)
      registerSecret(value)
    })
    this.queue = run.catch(() => undefined)
    await run
  }

  /** Remove one credential if present. */
  async delete(ref) {
    let removed = false
    const run = this.queue.then(async () => {
      const document = await this.#readDocument()
      if (document.entries[ref] === undefined) return
      delete document.entries[ref]
      removed = true
      await atomicWriteFile(this.credentialsFile, `${JSON.stringify(document, null, 2)}\n`, 0o600)
    })
    this.queue = run.catch(() => undefined)
    await run
    return removed
  }

  async #readDocument() {
    const document = await readJson(this.credentialsFile, { version: 1, entries: {} })
    if (
      document === null ||
      typeof document !== 'object' ||
      document.entries === null ||
      typeof document.entries !== 'object' ||
      Array.isArray(document.entries)
    ) {
      throw new GpuStackError('SECRETS_INVALID', `凭据文件格式无效：${this.credentialsFile}`, {
        hint: '请删除该文件后重新录入凭据。',
      })
    }
    return document
  }

  async #readMasterKey(create) {
    let text
    try {
      text = await readFile(this.masterKeyFile, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      if (!create) return undefined
      await ensureDir(this.dir, 0o700)
      const key = randomBytes(32)
      await atomicWriteFile(this.masterKeyFile, `${key.toString('base64')}\n`, 0o600)
      return key
    }
    const key = Buffer.from(text.trim(), 'base64')
    if (key.length !== 32) {
      throw new GpuStackError('SECRET_KEY_INVALID', `主密钥格式无效：${this.masterKeyFile}`, {
        hint: '主密钥必须是 32 字节的 base64 文本；请恢复主密钥或删除凭据后重新录入。',
      })
    }
    return key
  }

  #encrypt(key, ref, value) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
    cipher.setAAD(Buffer.from(ref, 'utf8'))
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
      updatedAt: new Date().toISOString(),
    }
  }

  #decrypt(key, ref, entry) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'), {
        authTagLength: 16,
      })
      decipher.setAAD(Buffer.from(ref, 'utf8'))
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]).toString('utf8')
    } catch (error) {
      throw new GpuStackError('SECRET_DECRYPT_FAILED', `凭据解密失败：${ref}`, {
        hint: '主密钥与凭据文件不匹配，或凭据文件被篡改；请重新录入该凭据。',
        cause: error,
      })
    }
  }
}
