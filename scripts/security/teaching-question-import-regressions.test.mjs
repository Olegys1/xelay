import test from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { importTeachingQuestions as parse } from '../../src/lib/teachingQuestionImport.ts'

test('GIFT rejects conflicting zero-weight correct markers instead of changing the answer key', () => {
  for (const source of [
    'Choose? {=%0%Wrong ~%100%Right}',
    'Name? {=%0%Wrong =Right}',
    'Match? {=%0%A -> One =B -> Two}',
  ]) {
    const result = parse(source, 'gift')
    assert.equal(result.questions.length, 0)
    assert.match(result.issues[0].message, /нульовій вазі/)
  }
  for (const source of ['Choose? {=%100%Right ~%0%Wrong}', 'Choose? {~%100%Right ~%0%Wrong}']) {
    const result = parse(source, 'gift')
    assert.deepEqual(result.issues, [])
    assert.equal(result.questions[0].kind, 'choice')
    assert.equal(result.questions[0].answer, 'a1')
  }
  for (const weight of ['%NaN%', '%..%', '%1.2.3%']) assert.ok(parse(`Choose? {=${weight}Right ~Wrong}`, 'gift').issues.length)
})

test('Moodle cloze rejects conflicting zero weights and retains legitimate alternative answers', () => {
  const xml = prompt => `<quiz><question type="multianswer"><questiontext><text><![CDATA[${prompt}]]></text></questiontext></question></quiz>`
  assert.ok(parse(xml('Answer: {1:SA:=%0%wrong~=right}'), 'moodle_xml').issues.length)
  const result = parse(xml('Answer: {1:SA:=right~=correct}'), 'moodle_xml')
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.questions[0].gaps[0].answers, ['right', 'correct'])
})

test('GIFT preserves mathematical comparisons, escaped delimiters and explicit plain markup', () => {
  const source = '::Comparison::x < 5, y > 3; a < b > c? \\{literal\\} {=A\\=1 ~B\\~2}\n\n::Literal::[plain]<b>literal</b> <x> {=One ~Two}'
  const result = parse(source, 'gift')
  assert.deepEqual(result.issues, [])
  assert.equal(result.questions[0].text, 'x < 5, y > 3; a < b > c? {literal}')
  assert.equal(result.questions[0].options[0].text, 'A=1')
  assert.equal(result.questions[0].options[1].text, 'B~2')
  assert.equal(result.questions[1].text, '<b>literal</b> <x>')
  const html = parse('::HTML::[html]<p>x < 5, y > 3</p><script>bad()</script> {=<b>One</b> ~Two}', 'gift')
  assert.deepEqual(html.issues, [])
  assert.equal(html.questions[0].text, 'x < 5, y > 3')
  assert.equal(html.questions[0].options[0].text, 'One')
})

test('GIFT trailing text, nested braces and truncated blocks get explicit reports', () => {
  for (const source of ['Question {=A ~B} missing suffix', 'Question {=A ~B', 'Question {=A {bad} ~B}', 'Question }']) {
    const result = parse(source, 'gift')
    assert.equal(result.questions.length, 0)
    assert.ok(result.issues.length)
  }
  const tooMany = parse(Array.from({ length: 10000 }, (_, index) => `Question ${index} {TRUE}`).join('\n'), 'gift')
  assert.equal(tooMany.questions.length, 100)
  assert.equal(tooMany.issues.length, 1)
  assert.match(tooMany.issues[0].message, /100/)
})

test('large malformed GIFT and XML stay bounded without regex backtracking or unbounded answer arrays', async () => {
  // A worker imposes a real deadline even if a synchronous parser regression
  // blocks its event loop. Keep inherited preloads, including the CI offline
  // guard; no subprocess or change to the guard is needed. Every sample is
  // below the 2 MiB limit.
  const moduleUrl = new URL('../../src/lib/teachingQuestionImport.ts', import.meta.url).href
  const script = `
    import { parentPort, workerData } from 'node:worker_threads';
    import { importTeachingQuestions as parse } from ${JSON.stringify(moduleUrl)};
    if (workerData.expectOfflineGuard) {
      let denied = false;
      try { await fetch('data:text/plain,offline-guard-check'); }
      catch (error) { denied = error.code === 'SECURITY_TEST_OFFLINE'; }
      if (!denied) throw new Error('The inherited offline guard is not active in the worker');
    }
    const cases = [
      ['gift', '::Broken::\\n' + 'abcd\\n'.repeat(350000)],
      ['gift', '::Broken::\\n' + 'abcd\\n'.repeat(350000) + '{unfinished'],
      ['gift', '::Broken::\\n' + '\\\\'.repeat(1600000) + '{nested{bad}'],
      ['gift', 'Question {' + '=x'.repeat(200000) + '}'],
      ['moodle_xml', '<quiz>' + '<'.repeat(1600000)],
      ['moodle_xml', '<quiz><!--' + 'x'.repeat(1600000)],
      ['moodle_xml', '<quiz ' + 'a'.repeat(1600000) + '></quiz>'],
      ['moodle_xml', '<quiz><question type="essay"><questiontext><text><![CDATA[' + '<script>'.repeat(15000) + ']]></text></questiontext></question></quiz>'],
    ];
    for (const [format, text] of cases) {
      const result = parse(text, format);
      if (!result.issues.length) throw new Error('Malformed input was not reported');
    }
    parentPort.postMessage('bounded');
  `
  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL('data:text/javascript;charset=utf-8,' + encodeURIComponent(script)), {
      // Omit execArgv so Node inherits the parent's applicable flags/preloads.
      // Passing process.execArgv explicitly also includes process-only defaults
      // on some Node/test-runner versions and is rejected by Worker.
      workerData: { expectOfflineGuard: process.execArgv.some(argument => argument.includes('offline-guard.mjs')) },
    })
    let timedOut = false, message
    const deadline = setTimeout(() => { timedOut = true; void worker.terminate() }, 5000)
    worker.once('message', value => { message = value })
    worker.once('error', error => { clearTimeout(deadline); reject(error) })
    worker.once('exit', status => {
      clearTimeout(deadline)
      if (timedOut) reject(new Error('Synchronous parser exceeded the 5 second worker deadline'))
      else resolve({ status, message })
    })
  })
  assert.equal(result.status, 0)
  assert.equal(result.message, 'bounded')
})
