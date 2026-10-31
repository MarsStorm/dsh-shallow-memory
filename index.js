/**
 * dsh-shallow-memory — 浅层记忆层（带 TTL）。
 *
 * 三层记忆的分工：
 *   深层  soul-md core.md / topics      —— 稳定的、珍贵的、长期有效的
 *   日记  你自己的日记文件            —— 叙述和感受，不设限
 *   浅层  这里                          —— 有一点价值但大概只热几天的小事
 *
 * 浅层条目每轮注入（很小，可忽略），但每条都有 TTL（默认 7 天）：
 *   · 同一件事再次被提到 → 刷新时间（工具 shallow_touch，或入站消息里出现它的 key/tag 自动刷新）
 *   · 超过 TTL 没被提到  → 自动清掉，写进 expired 尾巴（最近 20 条），腾出注入空间
 *
 * 设计成「宁可记、反正会自己过期」，所以记录成本要极低：一句话 + 一两个 tag。
 *
 * 注入节 name = "shallow:memory"，order 紧跟 soul:memory（0.5）之后。
 * 没有条目时整节返回空串，不产生任何注入噪音。
 *
 * 本文件只留 cordis 粘合层；store 读写、过期清理、渲染都在 ./lib/core.js，
 * 那里不 import 任何宿主包，所以测试可以离线跑。
 *
 * @module dsh-shallow-memory
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  clamp,
  enforceCapacity,
  loadStore,
  newId,
  norm,
  now,
  pruneExpired,
  renderList,
  renderSection,
  saveStore,
  storeFile,
  ttlOf,
} from './lib/core.js'

/** Cordis 插件名 = loader entry id = 设置命名空间。 */
export const name = 'shallow-memory'

/** 需要的宿主服务。 */
export const inject = ['systemPrompt', 'tools']

/** 惰性配置：字段全部可选，组合层留空也能跑。 */
export const Config = undefined

