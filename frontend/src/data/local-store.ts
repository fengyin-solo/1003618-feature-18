import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：业务清单与批准后下发的执行核查都放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'
// 跨模块链路数据（如用火批准后下发给检查站、巡护任务的执行核查）单独存一份，
// 避免重置某个业务模块时把别的模块的核查也清掉。
const LINK_KEY = 'forest-fire-patrol:burn-links'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

function readLink<T>(): T | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const raw = window.localStorage.getItem(LINK_KEY)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function writeLink<T>(value: T): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(LINK_KEY, JSON.stringify(value))
  }
}

/** 读取跨模块链路列表（用火执行核查）。 */
export function listLinkItems<T>(name: string): T[] {
  const bucket = readLink<Record<string, T[]>>()
  return bucket?.[name] ? clone(bucket[name]!) : []
}

/** 整条覆盖写回跨模块链路列表。 */
export function saveLinkItems<T>(name: string, items: T[]): void {
  const bucket = readLink<Record<string, T[]>>() ?? {}
  bucket[name] = clone(items)
  writeLink(bucket)
}

export function resetLinkItems(name: string): void {
  const bucket = readLink<Record<string, unknown[]>>()
  if (bucket && name in bucket) {
    delete bucket[name]
    writeLink(bucket)
  }
}

export function linkStorageKey(): string {
  return LINK_KEY
}
