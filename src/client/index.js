/**
 * Browser half of the FreeClaudeCode bundle.
 *
 * It draws one surface: the Settings page ("FreeClaudeCode") that connects the
 * harness to the local fcc proxy — proxy URL, config directory, auto-start,
 * plus test, start, refresh, and save actions.
 *
 * All copy is English. Colors and type come from the host theme tokens, with
 * neutral fallbacks, so the page follows light/dark switching.
 *
 * @module dsh-freeclaudecode-auto/client
 */

/** Dot color per health value. */
const DOT_COLOR = {
  healthy: 'var(--dsw-alias-success, #2f9e6e)',
  degraded: 'var(--dsw-alias-warning, #c98b2f)',
  offline: 'var(--dsw-alias-danger, #c94a4a)',
}

const SETTINGS_URL = '/plugin/freeclaudecode/settings'
const PLUGIN_HEADERS = { accept: 'application/json', 'x-dsh-plugin-request': 'freeclaudecode' }

/** Read the Settings payload. */
async function loadSettings() {
  const response = await fetch(SETTINGS_URL, { headers: PLUGIN_HEADERS })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? `Settings are unavailable (HTTP ${String(response.status)})`)
  return body
}

/** Run one Settings action. */
async function runSettingsAction(action, payload = {}) {
  const response = await fetch(SETTINGS_URL, {
    method: 'POST',
    headers: { ...PLUGIN_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? `The action failed (HTTP ${String(response.status)})`)
  return body
}

/**
 * Create the plugin object the Client loader installs.
 *
 * @param {object} React - the browser React instance from the module table.
 * @returns {{inject: string[], apply: (ctx: object) => void}} the plugin.
 */
export function createPlugin(React) {
  const h = React.createElement

  const style = {
    page: { display: 'grid', gap: 20, maxWidth: 760 },
    heading: { margin: 0, fontSize: 20, fontWeight: 600, lineHeight: '26px', color: 'var(--dsw-alias-text-primary, #ddd)' },
    intro: { margin: 0, fontSize: 13, lineHeight: '19px', color: 'var(--dsw-alias-text-secondary, #999)' },
    card: {
      display: 'grid',
      gap: 12,
      padding: '14px 16px',
      border: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.25))',
      borderRadius: 10,
      background: 'var(--dsw-alias-bg-subtle, rgba(127,127,127,0.06))',
    },
    statusRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12 },
    statusText: { color: 'var(--dsw-alias-text-secondary, #999)' },
    dot: { width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto' },
    field: { display: 'grid', gap: 5 },
    label: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-text-primary, #ddd)' },
    input: {
      width: '100%',
      boxSizing: 'border-box',
      padding: '8px 10px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-strong, rgba(127,127,127,0.35))',
      background: 'var(--dsw-alias-bg-base, transparent)',
      color: 'var(--dsw-alias-text-primary, #ddd)',
      fontSize: 13,
      outline: 'none',
    },
    hint: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-text-tertiary, #888)' },
    checkRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--dsw-alias-text-primary, #ddd)' },
    buttons: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
    button: {
      padding: '7px 12px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-strong, rgba(127,127,127,0.35))',
      background: 'transparent',
      color: 'var(--dsw-alias-text-primary, #ddd)',
      fontSize: 12,
      cursor: 'pointer',
    },
    primary: {
      padding: '7px 14px',
      borderRadius: 8,
      border: '1px solid transparent',
      background: 'var(--dsw-alias-accent, #3b82f6)',
      color: '#fff',
      fontSize: 12,
      fontWeight: 600,
      cursor: 'pointer',
    },
    message: { fontSize: 12, lineHeight: '17px' },
    link: { fontSize: 12, color: 'var(--dsw-alias-link, #4f9cf7)' },
  }

  /** Settings page that connects the harness to a local fcc proxy. */
  function FreeClaudeCodeSettings() {
    const [data, setData] = React.useState(null)
    const [draft, setDraft] = React.useState(null)
    const [busy, setBusy] = React.useState('')
    const [message, setMessage] = React.useState(null)

    const applyPayload = (payload) => {
      setData(payload)
      setDraft({
        enabled: payload.config?.fcc?.enabled !== false,
        baseUrl: payload.config?.fcc?.baseUrl ?? '',
        directory: payload.config?.fcc?.directory ?? '',
        autoStart: payload.config?.fcc?.autoStart !== false,
      })
    }

    const reload = React.useCallback(async (attempt = 0) => {
      try {
        applyPayload(await loadSettings())
      } catch (error) {
        if (attempt < 6) {
          setTimeout(() => { void reload(attempt + 1) }, 700)
          return
        }
        setMessage({ tone: 'error', text: error.message })
      }
    }, [])

    React.useEffect(() => {
      let alive = true
      loadSettings().then((payload) => {
        if (alive) applyPayload(payload)
      }).catch((error) => {
        if (alive) setMessage({ tone: 'error', text: error.message })
      })
      return () => { alive = false }
    }, [])

    if (data === null || draft === null) {
      return h('div', { style: style.page },
        h('h2', { style: style.heading }, 'FreeClaudeCode'),
        h('p', { style: style.intro }, message?.text ?? 'Loading the FreeClaudeCode connection settings…'))
    }

    const status = data.status ?? {}
    const fcc = status.fcc ?? {}
    const pool = status.pool ?? {}
    const health = status.health ?? 'offline'
    const canSave = data.capabilities?.canSave === true
    const adminUrl = typeof fcc.baseUrl === 'string' && fcc.baseUrl !== '' ? `${fcc.baseUrl.replace(/\/+$/u, '')}/admin` : ''

    const update = (key) => (event) => {
      const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value
      setDraft(previous => ({ ...previous, [key]: value }))
    }

    const act = async (action) => {
      setBusy(action)
      setMessage(null)
      try {
        const payload = action === 'save' ? draft : {}
        const result = await runSettingsAction(action, payload)
        if (result.status) setData(previous => ({ ...previous, status: result.status }))
        if (result.restarting === true) {
          setMessage({ tone: 'success', text: result.message ?? 'Saved. The plugin restarts to apply the connection.' })
          setTimeout(() => { void reload() }, 1200)
        } else {
          setMessage({ tone: result.ok ? 'success' : 'error', text: result.message ?? (result.ok ? 'Done.' : 'The action failed.') })
        }
      } catch (error) {
        setMessage({ tone: 'error', text: error.message })
      } finally {
        setBusy('')
      }
    }

    const disabled = busy !== ''

    return h('div', { style: style.page },
      h('h2', { style: style.heading }, 'FreeClaudeCode'),
      h('p', { style: style.intro },
        'Connect DeepSeek Harness to a local Free Claude Code proxy. The models it advertises become available as ',
        h('strong', null, 'Auto (FreeClaudeCode)'),
        ' and its two routing profiles.'),

      h('section', { style: style.card },
        h('div', { style: style.statusRow },
          h('span', { style: { ...style.dot, background: DOT_COLOR[health] ?? DOT_COLOR.offline } }),
          h('strong', { style: { color: 'var(--dsw-alias-text-primary, #ddd)' } }, health),
          h('span', { style: style.statusText },
            fcc.available === true
              ? `· fcc proxy connected · ${String(fcc.models ?? 0)} models`
              : '· fcc proxy not reachable'),
          h('span', { style: style.statusText }, `· pool ${String(pool.ready ?? 0)}/${String(pool.size ?? 0)} ready`),
          adminUrl === '' || fcc.available !== true
            ? null
            : h('a', { href: adminUrl, target: '_blank', rel: 'noreferrer', style: style.link }, 'Open fcc Admin'),
        ),
        fcc.error ? h('div', { style: { ...style.message, color: 'var(--dsw-alias-warning, #c98b2f)' } }, fcc.error) : null,
        h('div', { style: style.hint },
          'The proxy URL is probed on every save and every five minutes. Provider keys and the optional proxy token stay in the fcc environment file; this page never stores secrets.'),
      ),

      h('section', { style: style.card },
        h('label', { style: style.checkRow },
          h('input', { type: 'checkbox', checked: draft.enabled, onChange: update('enabled'), disabled }),
          'Connect through the Free Claude Code proxy'),

        h('div', { style: style.field },
          h('label', { htmlFor: 'freeclaudecode-base-url', style: style.label }, 'Proxy URL'),
          h('input', {
            id: 'freeclaudecode-base-url',
            type: 'url',
            value: draft.baseUrl,
            placeholder: 'http://127.0.0.1:8082',
            spellCheck: false,
            style: style.input,
            onChange: update('baseUrl'),
            disabled,
          }),
          h('div', { style: style.hint }, 'Root of the local fcc proxy. Leave empty to use http://127.0.0.1:8082.'),),

        h('div', { style: style.field },
          h('label', { htmlFor: 'freeclaudecode-directory', style: style.label }, 'Configuration directory'),
          h('input', {
            id: 'freeclaudecode-directory',
            type: 'text',
            value: draft.directory,
            placeholder: '~/.fcc',
            spellCheck: false,
            style: style.input,
            onChange: update('directory'),
            disabled,
          }),
          h('div', { style: style.hint }, 'Where fcc stores .env and its database. Its MODEL and provider keys are read from here.'),),

        h('label', { style: style.checkRow },
          h('input', { type: 'checkbox', checked: draft.autoStart, onChange: update('autoStart'), disabled }),
          'Start fcc-server automatically when the proxy is not running'),

        h('div', { style: style.buttons },
          h('button', { type: 'button', style: style.button, disabled, onClick: () => { void act('test') } },
            busy === 'test' ? 'Testing…' : 'Test connection'),
          h('button', { type: 'button', style: style.button, disabled, onClick: () => { void act('start') } },
            busy === 'start' ? 'Starting…' : 'Start fcc-server'),
          h('button', { type: 'button', style: style.button, disabled, onClick: () => { void act('refresh') } },
            busy === 'refresh' ? 'Refreshing…' : 'Refresh models'),
          canSave
            ? h('button', { type: 'button', style: style.primary, disabled, onClick: () => { void act('save') } },
              busy === 'save' ? 'Saving…' : 'Save connection')
            : null,
        ),
        canSave ? null : h('div', { style: style.hint }, data.capabilities?.reason ?? 'Saving is unavailable in this host.'),
        message === null
          ? null
          : h('div', {
            role: 'status',
            style: {
              ...style.message,
              color: message.tone === 'error'
                ? 'var(--dsw-alias-danger, #c94a4a)'
                : 'var(--dsw-alias-success, #2f9e6e)',
            },
          }, message.text),
      ),
    )
  }

  return {
    inject: ['slots'],
    apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        {
          name: 'settings.section',
          id: 'freeclaudecode',
          order: 18,
          label: () => 'FreeClaudeCode',
        },
        FreeClaudeCodeSettings,
      ))
    },
  }
}
