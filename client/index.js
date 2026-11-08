/**
 * GPUStack settings UI.
 *
 * One component, registered twice: as a Settings section (设置 → GPUStack) and
 * as the configure page of the plugin row in the Plugins list. It talks to the
 * loopback-only `/gpustack-ui` API for state, saving, and connection tests, and
 * styles itself with the host theme tokens.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-gpustack',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const NS = 'gpustack'
    const API = '/gpustack-ui'
    const ROW_KEY = 'dsh-plugin-gpustack#gpustack'

    const DICTS = {
      en: {
        nav: 'GPUStack',
        title: 'GPUStack cluster',
        description:
          'Connect one GPUStack cluster. The address and API key are stored locally; the key is encrypted and never enters the conversation.',
        address: 'Cluster address',
        addressPlaceholder: 'http://192.0.2.10:31901',
        addressFromEnv: 'The address comes from GPUSTACK_BASE_URL. Unset it to edit here.',
        apiKey: 'API Key',
        apiKeyPlaceholder: 'gpustack_...',
        apiKeyConfigured: 'Configured',
        apiKeyMissing: 'Not configured',
        apiKeyUnavailable: 'Unreadable',
        apiKeyHint: 'Saved only to the local encrypted store; it is never returned to this page.',
        saveKey: 'Save key',
        clearKey: 'Clear',
        allowWrites: 'Allow write operations (master switch)',
        permissionsTitle: 'Operation permissions',
        masterOff: 'Master switch is off: every write operation is rejected.',
        scopeDeploy: 'Deploy models',
        scopeDeployHint: 'Create deployments (gpustack_deploy_model).',
        scopeUpdate: 'Update specs',
        scopeUpdateHint: 'Replicas, parameters, env (gpustack_update_model).',
        scopeRestart: 'Restart and rollback',
        scopeRestartHint: 'Rebuild or roll back a model (gpustack_model_action).',
        scopeDelete: 'Delete resources',
        scopeDeleteHint: 'Delete models/instances, and DELETE via gpustack_request.',
        scopeRaw: 'Generic API writes',
        scopeRawHint: 'POST/PUT/PATCH via gpustack_request.',
        scopeInference: 'Inference calls',
        scopeInferenceHint: 'Real /v1 requests via gpustack_chat; consumes GPU time.',
        timeout: 'Request timeout (ms)',
        organization: 'Organization id (optional)',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        test: 'Test connection',
        testing: 'Testing…',
        connected: 'Connected',
        failed: 'Failed',
        status: 'Status',
        management: 'Management API',
        inference: 'Inference API',
        models: 'models available',
        files: 'Data directory',
        advanced: 'Advanced',
        hint: 'Hint',
        summary: 'GPUStack cluster',
        summaryUnset: 'No cluster configured yet — open this plugin to configure it.',
      },
      zh: {
        nav: 'GPUStack',
        title: 'GPUStack 集群',
        description:
          '连接一个 GPUStack 集群。地址与 API Key 只保存在本机；密钥加密存储，不会进入会话记录。',
        address: '集群地址',
        addressPlaceholder: 'http://192.0.2.10:31901',
        addressFromEnv: '地址来自环境变量 GPUSTACK_BASE_URL；要在此修改请先取消该变量。',
        apiKey: 'API Key',
        apiKeyPlaceholder: 'gpustack_...',
        apiKeyConfigured: '已配置',
        apiKeyMissing: '未配置',
        apiKeyUnavailable: '无法读取',
        apiKeyHint: '只写入本机加密存储，保存后不会再回显。',
        saveKey: '保存密钥',
        clearKey: '清除',
        allowWrites: '允许写操作（总开关）',
        permissionsTitle: '操作权限',
        masterOff: '总开关关闭时，所有写操作都会被拒绝。',
        scopeDeploy: '部署模型',
        scopeDeployHint: '创建部署（gpustack_deploy_model）。',
        scopeUpdate: '修改规格',
        scopeUpdateHint: '副本、启动参数、env（gpustack_update_model）。',
        scopeRestart: '重启与回滚',
        scopeRestartHint: '整组重建或回退修订（gpustack_model_action）。',
        scopeDelete: '删除资源',
        scopeDeleteHint: '删除模型/实例，以及 gpustack_request 的 DELETE。',
        scopeRaw: '通用接口写操作',
        scopeRawHint: 'gpustack_request 的 POST/PUT/PATCH。',
        scopeInference: '推理调用',
        scopeInferenceHint: '通过 gpustack_chat 发真实 /v1 请求（占用 GPU）。',
        timeout: '请求超时（毫秒）',
        organization: '组织 ID（可选）',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        test: '测试连接',
        testing: '测试中…',
        connected: '连接正常',
        failed: '连接失败',
        status: '状态',
        management: '管理接口',
        inference: '推理接口',
        models: '个可用模型',
        files: '数据目录',
        advanced: '高级',
        hint: '提示',
        summary: 'GPUStack 集群',
        summaryUnset: '还没有配置集群：打开本插件即可配置。',
      },
    }
    DICTS['zh-CN'] = DICTS.zh

    const color = {      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      base: 'var(--dsw-alias-bg-base)',
      accent: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    }

    const styles = {
      page: { display: 'grid', gap: 14, maxWidth: 720, color: color.text, fontSize: 13 },
      title: { margin: 0, fontSize: 16, fontWeight: 600 },
      description: { margin: 0, color: color.muted, lineHeight: 1.6 },
      card: {
        display: 'grid',
        gap: 12,
        padding: 16,
        borderRadius: 10,
        border: `1px solid ${color.border}`,
        background: color.surface,
      },
      field: { display: 'grid', gap: 6 },
      label: { fontSize: 12, fontWeight: 500, color: color.muted },
      input: {
        height: 34,
        padding: '0 10px',
        borderRadius: 8,
        border: `1px solid ${color.borderStrong}`,
        background: color.base,
        color: color.text,
        fontSize: 13,
        outline: 'none',
        width: '100%',
        boxSizing: 'border-box',
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      button: {
        height: 32,
        padding: '0 12px',
        borderRadius: 8,
        border: `1px solid ${color.borderStrong}`,
        background: color.surface,
        color: color.text,
        fontSize: 13,
        cursor: 'pointer',
      },
      primary: {
        height: 32,
        padding: '0 14px',
        borderRadius: 8,
        border: '1px solid transparent',
        background: color.accent,
        color: '#fff',
        fontSize: 13,
        cursor: 'pointer',
      },
      danger: {
        height: 32,
        padding: '0 12px',
        borderRadius: 8,
        border: `1px solid ${color.borderStrong}`,
        background: 'transparent',
        color: color.error,
        fontSize: 13,
        cursor: 'pointer',
      },
      status: { fontSize: 12, lineHeight: 1.6 },
      kv: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', fontSize: 12 },
      checkRow: { display: 'flex', alignItems: 'center', gap: 8 },
    }

    const SCOPE_ROWS = [
      { key: 'deploy', label: 'scopeDeploy', hint: 'scopeDeployHint', write: true },
      { key: 'update', label: 'scopeUpdate', hint: 'scopeUpdateHint', write: true },
      { key: 'restart', label: 'scopeRestart', hint: 'scopeRestartHint', write: true },
      { key: 'delete', label: 'scopeDelete', hint: 'scopeDeleteHint', write: true },
      { key: 'raw', label: 'scopeRaw', hint: 'scopeRawHint', write: true },
      { key: 'inference', label: 'scopeInference', hint: 'scopeInferenceHint', write: false },
    ]

    function textOf(status) {
      if (status === 'ok') return color.success
      if (status === 'unauthorized' || status === 'error' || status === 'unavailable') return color.error
      return color.muted
    }

    function useApi(t) {
      const [state, setState] = useState(null)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)

      const load = useCallback(async () => {
        try {
          const response = await window.fetch(`${API}/state`, { headers: { accept: 'application/json' } })
          const body = await response.json()
          if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`)
          setState(body)
          return body
        } catch (error) {
          setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
          return null
        }
      }, [])

      const write = useCallback(
        async (method, path, body) => {
          const response = await window.fetch(`${API}${path}`, {
            method,
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              'x-gpustack-ui': '1',
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
          const payload = await response.json()
          if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
          return payload
        },
        [],
      )

      const saveConfig = useCallback(
        async (patch) => {
          setBusy('save')
          setNotice(null)
          try {
            const next = await write('POST', '/config', patch)
            setState(next)
            setNotice({ kind: 'ok', text: t('saved') })
            return next
          } catch (error) {
            setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
            return null
          } finally {
            setBusy('')
          }
        },
        [t, write],
      )

      const saveKey = useCallback(
        async (value) => {
          setBusy('key')
          setNotice(null)
          try {
            const next = await write('PUT', '/api-key', { value })
            setState(next)
            setNotice({ kind: 'ok', text: t('saved') })
            return next
          } catch (error) {
            setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
            return null
          } finally {
            setBusy('')
          }
        },
        [t, write],
      )

      const clearKey = useCallback(async () => {
        setBusy('key')
        setNotice(null)
        try {
          const next = await write('DELETE', '/api-key')
          setState(next)
          setNotice({ kind: 'ok', text: t('saved') })
        } catch (error) {
          setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy('')
        }
      }, [t, write])

      const test = useCallback(async () => {
        setBusy('test')
        setNotice(null)
        try {
          const result = await write('POST', '/test')
          setNotice({ kind: result.ok ? 'ok' : 'error', text: result.hint ?? (result.ok ? t('connected') : t('failed')) })
          return result
        } catch (error) {
          setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
          return null
        } finally {
          setBusy('')
        }
      }, [t, write])

      return { state, setState, busy, notice, setNotice, load, saveConfig, saveKey, clearKey, test }
    }

    function Field(props) {
      return h('div', { style: styles.field }, h('label', { style: styles.label }, props.label), props.children)
    }

    function SettingsPage(props) {
      const { view, t } = props
      const api = useApi(t)
      const [baseUrl, setBaseUrl] = useState('')
      const [timeoutMs, setTimeoutMs] = useState('60000')
      const [organizationId, setOrganizationId] = useState('')
      const [allowWrites, setAllowWrites] = useState(true)
      const [permissions, setPermissions] = useState(null)
      const [keyValue, setKeyValue] = useState('')
      const [initialized, setInitialized] = useState(false)
      const [testResult, setTestResult] = useState(null)

      useEffect(() => {
        let alive = true
        api.load().then((state) => {
          if (!alive || state === null || initialized) return
          setBaseUrl(state.baseUrl ?? '')
          setTimeoutMs(String(state.config?.timeoutMs ?? 60000))
          setOrganizationId(state.config?.organizationId ?? '')
          setAllowWrites(state.config?.allowWrites !== false)
          setPermissions(state.config?.permissions ?? null)
          setInitialized(true)
        })
        return () => {
          alive = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      if (view === 'summary') {
        const state = api.state
        return h(
          'div',
          { style: { color: color.muted, fontSize: 13 } },
          state === null
            ? t('summary')
            : state.baseUrl === null
              ? t('summaryUnset')
              : `${t('summary')} · ${state.baseUrl} · API Key ${state.credentials.apiKey === 'available' ? t('apiKeyConfigured') : t('apiKeyMissing')}`,
        )
      }

      const state = api.state
      const credential = state?.credentials?.apiKey ?? 'missing'
      const credentialLabel =
        credential === 'available' ? t('apiKeyConfigured') : credential === 'unavailable' ? t('apiKeyUnavailable') : t('apiKeyMissing')

      const onSave = async () => {
        const patch = {
          baseUrl: baseUrl.trim().length === 0 ? null : baseUrl.trim(),
          allowWrites,
          ...(permissions === null ? {} : { permissions }),
          timeoutMs: Number(timeoutMs),
          organizationId: organizationId.trim().length === 0 ? null : organizationId.trim(),
        }
        if (Number.isNaN(patch.timeoutMs)) {
          api.setNotice({ kind: 'error', text: 'timeoutMs' })
          return
        }
        await api.saveConfig(patch)
      }

      const onTest = async () => {
        const result = await api.test()
        setTestResult(result)
      }

      const noticeColor = api.notice?.kind === 'ok' ? color.success : color.error

      return h(
        'div',
        { style: styles.page },
        view === 'page'
          ? null
          : h('h2', { style: styles.title }, t('title')),
        view === 'page'
          ? null
          : h('p', { style: styles.description }, t('description')),
        h(
          'div',
          { style: styles.card },
          h(
            Field,
            { label: t('address') },
            h('input', {
              style: styles.input,
              value: baseUrl,
              placeholder: t('addressPlaceholder'),
              disabled: state !== null && state.baseUrlEditable === false,
              onChange: (event) => setBaseUrl(event.target.value),
              spellCheck: false,
            }),
            state !== null && state.baseUrlEditable === false
              ? h('div', { style: { ...styles.status, color: color.warn } }, state.hint ?? t('addressFromEnv'))
              : null,
          ),
          h(
            Field,
            { label: `${t('apiKey')}（${credentialLabel}）` },
            h(
              'div',
              { style: styles.row },
              h('input', {
                style: { ...styles.input, flex: '1 1 320px' },
                type: 'password',
                value: keyValue,
                placeholder: t('apiKeyPlaceholder'),
                onChange: (event) => setKeyValue(event.target.value),
                spellCheck: false,
                autoComplete: 'off',
              }),
              h(
                'button',
                {
                  style: styles.button,
                  disabled: api.busy !== '' || keyValue.trim().length === 0,
                  onClick: async () => {
                    const next = await api.saveKey(keyValue.trim())
                    if (next !== null) setKeyValue('')
                  },
                },
                t('saveKey'),
              ),
              credential === 'available'
                ? h(
                    'button',
                    { style: styles.danger, disabled: api.busy !== '', onClick: () => api.clearKey() },
                    t('clearKey'),
                  )
                : null,
            ),
            h('div', { style: { ...styles.status, color: color.muted } }, t('apiKeyHint')),
          ),
          h(
            'div',
            { style: styles.checkRow },
            h('input', {
              id: 'gpustack-allow-writes',
              type: 'checkbox',
              checked: allowWrites,
              onChange: (event) => setAllowWrites(event.target.checked),
            }),
            h('label', { htmlFor: 'gpustack-allow-writes', style: { fontSize: 13 } }, t('allowWrites')),
          ),
          h(
            'div',
            { style: { display: 'grid', gap: 10, paddingTop: 12, borderTop: `1px solid ${color.border}` } },
            h('div', { style: { fontSize: 13, fontWeight: 600 } }, t('permissionsTitle')),
            allowWrites ? null : h('div', { style: { ...styles.status, color: color.warn } }, t('masterOff')),
            ...SCOPE_ROWS.map((row) =>
              h(
                'div',
                {
                  key: row.key,
                  style: {
                    display: 'flex',
                    gap: 8,
                    alignItems: 'flex-start',
                    opacity: row.write && !allowWrites ? 0.55 : 1,
                  },
                },
                h('input', {
                  id: `gpustack-perm-${row.key}`,
                  type: 'checkbox',
                  checked: permissions === null ? true : permissions[row.key] !== false,
                  disabled: row.write && !allowWrites,
                  onChange: (event) =>
                    setPermissions((current) => ({ ...(current ?? {}), [row.key]: event.target.checked })),
                  style: { marginTop: 3 },
                }),
                h(
                  'div',
                  { style: { display: 'grid', gap: 2 } },
                  h('label', { htmlFor: `gpustack-perm-${row.key}`, style: { fontSize: 13 } }, t(row.label)),
                  h('div', { style: { fontSize: 12, color: color.muted } }, t(row.hint)),
                ),
              ),
            ),
          ),
          h(
            'details',
            null,
            h('summary', { style: { cursor: 'pointer', color: color.muted, fontSize: 12 } }, t('advanced')),
            h(
              'div',
              { style: { display: 'grid', gap: 10, marginTop: 10 } },
              h(
                Field,
                { label: t('timeout') },
                h('input', {
                  style: styles.input,
                  value: timeoutMs,
                  inputMode: 'numeric',
                  onChange: (event) => setTimeoutMs(event.target.value),
                }),
              ),
              h(
                Field,
                { label: t('organization') },
                h('input', {
                  style: styles.input,
                  value: organizationId,
                  onChange: (event) => setOrganizationId(event.target.value),
                  spellCheck: false,
                }),
              ),
            ),
          ),
          h(
            'div',
            { style: styles.row },
            h('button', { style: styles.primary, disabled: api.busy !== '', onClick: onSave }, api.busy === 'save' ? t('saving') : t('save')),
            h('button', { style: styles.button, disabled: api.busy !== '', onClick: onTest }, api.busy === 'test' ? t('testing') : t('test')),
            state?.baseUrl != null ? h('span', { style: { color: color.muted, fontSize: 12 } }, state.baseUrl) : null,
          ),
          api.notice !== null
            ? h('div', { style: { ...styles.status, color: noticeColor } }, api.notice.text)
            : null,
          testResult !== null && state !== null
            ? h(
                'div',
                { style: styles.kv },
                h('span', { style: { color: color.muted } }, t('status')),
                h(
                  'span',
                  { style: { color: testResult.ok ? color.success : color.error } },
                  `${testResult.ok ? t('connected') : t('failed')} · ${testResult.version ?? '?'} · ${testResult.durationMs} ms`,
                ),
                h('span', { style: { color: color.muted } }, t('management')),
                h(
                  'span',
                  { style: { color: textOf(testResult.management?.status) } },
                  `${testResult.management?.status ?? '?'}${testResult.management?.username ? ` · ${testResult.management.username}` : ''}`,
                ),
                h('span', { style: { color: color.muted } }, t('inference')),
                h(
                  'span',
                  { style: { color: textOf(testResult.inference?.status) } },
                  `${testResult.inference?.status ?? '?'}${testResult.inference?.modelCount != null ? ` · ${testResult.inference.modelCount} ${t('models')}` : ''}`,
                ),
              )
            : null,
        ),
        state !== null
          ? h(
              'div',
              { style: styles.kv },
              h('span', { style: { color: color.muted } }, t('files')),
              h('span', { style: { color: color.muted, wordBreak: 'break-all' } }, state.files?.dataDir ?? ''),
              h('span', { style: { color: color.muted } }, t('hint')),
              h('span', { style: { color: color.muted } }, state.hint ?? '—'),
            )
          : null,
      )
    }

    function makeComponent(ctx) {
      const t = ctx.locale.bind(NS)
      return function GpuStackSettingsSection(props) {
        const componentProps = useMemo(() => ({ ...props, t }), [t, props])
        return h(SettingsPage, componentProps)
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const dictionaries = ctx.effect(() => {
          const disposers = []
          for (const [locale, dict] of Object.entries(DICTS)) {
            disposers.push(ctx.locale.register(NS, locale, dict))
          }
          return () => {
            for (const dispose of disposers) dispose()
          }
        })
        void dictionaries
        const Component = makeComponent(ctx)
        const label = () => ctx.locale.bind(NS)('nav')

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'gpustack', order: 25, label }, Component),
        )
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register({ name: 'plugins.row.config', key: ROW_KEY }, Component),
        )
      },
    }
  },
})
