/**
 * dsh-shallow-memory · 纯逻辑层
 *
 * 这里只放可离线测试的东西：store 读写、过期与超量清理、注入渲染。
 * 不认识 cordis，也不 import 任何宿主包 —— 所以 `node --test` 能直接跑。
 *
 * @module dsh-shallow-memory/lib/core
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

export const dshHome = () => {
  const configured = String(process.env.DSH_HOME ?? '').trim()
  return configured || join(homedir(), '.dsh')
}

export const DAY = 86_400_000
export const DEFAULT_TTL_DAYS = 7
export const WARN_DAYS = 2
export const MAX_ENTRIES = 12
export const MAX_CHARS = 1400
export const MAX_EXPIRED = 20

export const now = () => Date.now()
export const newId = () => `${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
export const norm = (value) => String(value ?? '').trim().replace(/\s+/g, ' ')
export const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value))

/** 浅层记忆的存储文件（默认 $DSH_HOME/shallow-memory/store.json）。 */
export function storeFile(config) {
  const configured = norm(config?.storePath)
  if (configured) return isAbsolute(configured) ? configured : join(dshHome(), configured)
  return join(dshHome(), 'shallow-memory', 'store.json')
}

export function loadStore(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object') throw new Error('bad store')
    return {
      version: 1,
      entries: Array.isArray(raw.entries) ? raw.entries.filter((e) => e && typeof e === 'object') : [],
      expired: Array.isArray(raw.expired) ? raw.expired.filter((e) => e && typeof e === 'object') : [],
    }
  } catch {
    return { version: 1, entries: [], expired: [] }
  }
}

export function saveStore(file, store) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}

/** 条目自己的 TTL 优先，否则用全局配置。 */
export const ttlOf = (entry, config) => {
  const own = Number(entry?.ttlDays)
  if (Number.isFinite(own) && own > 0) return own
  const global = Number(config?.ttlDays)
  return Number.isFinite(global) && global > 0 ? global : DEFAULT_TTL_DAYS
}

export const ageDays = (entry) => (now() - Number(entry.updated ?? entry.created ?? now())) / DAY

/**
 * 过期清理：超龄的条目移入 expired（只留最近 MAX_EXPIRED 条），返回被清掉的条目。
 * 只改内存对象，不落盘 —— 由调用方决定是否 saveStore。
 */
export function pruneExpired(store, config) {
  const removed = []
  store.entries = store.entries.filter((entry) => {
    if (ageDays(entry) > ttlOf(entry, config)) {
      removed.push(entry)
      return false
    }
    return true
  })
  if (removed.length) {
    const stamped = removed.map((entry) => ({ ...entry, expiredAt: now() }))
    store.expired = [...store.expired, ...stamped].slice(-MAX_EXPIRED)
  }
  return removed
}

/** 超量清理：按「最久没被提到」挤掉，挤掉的也进 expired（原因记 capacity）。 */
export function enforceCapacity(store, config, keep = 0) {
  const limit = clamp(Math.floor(Number(config?.maxEntries) || MAX_ENTRIES), 1, 200)
  const removed = []
  const sorted = [...store.entries].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
  const survivors = new Set(sorted.slice(0, Math.max(0, limit - keep)).map((entry) => entry.id))
  store.entries = store.entries.filter((entry) => {
    if (survivors.has(entry.id)) return true
    removed.push(entry)
    return false
  })
  if (removed.length) {
    store.expired = [...store.expired, ...removed.map((entry) => ({ ...entry, expiredAt: now(), reason: 'capacity' }))].slice(-MAX_EXPIRED)
  }
  return removed
}

export const remainingDays = (entry, config) => Math.max(0, ttlOf(entry, config) - ageDays(entry))

/** 单条一行的注入形态。 */
export function renderEntry(entry, config) {
  const left = remainingDays(entry, config)
  const warn = clamp(Math.floor(Number(config?.warnDays) || WARN_DAYS), 1, 30)
  const hits = Number(entry.hits ?? 1)
  const badge = left <= warn ? `⏳ 剩 ${left < 1 ? '不到 1' : Math.ceil(left)} 天，快过期` : `剩 ${Math.ceil(left)} 天`
  const detail = hits > 1 ? `${badge} · 提过 ${hits} 次` : badge
  const text = entry.text.length > 200 ? `${entry.text.slice(0, 200)}…` : entry.text
  return `- (${detail}) ${text}`
}

/** 渲染整节；没有任何条目时返回空串，不注入。 */
export function renderSection(store, config) {
  const ttl = clamp(Math.floor(Number(config?.ttlDays) || DEFAULT_TTL_DAYS), 1, 365)
  const cap = clamp(Math.floor(Number(config?.maxChars) || MAX_CHARS), 200, 8000)
  const entries = [...store.entries].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
  const header = `## 浅层记忆 · 自动过期（${ttl} 天没再提到就清掉；珍贵的东西要写进深层记忆）`
  const lines = [header]
  let used = header.length
  for (const entry of entries) {
    const line = renderEntry(entry, config)
    if (used + line.length + 1 > cap) break
    lines.push(line)
    used += line.length + 1
  }
  return lines.length > 1 ? lines.join('\n') : ''
}

/** 完整清单（给 shallow_list 看，不截断）。 */
export function renderList(store, config) {
  const live = [...store.entries].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
  const lines = live.length
    ? live.map((entry) => `${renderEntry(entry, config)}  [key: ${entry.key}]`)
    : ['（浅层记忆是空的）']
  const recent = (store.expired ?? []).slice(-5)
  const trail = recent.length
    ? ['', `最近清掉的 ${recent.length} 条（要留就重新记，或写进深层记忆）：`,
      ...recent.map((entry) => `- ${entry.text.slice(0, 120)}${entry.text.length > 120 ? '…' : ''}（${Math.floor((now() - (entry.expiredAt ?? now())) / DAY)} 天前清掉` +
        `${entry.reason === 'capacity' ? '，因条数超限' : ''}）`)]
    : []
  return [...lines, ...trail].join('\n')
}
