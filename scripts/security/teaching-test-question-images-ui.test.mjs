import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function importComponent(path, dependencies, globals = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} }
  runInNewContext(code, {
    module, exports: module.exports, ...globals,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), name)
      return dependencies[name]
    },
  })
  return module.exports
}

const imageLib = importComponent('../../src/lib/teachingTestQuestionImages.ts', { './supabase': {} })
const jsx = (type, props) => ({ type, props })
const nodes = value => value == null || typeof value !== 'object' ? [] : Array.isArray(value)
  ? value.flatMap(nodes)
  : [value, ...nodes(value.props?.children)]
const photo = (pixels, name = 'question.jpg') => new File([pixels], name, { type: 'image/jpeg' })

function harness({ images = [], stored = new Map(), prepare } = {}) {
  const cells = []
  const uploads = []
  let index = 0
  let tree
  let cleanup
  const react = {
    useState(initial) {
      const position = index++
      const cell = cells[position] ??= { value: initial }
      return [cell.value, value => { cell.value = typeof value === 'function' ? value(cell.value) : value }]
    },
    useRef(initial) {
      return cells[index++] ??= { current: initial }
    },
    useEffect(effect) {
      const position = index++
      if (!cells[position]) {
        cells[position] = true
        cleanup = effect()
      }
    },
  }
  const { TeachingTestQuestionImageEditor } = importComponent('../../src/components/teaching/TeachingTestQuestionImages.tsx', {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'lucide-react': { ImagePlus: 'ImagePlus', Trash2: 'Trash2' },
    './TeachingUI': { TeachingButton: 'TeachingButton', TeachingField: 'TeachingField', teachingInput: 'input' },
    '../../lib/teachingTestQuestionImages': {
      ...imageLib,
      prepareTeachingTestImage: prepare || (async file => Buffer.from(await file.arrayBuffer()).toString('base64')),
      async uploadTeachingTestQuestionImage(courseId, userId, encoded, signal) {
        signal.throwIfAborted()
        assert.equal(courseId, 'synthetic-course')
        assert.equal(userId, 'synthetic-teacher')
        assert.equal(typeof encoded, 'string')
        const id = `10000000-0000-4000-8000-${String(stored.size + 1).padStart(12, '0')}`
        uploads.push(encoded)
        stored.set(id, encoded)
        return { id, mime_type: 'image/jpeg', alt: '' }
      },
      async loadTeachingTestQuestionImage(id, signal) {
        signal.throwIfAborted()
        assert.ok(stored.has(id), id)
        return `data:image/jpeg;base64,${stored.get(id)}`
      },
    },
  }, { AbortController, Error })
  function render() {
    index = 0
    tree = TeachingTestQuestionImageEditor({
      images,
      imageUpload: { courseId: 'synthetic-course', userId: 'synthetic-teacher' },
      onChange: next => { images = next },
    })
  }
  render()
  return {
    uploads,
    stored,
    get images() { return images },
    unmount() { cleanup?.() },
    pick(files) {
      const input = nodes(tree).find(node => node.type === 'input' && node.props.type === 'file')
      const currentTarget = { files, value: 'question.jpg' }
      input.props.onChange({ currentTarget })
      assert.equal(currentTarget.value, '')
    },
    async flush() {
      await new Promise(resolve => setImmediate(resolve))
      render()
    },
  }
}

test('the question picker attaches one copy per prepared photo, including after reopening the editor', async () => {
  const run = harness()
  run.pick([photo('abc'), photo('abc', 'renamed.jpg'), photo('def')])
  await run.flush()
  assert.equal(run.uploads.length, 2)
  assert.equal(run.images.length, 2)

  run.pick([photo('abc')])
  await run.flush()
  assert.equal(run.uploads.length, 2)
  assert.equal(run.images.length, 2)
  run.unmount()

  const reopened = harness({ images: run.images, stored: run.stored })
  reopened.pick([photo('def', 'another-name.jpg')])
  await reopened.flush()
  assert.equal(reopened.uploads.length, 0)
  assert.equal(reopened.images.length, 2)

  reopened.pick([photo('ghi')])
  await reopened.flush()
  assert.equal(reopened.uploads.length, 1)
  assert.equal(reopened.images.length, 3)

  reopened.pick([photo('jkl')])
  await reopened.flush()
  assert.equal(reopened.uploads.length, 1)
  assert.equal(reopened.images.length, 3)
  reopened.unmount()
})

test('overlapping picker events run only one attachment upload while preparation is pending', async () => {
  let finishPreparation
  let preparationCount = 0
  const pending = new Promise(resolve => { finishPreparation = resolve })
  const run = harness({ prepare: () => { preparationCount++; return pending } })
  run.pick([photo('abc')])
  run.pick([photo('abc')])
  await run.flush()
  assert.equal(preparationCount, 1)
  assert.equal(run.uploads.length, 0)
  finishPreparation('YWJj')
  await run.flush()
  assert.equal(run.uploads.length, 1)
  assert.equal(run.images.length, 1)
  run.unmount()
})

test('duplicate saved references do not consume a visible question photo slot', () => {
  const image = number => ({ id: `10000000-0000-4000-8000-00000000000${number}`, mime_type: 'image/jpeg', alt: '' })
  const first = { ...image(1), alt: 'Original description' }
  const second = image(2)
  const third = image(3)
  const readable = imageLib.readableTeachingTestQuestionImages([
    first, { ...first, alt: 'Duplicate description' }, second, third, image(4),
  ])
  assert.deepEqual(Array.from(readable), [first, second, third])
})
