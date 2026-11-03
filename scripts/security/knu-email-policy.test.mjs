import assert from 'node:assert/strict'
import test from 'node:test'
import { isKnuEmail, normalizeKnuEmail } from '../../src/lib/knuEmailPolicy.ts'

test('KNU mail accepts exact ASCII domain and normalizes case without altering the local address', () => {
  for (const [input, expected] of [
    [' student.name@knu.ua ', 'student.name@knu.ua'],
    ['Teacher_Name@KNU.UA', 'teacher_name@knu.ua'],
    ['student+course@knu.ua', 'student+course@knu.ua'],
    ['a@knu.ua', 'a@knu.ua'],
  ]) {
    assert.equal(normalizeKnuEmail(input), expected)
    assert.equal(isKnuEmail(input), true)
  }
})

test('similar domains, injected separators, malformed local names and metadata never qualify', () => {
  for (const input of [undefined, null, {}, ['student@knu.ua'], '', 'knu.ua', '@knu.ua',
    'student@gmail.com', 'student@knu.ua.example.test', 'student@sub.knu.ua', 'student@fakeknu.ua',
    'student@knu.ua.', 'student@knu．ua', 'student@кnu.ua', 'student@Knu.ua', 'Kate@knu.ua', 'student@knu.ua/anything',
    'student@@knu.ua', 'student@knu.ua@else.test', 'student name@knu.ua',
    'student\nname@knu.ua', 'student\0@knu.ua', '.student@knu.ua', 'student.@knu.ua',
    'student..name@knu.ua', '"student"@knu.ua', 'студент@knu.ua', 'a'.repeat(65) + '@knu.ua',
  ]) {
    assert.equal(normalizeKnuEmail(input), null, String(input))
    assert.equal(isKnuEmail(input), false, String(input))
  }
})
