import test from 'node:test'
import assert from 'node:assert/strict'
import { plainTeachingTestContent, splitTeachingTestContent, teachingTestFormulaFromTextPaste, teachingTestLink, wrapTeachingTestFormula } from '../../src/lib/teachingTestContent.ts'
import { readTeachingWordEquations } from '../../src/lib/teachingTestWordMath.ts'

const clipboard = content => ({ getData: type => content[type] || '' })
function element(localName, ...children) {
  return { localName, children: children.filter(child => typeof child !== 'string'),
    textContent: children.map(child => typeof child === 'string' ? child : child.textContent).join(''), getAttribute: () => null }
}

test('text, inline math and safe external URLs have a common ordered representation', () => {
  const source = String.raw`Розв’яжіть \(\frac{1}{2}\) і звірте (https://example.org/wiki/Test_(1)).`
  assert.deepEqual(splitTeachingTestContent(source), [
    { kind: 'text', value: 'Розв’яжіть ' },
    { kind: 'formula', value: String.raw`\frac{1}{2}` },
    { kind: 'text', value: ' і звірте (' },
    { kind: 'link', value: 'https://example.org/wiki/Test_(1)', href: 'https://example.org/wiki/Test_(1)' },
    { kind: 'text', value: ').' },
  ])
  assert.equal(plainTeachingTestContent(source), String.raw`Розв’яжіть \frac{1}{2} і звірте (https://example.org/wiki/Test_(1)).`)
  assert.equal(wrapTeachingTestFormula(String.raw`\(a^2+b^2\)`), String.raw`\(a^2+b^2\)`)
  assert.equal(wrapTeachingTestFormula(String.raw`x\) y \(z`), null)
})

test('pasting explicitly formatted or recognizable LaTeX renders math without treating ordinary prices as equations', () => {
  assert.equal(teachingTestFormulaFromTextPaste(String.raw`\[\frac{3}{2}\]`), String.raw`\(\frac{3}{2}\)`)
  assert.equal(teachingTestFormulaFromTextPaste(String.raw`\sqrt{2}`), String.raw`\(\sqrt{2}\)`)
  assert.equal(teachingTestFormulaFromTextPaste('$x^2$'), String.raw`\(x^2\)`)
  assert.equal(teachingTestFormulaFromTextPaste('Ціна зросла з $2 до $5.'), null)
})

test('non-web schemes, URL credentials and injected markup stay text', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/a', '//example.org', 'https://trusted@example.org', 'https://example.org\\foo', 'https://example.org\n']) {
    assert.equal(teachingTestLink(value), null, value)
  }
  assert.equal(teachingTestLink('HTTPS://Example.org'), 'https://example.org/')
  assert.equal(splitTeachingTestContent('<img onerror=alert(1)> https://user@example.org').some(part => part.kind === 'link'), false)
  assert.deepEqual(splitTeachingTestContent(String.raw`\(\href{https://example.org}{x}\)`), [{ kind: 'formula', value: String.raw`\href{https://example.org}{x}` }])
})

test('Word HTML equation paste extracts OMML from a conditional comment and converts its fraction and exponent', () => {
  const word = '<m:oMath><m:f><m:num><m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:num><m:den><m:r><m:t>3</m:t></m:r></m:den></m:f></m:oMath>'
  const run = value => element('m:r', element('m:t', value))
  const parsed = element('m:oMath', element('m:f', element('m:num', element('m:sSup', element('m:e', run('x')), element('m:sup', run('2')))), element('m:den', run('3'))))
  const result = readTeachingWordEquations(clipboard({ 'text/html': `<img src="https://example.org/never-load"><!--[if gte msEquation 12]>${word}<![endif]-->` }), fragment => {
    assert.equal(fragment, word)
    return parsed
  })
  assert.deepEqual(result, { formulas: [String.raw`\(\frac{{x}^{2}}{3}\)`], recognized: true })
})

test('MathML fallback uses structured root and scripts while unsupported Word structures are marked for photo fallback', () => {
  const math = '<math><mroot><msub><mi>x</mi><mn>2</mn></msub><mn>3</mn></mroot></math>'
  const parsed = element('math', element('mroot', element('msub', element('mi', 'x'), element('mn', '2')), element('mn', '3')))
  assert.deepEqual(readTeachingWordEquations(clipboard({ 'application/mathml+xml': math }), () => parsed), {
    formulas: [String.raw`\(\sqrt[3]{{x}_{2}}\)`], recognized: true,
  })
  assert.deepEqual(readTeachingWordEquations(clipboard({ 'text/html': '<m:oMath><m:foreign/></m:oMath>' }), () => element('m:oMath', element('m:foreign'))), { formulas: [], recognized: true })
  assert.deepEqual(readTeachingWordEquations(clipboard({ 'text/plain': 'Поясніть відповідь' }), () => { throw new Error('plain text is not parsed') }), { formulas: [], recognized: false })
})
