/**
 * A minimal stand-in for the Cordis plugin context.
 *
 * It records event subscriptions, tool registrations, and disposers exactly as
 * far as this plugin uses them, so `apply()` can be driven end to end in a
 * plain Node test: subscribe the fake harness to the plugin, emit synthetic
 * harness events, and observe the alerts that come out.
 *
 * @module dsh-notify-long/test/helpers/fake-harness
 */

/**
 * @typedef {object} FakeHarnessOptions
 * @property {Record<string, any>} [services] - services `ctx.get(name)` should return
 * @property {any} [entry] - composition entry handed to `apply`
 */

/**
 * Build a fake context plus the driver functions a test needs.
 *
 * @param {FakeHarnessOptions} [options] - harness options
 * @returns {any} the harness
 */
export function createFakeHarness(options = {}) {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  /** @type {any[]} */
  const tools = []
  /** @type {Function[]} */
  const disposers = []
  const logs = []
  const settingsSections = []

  const ctx = {
    logger: {
      info: (format, ...args) => logs.push({ level: 'info', message: `${format} ${args.join(' ')}`.trim() }),
      warn: (format, ...args) => logs.push({ level: 'warn', message: `${format} ${args.join(' ')}`.trim() }),
    },
    get(name) {
      return options.services?.[name]
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== listener))
      }
    },
    effect(callback) {
      const disposer = callback()
      disposers.push(disposer)
      return disposer
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    },
  }

  return {
    ctx,
    settingsSections,
    tools,
    logs,
    listeners,
    /** @param {any} config - composition entry @returns {Promise<any>} the plugin module */
    async mount(config = {}) {
      const module = await import('../../src/index.js')
      await module.apply(ctx, config)
      return module
    },
    /**
     * Emit one harness event to the subscribed listeners, awaiting every result.
     *
     * @param {string} event - event name
     * @param {...any} args - event arguments
     * @returns {Promise<any[]>} the listener results
     */
    async emit(event, ...args) {
      const list = listeners.get(event) ?? []
      const results = []
      for (const listener of list) {
        // Waterfall listeners receive a `next` continuation; everything else
        // receives the raw payload.
        const next = () => Promise.resolve(undefined)
        results.push(await listener(...args, next))
      }
      return results
    },
    /** @param {string} name - event name @returns {number} how many listeners are subscribed */
    count(event) {
      return (listeners.get(event) ?? []).length
    },
    /** @param {string} name - tool name @returns {any} the registered tool, when present */
    tool(name) {
      return tools.find((entry) => entry.name === name)
    },
    /** @returns {string[]} the names of every registered tool */
    toolNames() {
      return tools.map((entry) => entry.name)
    },
    /** @returns {string[]} one line per log entry */
    logLines() {
      return logs.map((entry) => `${entry.level}: ${entry.message}`)
    },
  }
}

/**
 * A settings stub that behaves like `ctx.settings.installSection`: it keeps the
 * base entry and applies patches the way the real service would.
 *
 * @param {object} [options] - stub options
 * @param {any} [options.user] - initial user layer
 * @returns {any} the settings stub
 */
export function createFakeSettings(options = {}) {
  let source = () => undefined
  let user = options.user
  let hooked
  return {
    writable: true,
    installSection(_owner, namespace, _schema, base, hooks) {
      if (namespace !== 'dsh-notify-long') throw new Error(`unexpected namespace ${namespace}`)
      hooked = hooks
      source = () => ({ ...base, ...user })
      hooks.setSource(source)
    },
    get() {
      return source()
    },
    /** Apply a user-layer patch, as `settings.update` would. */
    patch(next) {
      user = { ...user, ...next }
      source = () => ({ ...(hooked === undefined ? {} : {}), ...next })
      hooked?.setSource(() => ({ ...next }))
      hooked?.onChange()
    },
    /** @returns {any} the raw hooks the plugin registered */
    hooks() {
      return hooked
    },
  }
}
