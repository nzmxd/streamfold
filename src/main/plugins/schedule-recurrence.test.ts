import { describe, expect, it } from 'vitest'
import {
  legacyIntervalMinutes,
  minimumPluginScheduleSpacingMinutes,
  nextPluginScheduleOccurrence,
  normalizePluginScheduleCadence
} from './schedule-recurrence'

describe('plugin schedule recurrence', () => {
  it('normalizes legacy intervals and ordered calendar selections', () => {
    expect(normalizePluginScheduleCadence(undefined, 90)).toEqual({
      type: 'interval',
      intervalMinutes: 90
    })
    expect(normalizePluginScheduleCadence({
      type: 'weekly',
      weekdays: [7, 1, 7, 3],
      time: '09:05'
    })).toEqual({
      type: 'weekly',
      weekdays: [1, 3, 7],
      time: '09:05'
    })
    expect(normalizePluginScheduleCadence({
      type: 'monthly',
      monthDays: [31, 1, 15, 1],
      time: '18:30'
    })).toEqual({
      type: 'monthly',
      monthDays: [1, 15, 31],
      time: '18:30'
    })
  })

  it('rejects invalid intervals, times and empty or out-of-range selections', () => {
    expect(() => normalizePluginScheduleCadence(undefined, 4)).toThrow('调度间隔')
    expect(() => normalizePluginScheduleCadence({ type: 'daily', time: '24:00' }))
      .toThrow('执行时间')
    expect(() => normalizePluginScheduleCadence({
      type: 'weekly', weekdays: [], time: '09:00'
    })).toThrow('每周执行日')
    expect(() => normalizePluginScheduleCadence({
      type: 'weekly', weekdays: [0, 8], time: '09:00'
    })).toThrow('每周执行日')
    expect(() => normalizePluginScheduleCadence({
      type: 'monthly', monthDays: [32], time: '09:00'
    })).toThrow('每月执行日')
  })

  it('computes intervals and daily wall-clock occurrences strictly after the cursor', () => {
    const cursor = new Date(2026, 6, 15, 9, 30, 0, 0)
    expect(nextPluginScheduleOccurrence({ type: 'interval', intervalMinutes: 45 }, cursor).getTime())
      .toBe(cursor.getTime() + 45 * 60_000)

    expectLocalDate(
      nextPluginScheduleOccurrence({ type: 'daily', time: '10:15' }, cursor),
      [2026, 7, 15, 10, 15]
    )
    expectLocalDate(
      nextPluginScheduleOccurrence({ type: 'daily', time: '09:30' }, cursor),
      [2026, 7, 16, 9, 30]
    )
  })

  it('chooses the next selected weekday in local time', () => {
    const mondayAfterRun = new Date(2026, 6, 13, 10, 0, 0, 0)
    expectLocalDate(nextPluginScheduleOccurrence({
      type: 'weekly',
      weekdays: [1, 3, 5],
      time: '09:00'
    }, mondayAfterRun), [2026, 7, 15, 9, 0])
  })

  it('skips months that do not contain a selected date', () => {
    const januaryOccurrence = new Date(2026, 0, 31, 9, 0, 0, 0)
    expectLocalDate(nextPluginScheduleOccurrence({
      type: 'monthly',
      monthDays: [31],
      time: '09:00'
    }, januaryOccurrence), [2026, 3, 31, 9, 0])
  })

  it('retains a conservative interval value for legacy database readers', () => {
    expect(legacyIntervalMinutes({ type: 'daily', time: '09:00' })).toBe(1440)
    expect(legacyIntervalMinutes({ type: 'weekly', weekdays: [1], time: '09:00' })).toBe(10080)
    expect(legacyIntervalMinutes({ type: 'monthly', monthDays: [1], time: '09:00' })).toBe(43200)
  })

  it('finds the shortest spacing for contribution rate-limit enforcement', () => {
    expect(minimumPluginScheduleSpacingMinutes({ type: 'daily', time: '09:00' })).toBe(1440)
    expect(minimumPluginScheduleSpacingMinutes({
      type: 'weekly', weekdays: [1], time: '09:00'
    })).toBe(7 * 1440)
    expect(minimumPluginScheduleSpacingMinutes({
      type: 'weekly', weekdays: [1, 7], time: '09:00'
    })).toBe(1440)
    expect(minimumPluginScheduleSpacingMinutes({
      type: 'monthly', monthDays: [1], time: '09:00'
    })).toBe(28 * 1440)
    expect(minimumPluginScheduleSpacingMinutes({
      type: 'monthly', monthDays: [1, 31], time: '09:00'
    })).toBe(1440)
  })
})

function expectLocalDate(actual: Date, expected: [number, number, number, number, number]): void {
  expect([
    actual.getFullYear(),
    actual.getMonth() + 1,
    actual.getDate(),
    actual.getHours(),
    actual.getMinutes()
  ]).toEqual(expected)
}
