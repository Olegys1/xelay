import test from 'node:test'
import assert from 'node:assert/strict'
import { formatSafeDate, parseSafeDate, safeDateTime } from '../../src/lib/safeDates.ts'

const formatter = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', dateStyle: 'medium' })
test('database special/extended/invalid dates produce a safe fallback', () => {
  for (const value of ['infinity', '-infinity', '280000-01-01T00:00:00Z', '+280000-01-01T00:00:00Z', 'invalid', '', null, undefined, Infinity, new Date(NaN), '0000-01-01T00:00:00Z', '10000-01-01T00:00:00Z']) {
    assert.equal(parseSafeDate(value), null, String(value))
    assert.equal(safeDateTime(value), null)
    assert.equal(formatSafeDate(value, formatter), 'Дату не визначено')
    assert.equal(formatSafeDate(value, formatter, '—'), '—')
  }
})
test('ordinary dates, year bounds and Kyiv formatting remain valid', () => {
  for (const value of ['0001-01-01T00:00:00Z', '2026-10-03T12:15:00Z', '9999-12-30T00:00:00Z', 0, new Date('2026-10-03T12:15:00Z')]) {
    const date = parseSafeDate(value)
    assert.ok(date)
    assert.equal(safeDateTime(value), date.getTime())
    assert.equal(formatSafeDate(value, formatter), formatter.format(date))
  }
})