export function apply(ctx, config = {}) {
  const cfg = () => ({ ...(config && typeof config === 'object' ? config : {}) })
  const file = () => storeFile(cfg())

  // 挂载痕迹：宿主什么时候真正跑到了 apply，写一行到 $DSH_HOME/shallow-memory/mount.log。
  // 排查「插件没生效」时先看它——空文件=根本没被加载。
  try {
    mkdirSync(dirname(storeFile(cfg())), { recursive: true })
    appendFileSync(
      join(dirname(storeFile(cfg())), 'mount.log'),
      `[${new Date().toISOString()}] mounted pid=${process.pid}\n`,
    )
  } catch {
    // 记不上也没关系，不影响功能。
  }

  const render = () => {
    try {
      const c = cfg()
      const store = loadStore(file())
      const removed = pruneExpired(store, c)
      if (removed.length) saveStore(file(), store)
      return renderSection(store, c)
    } catch {
      // 注入永不因为浅层记忆出错而拖垮 prompt 组装。
      return ''
    }
  }

  try {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'shallow:memory',
    order: Number.isFinite(Number(cfg().order)) ? Number(cfg().order) : 0.55,
    text: render,
    interpolate: false,
  }), 'shallow-memory.section()')

  const autoKey = (text) => (text.length > 16 ? text.slice(0, 16) : text)

  ctx.tools.register(defineTool({
    name: 'shallow_note',
    description:
      '记一条「浅层记忆」：有一点价值、但大概只热几天的小事（他说过的话、在忙什么、临时偏好、待办感觉）。每条都带 TTL（默认 7 天），期间没再被提到就自动清掉，所以记起来要便宜：一句话，最多几个 tag。珍贵或长期有效的东西不要放这里，写进深层记忆（memory_append / 日记）。同一个 key 再记一次等于刷新过期时间。',
    parameters: {
      text: { type: 'string', required: true, description: '一句话记清楚，自包含，别写「那个」这类指代。' },
      key: { type: 'string', description: '稳定的短标签，用来判定「同一件事」。省略时取正文前 16 字。' },
      tags: { type: 'array', items: { type: 'string' }, description: '可选匹配词（1–6 个）：他消息里出现这些词就算又提到了，自动刷新。' },
      ttlDays: { type: 'number', description: '可选，单条覆盖默认 TTL（1–365 天）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string' },
          refreshed: { type: 'boolean' },
          expiresAt: { type: 'string' },
          count: { type: 'integer' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.refreshed ? 'Refreshed' : 'Noted'} shallow entry "${value.key}" (expires ${value.expiresAt}); ${value.count} live entries.`,
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const text = norm(args.text)
      if (!text) throw new Error('shallow_note: `text` must be non-empty')
      const c = cfg()
      const f = file()
      const store = loadStore(f)
      pruneExpired(store, c)
      const key = norm(args.key) || autoKey(text)
      const tags = Array.isArray(args.tags) ? args.tags.map(norm).filter(Boolean).slice(0, 6) : []
      const ttlDays = Number.isFinite(Number(args.ttlDays)) ? clamp(Math.round(Number(args.ttlDays)), 1, 365) : undefined
      const existing = store.entries.find((entry) => entry.key === key)
      const refreshed = Boolean(existing)
      let entry
      if (existing) {
        entry = existing
        entry.text = text
        entry.updated = now()
        entry.hits = Number(entry.hits ?? 1) + 1
        if (tags.length) entry.tags = tags
        if (ttlDays) entry.ttlDays = ttlDays
      } else {
        entry = { id: newId(), key, text, tags, created: now(), updated: now(), hits: 1, ...(ttlDays ? { ttlDays } : {}) }
        store.entries.push(entry)
      }
      enforceCapacity(store, c)
      saveStore(f, store)
      const ttl = ttlOf(entry, c)
      return {
        key,
        refreshed,
        expiresAt: new Date(entry.updated + ttl * DAY).toISOString().slice(0, 10),
        count: store.entries.length,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'shallow_touch',
    description: '刷新一条浅层记忆的过期时间（他说的东西又提到了、或者你刚才又用上了）。key 或 id 二选一。',
    parameters: {
      key: { type: 'string', description: '条目的 key。' },
      id: { type: 'string', description: '条目的 id。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string' },
          hits: { type: 'integer' },
          expiresAt: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Touched "${value.key}" (${value.hits} hits), now expires ${value.expiresAt}.` }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const c = cfg()
      const f = file()
      const store = loadStore(f)
      const key = norm(args.key)
      const id = norm(args.id)
      if (!key && !id) throw new Error('shallow_touch: pass `key` or `id`')
      const entry = store.entries.find((item) => (key && item.key === key) || (id && item.id === id))
      if (!entry) throw new Error(`shallow_touch: no shallow entry matches ${key || id}`)
      entry.updated = now()
      entry.hits = Number(entry.hits ?? 1) + 1
      saveStore(f, store)
      const ttl = ttlOf(entry, c)
      return {
        key: entry.key,
        hits: entry.hits,
        expiresAt: new Date(entry.updated + ttl * DAY).toISOString().slice(0, 10),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'shallow_list',
    description: '列出全部浅层记忆（含剩余天数、命中次数、key），以及最近被清掉的几条 —— 清之前看一眼，也许其中一条该升级到深层记忆。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' }, count: { type: 'integer' } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      const c = cfg()
      const f = file()
      const store = loadStore(f)
      pruneExpired(store, c)
      return { text: renderList(store, c), count: store.entries.length }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'shallow_forget',
    description: '删掉一条浅层记忆（通常是在把它升级进深层记忆之后）。key 或 id 二选一。',
    parameters: {
      key: { type: 'string', description: '条目的 key。' },
      id: { type: 'string', description: '条目的 id。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { removed: { type: 'integer' }, key: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `Forgot "${value.key}" (${value.removed} removed).` }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const f = file()
      const store = loadStore(f)
      const key = norm(args.key)
      const id = norm(args.id)
      if (!key && !id) throw new Error('shallow_forget: pass `key` or `id`')
      const before = store.entries.length
      store.entries = store.entries.filter((item) => !((key && item.key === key) || (id && item.id === id)))
      const removed = before - store.entries.length
      if (removed) saveStore(f, store)
      return { removed, key: key || id }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'shallow_sweep',
    description: '立刻清一次过期条目（平时每轮注入时会自动清，这个用于手动确认）。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { removed: { type: 'array', items: { type: 'string' } }, count: { type: 'integer' } } },
      render: (_args, value) => [{
        type: 'text',
        text: value.removed.length ? `Swept ${value.removed.length}: ${value.removed.join(' | ')}; ${value.count} left.` : `Nothing expired; ${value.count} live entries.`,
      }],
    },
    isConcurrencySafe: () => false,
    async execute() {
      const c = cfg()
      const f = file()
      const store = loadStore(f)
      const removed = pruneExpired(store, c)
      if (removed.length) saveStore(f, store)
      return { removed: removed.map((entry) => entry.key), count: store.entries.length }
    },
  }))

  // 他说的话里出现了条目的 key/tags → 等于「又提到了」，自动续期。
  // 入站消息的 claim 在 prompt 组装之前，所以续期当轮就可见。
  ctx.on('agent/inbox/claimed', ({ message }) => {
    try {
      if (message?.source?.kind !== 'user') return
      const text = (message.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
      if (!text) return
      const f = file()
      const store = loadStore(f)
      if (!store.entries.length) return
      let touched = 0
      for (const entry of store.entries) {
        const needles = [entry.key, ...(Array.isArray(entry.tags) ? entry.tags : [])]
          .map(norm)
          .filter((needle) => needle.length >= 2)
        if (needles.some((needle) => text.includes(needle))) {
          entry.updated = now()
          entry.hits = Number(entry.hits ?? 1) + 1
          touched += 1
        }
      }
      if (touched) saveStore(f, store)
    } catch {
      // 续期是尽力而为，失败不影响这一轮。
    }
  })
  } catch (error) {
    try {
      appendFileSync(join(dirname(storeFile(cfg())), "mount.log"), `[${new Date().toISOString()}] APPLY FAILED pid=${process.pid} :: ${error && error.stack ? error.stack.split("\n").slice(0,4).join(" | ") : String(error)}\n`)
    } catch {
      // 连日志都写不进就算了。
    }
    throw error
  }
}
