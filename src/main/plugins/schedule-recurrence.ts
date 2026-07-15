import type { PluginScheduleCadence } from '../../shared/plugin-host-contracts'

const MIN_INTERVAL_MINUTES = 5
const MAX_INTERVAL_MINUTES = 525_600
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/

export function normalizePluginScheduleCadence(
  value: unknown,
  legacyIntervalMinutes?: unknown
): PluginScheduleCadence {
  if (value === undefined || value === null) {
    return {
      type: 'interval',
      intervalMinutes: boundedInteger(
        legacyIntervalMinutes,
        MIN_INTERVAL_MINUTES,
        MAX_INTERVAL_MINUTES,
        '调度间隔'
      )
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('运行周期无效')

  const cadence = value as Record<string, unknown>
  switch (cadence.type) {
    case 'interval':
      return {
        type: 'interval',
        intervalMinutes: boundedInteger(
          cadence.intervalMinutes,
          MIN_INTERVAL_MINUTES,
          MAX_INTERVAL_MINUTES,
          '调度间隔'
        )
      }
    case 'daily':
      return { type: 'daily', time: localTime(cadence.time) }
    case 'weekly':
      return {
        type: 'weekly',
        weekdays: selectedDays(cadence.weekdays, 7, '每周执行日'),
        time: localTime(cadence.time)
      }
    case 'monthly':
      return {
        type: 'monthly',
        monthDays: selectedDays(cadence.monthDays, 31, '每月执行日'),
        time: localTime(cadence.time)
      }
    default:
      throw new Error('运行周期类型无效')
  }
}

/** Returns the first occurrence strictly after `after`, using the machine's local timezone. */
export function nextPluginScheduleOccurrence(cadenceInput: PluginScheduleCadence, after: Date): Date {
  const cadence = normalizePluginScheduleCadence(cadenceInput)
  if (!Number.isFinite(after.getTime())) throw new Error('计划起算时间无效')
  if (cadence.type === 'interval') {
    return new Date(after.getTime() + cadence.intervalMinutes * 60_000)
  }

  const [hour, minute] = cadence.time.split(':').map(Number) as [number, number]
  const year = after.getFullYear()
  const month = after.getMonth()
  const day = after.getDate()

  if (cadence.type === 'daily') {
    for (let offset = 0; offset < 3; offset += 1) {
      const candidate = localCandidate(year, month, day + offset, hour, minute)
      if (candidate && candidate.getTime() > after.getTime()) return candidate
    }
  }

  if (cadence.type === 'weekly') {
    const selected = new Set(cadence.weekdays)
    for (let offset = 0; offset < 15; offset += 1) {
      const candidate = localCandidate(year, month, day + offset, hour, minute)
      if (!candidate || !selected.has(isoWeekday(candidate))) continue
      if (candidate.getTime() > after.getTime()) return candidate
    }
  }

  if (cadence.type === 'monthly') {
    for (let monthOffset = 0; monthOffset < 24; monthOffset += 1) {
      const targetMonthStart = new Date(year, month + monthOffset, 1, 12, 0, 0, 0)
      const targetYear = targetMonthStart.getFullYear()
      const targetMonth = targetMonthStart.getMonth()
      for (const targetDay of cadence.monthDays) {
        const candidate = localCandidate(targetYear, targetMonth, targetDay, hour, minute)
        if (!candidate || candidate.getFullYear() !== targetYear || candidate.getMonth() !== targetMonth) continue
        if (candidate.getTime() > after.getTime()) return candidate
      }
    }
  }

  throw new Error('无法计算计划的下次运行时间')
}

export function legacyIntervalMinutes(cadence: PluginScheduleCadence): number {
  switch (cadence.type) {
    case 'interval': return cadence.intervalMinutes
    case 'daily': return 24 * 60
    case 'weekly': return 7 * 24 * 60
    case 'monthly': return 30 * 24 * 60
  }
}

/** Smallest calendar spacing, used to enforce a contribution's declared rate limit. */
export function minimumPluginScheduleSpacingMinutes(
  cadenceInput: PluginScheduleCadence
): number {
  const cadence = normalizePluginScheduleCadence(cadenceInput)
  if (cadence.type === 'interval') return cadence.intervalMinutes
  if (cadence.type === 'daily') return 24 * 60
  if (cadence.type === 'weekly') {
    const gaps = cadence.weekdays.map((day, index) => {
      const next = cadence.weekdays[index + 1] ?? cadence.weekdays[0]! + 7
      return next - day
    })
    return Math.min(...gaps) * 24 * 60
  }

  const cycleStart = Date.UTC(2000, 0, 1)
  const cycleDays = (Date.UTC(2400, 0, 1) - cycleStart) / 86_400_000
  const occurrences: number[] = []
  for (let year = 2000; year < 2400; year += 1) {
    for (let month = 0; month < 12; month += 1) {
      for (const day of cadence.monthDays) {
        const candidate = new Date(Date.UTC(year, month, day))
        if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month) continue
        occurrences.push((candidate.getTime() - cycleStart) / 86_400_000)
      }
    }
  }
  const gaps = occurrences.map((day, index) => {
    const next = occurrences[index + 1] ?? occurrences[0]! + cycleDays
    return next - day
  })
  return Math.min(...gaps) * 24 * 60
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label}无效`)
  }
  return value
}

function localTime(value: unknown): string {
  if (typeof value !== 'string' || !TIME_PATTERN.test(value)) throw new Error('执行时间无效')
  return value
}

function selectedDays(value: unknown, maximum: number, label: string): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new Error(`${label}无效`)
  }
  const days = value.map((day) => boundedInteger(day, 1, maximum, label))
  return [...new Set(days)].sort((left, right) => left - right)
}

function localCandidate(year: number, month: number, day: number, hour: number, minute: number): Date | null {
  const expectedDate = new Date(year, month, day, 12, 0, 0, 0)
  const candidate = new Date(
    expectedDate.getFullYear(),
    expectedDate.getMonth(),
    expectedDate.getDate(),
    hour,
    minute,
    0,
    0
  )
  return candidate.getFullYear() === expectedDate.getFullYear() &&
    candidate.getMonth() === expectedDate.getMonth() &&
    candidate.getDate() === expectedDate.getDate()
    ? candidate
    : null
}

function isoWeekday(value: Date): number {
  return value.getDay() === 0 ? 7 : value.getDay()
}
