/**
 * Per-category operation permissions.
 *
 * `allowWrites` is the master read-only switch; each write category then has
 * its own switch in `permissions`, and `inference` is separate because a chat
 * call consumes GPU time without changing cluster state.
 */

import { GpuStackError } from './errors.js'
import { PERMISSION_DEFAULTS } from './site.js'

export const SCOPE_LABELS = {
  deploy: '部署模型',
  update: '修改规格',
  restart: '重启与回滚',
  delete: '删除资源',
  raw: '通用接口写操作',
  inference: '推理调用',
}

export function permissionsOf(settings) {
  return settings?.config?.permissions ?? { ...PERMISSION_DEFAULTS }
}

/** Whether one category is allowed right now. */
export function isScopeAllowed(settings, scope) {
  const permissions = permissionsOf(settings)
  if (scope === 'inference') return permissions.inference !== false
  if (settings?.config?.allowWrites !== true) return false
  return permissions[scope] !== false
}

/** Throw a structured error when a tool needs a disabled category. */
export function requireScope(settings, scope) {
  if (isScopeAllowed(settings, scope)) return
  const label = SCOPE_LABELS[scope] ?? scope
  const readOnly = settings?.config?.allowWrites !== true
  throw new GpuStackError('PERMISSION_DENIED', `操作被权限设置拒绝：${label}`, {
    hint: readOnly
      ? '写操作总开关已关闭（只读模式）：请让用户在 设置 → GPUStack 打开「允许写操作」，或单独打开对应分类。'
      : `分类「${label}」已关闭：请让用户在 设置 → GPUStack → 操作权限 中打开它。`,
  })
}
