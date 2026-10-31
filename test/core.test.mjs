import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DAY,
  ageDays,
  clamp,
  enforceCapacity,
  loadStore,
  norm,
  pruneExpired,
  renderList,
  renderSection,
  saveStore,
  ttlOf,
} from '../lib/core.js'

const dir = () => mkdtempSync(join(tmpdir(), 'shallow-'))
const entry = (over = {}) => ({
  id: over.id ?? 'e1',
  key: over.key ?? 'k1',
  text: over.text ?? '一句话',
  tags: over.tags ?? [],
  created: over.updated ?? Date.now(),
  updated: over.updated ?? Date.now(),
  hits: over.hits ?? 1,
  ...over,
})

test('norm 压平空白，clamp 夹住上下界', () => {
  assert.equal(norm('  a\n\t b  '), 'a b')
  assert.equal(norm(undefined), '')
  assert.equal(clamp(5, 1, 3), 3)
  assert.equal(clamp(-1, 0, 3), 0)
})

test('空库渲染为空串（不注入噪音）', () => {
  assert.equal(renderSection({ entries: [], expired: [] }, {}), '')
  assert.match(renderList({ entries: [], expired: [] }, {}), /浅层记忆是空的/)
})

test('有内容时渲染标题与剩余天数', () => {
  const store = { entries: [entry()], expired: [] }
  const text = renderSection(store, {})
  assert.match(text, /^## 浅层记忆 · 自动过期（7 天没再提到就清掉/)
  assert.match(text, /剩 7 天/)
})

test('超过 TTL 的条目被移入 expired', () => {
  const old = Date.now() - 8 * DAY
  const store = { entries: [entry({ updated: old, key: 'old' }), entry({ id: 'e2', key: 'fresh' })], expired: [] }
  const removed = pruneExpired(store, {})
  assert.equal(removed.length, 1)
  assert.equal(store.entries.length, 1)
  assert.equal(store.entries[0].key, 'fresh')
  assert.equal(store.expired.length, 1)
  assert.equal(store.expired[0].reason, undefined)
  assert.ok(store.expired[0].expiredAt)
})

test('单条 ttlDays 覆盖全局 TTL', () => {
  const old = Date.now() - 3 * DAY
  const store = { entries: [entry({ updated: old, ttlDays: 2 })], expired: [] }
  assert.equal(ttlOf(store.entries[0], { ttlDays: 30 }), 2)
  assert.equal(pruneExpired(store, { ttlDays: 30 }).length, 1)
})

test('超量时挤掉最久没被提到的，标 reason=capacity', () => {
  const now = Date.now()
  const entries = Array.from({ length: 15 }, (_, i) =>
    entry({ id: `e${i}`, key: `k${i}`, updated: now - i * 1000 }))
  const store = { entries, expired: [] }
  const removed = enforceCapacity(store, { maxEntries: 12 })
  assert.equal(removed.length, 3)
  assert.equal(store.entries.length, 12)
  assert.ok(store.expired.every((e) => e.reason === 'capacity'))
  assert.deepEqual(store.entries.map((e) => e.key).sort(), Array.from({ length: 12 }, (_, i) => `k${i}`).sort())
})

test('快过期条目标 ⏳', () => {
  const store = { entries: [entry({ updated: Date.now() - 6 * DAY })], expired: [] }
  assert.match(renderSection(store, {}), /⏳/)
})

test('store 落盘再读回，坏 JSON 退化为空库', () => {
  const d = dir()
  try {
    const file = join(d, 'nested', 'store.json')
    saveStore(file, { version: 1, entries: [entry()], expired: [] })
    assert.equal(loadStore(file).entries.length, 1)
    saveStore(file, { version: 1, entries: [], expired: [] })
    assert.equal(loadStore(file).entries.length, 0)
    assert.deepEqual(loadStore(join(d, 'missing.json')), { version: 1, entries: [], expired: [] })
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('expired 只留最近 20 条', () => {
  const store = { entries: [], expired: Array.from({ length: 25 }, (_, i) => entry({ id: `x${i}` })) }
  const old = Date.now() - 30 * DAY
  store.entries = Array.from({ length: 3 }, (_, i) => entry({ id: `n${i}`, updated: old }))
  pruneExpired(store, {})
  assert.equal(store.expired.length, 20)
})

test('ageDays 以 updated 优先', () => {
  const e = entry({ created: Date.now() - 10 * DAY, updated: Date.now() - 1 * DAY })
  assert.ok(Math.abs(ageDays(e) - 1) < 0.01)
})
