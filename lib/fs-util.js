/** Small filesystem helpers with best-effort permission tightening on Windows. */

import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Create a directory (recursive) and tighten it to 0700 when the OS allows. */
export async function ensureDir(dir, mode = 0o700) {
  await mkdir(dir, { recursive: true })
  try {
    await chmod(dir, mode)
  } catch {
    // Windows commonly ignores POSIX modes; the caller still gets a usable dir.
  }
}

/** Read JSON, returning `fallback` only when the file does not exist. */
export async function readJson(file, fallback) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    const wrapped = new Error(`JSON 文件格式无效：${file}`)
    wrapped.cause = error
    wrapped.code = 'INVALID_JSON_FILE'
    throw wrapped
  }
}

/**
 * Write one file through a same-directory temporary sibling, then rename.
 * Windows refuses to replace an existing file with rename, so fall back to
 * unlink + rename there; a crash can lose the old file only in that window.
 */
export async function atomicWriteFile(file, data, mode = 0o600) {
  await ensureDir(dirname(file), 0o700)
  const temporary = join(dirname(file), `.${randomBytes(6).toString('hex')}.tmp`)
  await writeFile(temporary, data, { encoding: 'utf8', mode })
  try {
    await chmod(temporary, mode)
  } catch {
    // Best effort.
  }
  try {
    await rename(temporary, file)
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'EPERM' || error?.code === 'EACCES') {
      await rm(file, { force: true })
      await rename(temporary, file)
    } else {
      await rm(temporary, { force: true })
      throw error
    }
  }
}

/** Create a file that did not exist before, without truncating an existing one. */
export async function createFileExclusive(file, data, mode = 0o600) {
  await ensureDir(dirname(file), 0o700)
  const handle = await open(file, 'wx', mode)
  try {
    await handle.writeFile(data, 'utf8')
  } finally {
    await handle.close()
  }
}
