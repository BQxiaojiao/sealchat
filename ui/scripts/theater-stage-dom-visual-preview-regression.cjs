// Edit-time DOM visual preview for DOM-backed stage objects (webpage/text/group with DOM descendants).
// Run with node scripts/theater-stage-dom-visual-preview-regression.cjs.
// Uses real StageStore, sync diffing and Konva nodes; StageApp handlers are extracted from source.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const { parse } = require('@vue/compiler-sfc')
const root = path.resolve(__dirname, '..')
const stageDir = path.join(root, 'src/views/theater/stage')
const originalLoad = Module._load
const originalResolve = Module._resolveFilename
Module._load = function (request, ...args) {
  if (request === '@/stores/_config') return { api: {} }
  if (request === '@/stores/chat') return { chatEvent: { on() {}, off() {} } }
  return originalLoad.call(this, request, ...args)
}
Module._resolveFilename = function (request, parent, ...args) {
  if (request.startsWith('@/')) request = path.join(root, 'src', request.slice(2))
  return originalResolve.call(this, request, parent, ...args)
}
const transpile = (source, fileName = 'inline.ts') => ts.transpileModule(source, {
  fileName, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText
require.extensions['.ts'] = (module, filename) => module._compile(transpile(fs.readFileSync(filename, 'utf8'), filename), filename)
global.crypto ||= require('node:crypto').webcrypto

const { watch, ref } = require('vue')
const { createTheaterStageStore } = require('../src/views/theater/stage/StageStore.ts')
const { WORLD_UNIT_PX } = require('../src/views/theater/shared/stage-types.ts')
const { stageObjectHasDomVisualDescendant } = require('../src/views/theater/stage/stage-layer-order.ts')
const {
  createStageDomVisualPreview,
  resolveStageDomVisualTransform,
} = require('../src/views/theater/stage/stage-dom-visual-preview.ts')
const { theaterSyncTesting: sync } = require('../src/views/theater/sync/TheaterSyncClient.ts')

const readSfc = name => parse(fs.readFileSync(path.join(stageDir, name), 'utf8')).descriptor
const app = readSfc('StageApp.vue')
const appAst = ts.createSourceFile('StageApp.ts', app.scriptSetup.content, ts.ScriptTarget.Latest, true)
const declaration = name => {
  const statement = appAst.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(value => value.name.getText(appAst) === name))
  assert.ok(statement, `missing StageApp declaration ${name}`)
  return statement.getText(appAst)
}

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`)
const countUndoSteps = (store) => {
  let steps = 0
  while (store.undo()) steps += 1
  return steps
}

async function run() {
  const Konva = (await import('konva')).default
  Konva.Util.createCanvasElement = () => ({ style: {}, getContext: () => ({ scale() {}, clearRect() {} }) })
  Konva.autoDrawEnabled = false

  // Mirrors updateObjectNode's x/y/offset/rotation/scale placement.
  const nodes = new Map()
  const nodeFor = (object) => {
    const width = Math.max(0.5, object.transform.width) * WORLD_UNIT_PX
    const height = Math.max(0.5, object.transform.height) * WORLD_UNIT_PX
    const node = new Konva.Group({
      x: object.transform.x * WORLD_UNIT_PX,
      y: object.transform.y * WORLD_UNIT_PX,
      offsetX: width / 2,
      offsetY: height / 2,
      rotation: object.transform.rotation,
      scaleX: object.transform.scaleX,
      scaleY: object.transform.scaleY,
    })
    node.setAttr('stageObjectId', object.id)
    nodes.set(object.id, node)
    return node
  }
  const frames = []
  let cancelled = 0
  const makePreview = store => createStageDomVisualPreview({
    getNode: id => nodes.get(id),
    hasDomVisual: (id) => {
      const object = store.activeObjects.value[id]
      return Boolean(object && stageObjectHasDomVisualDescendant(object, store.activeObjects.value))
    },
    requestFrame: (callback) => { frames.push(callback); return frames.length },
    cancelFrame: () => { cancelled += 1; frames.length = 0 },
  })
  const runFrame = () => {
    const pending = frames.splice(0)
    pending.forEach(callback => callback())
    return pending.length
  }

  // Real applyObjectNodeTransform from StageApp; updateObjectNode only re-syncs the node.
  const applyObjectNodeTransform = new Function('WORLD_UNIT_PX', 'updateObjectNode', transpile(`
    ${declaration('applyObjectNodeTransform')}
    return applyObjectNodeTransform
  `))(WORLD_UNIT_PX, () => {})

  // 1. Webpage drag: DOM visual follows each frame, the store is written once at dragend.
  {
    const store = createTheaterStageStore()
    const page = store.addObject('iframe')
    const node = nodeFor(page)
    const preview = makePreview(store)
    const start = { ...page.transform }
    const documentBefore = sync.documentFromWorkspace(store.getSnapshot())
    let storeWrites = 0
    const stopWatch = watch(() => ({ ...store.activeObjects.value[page.id].transform }), () => { storeWrites += 1 }, { flush: 'sync', deep: true })

    store.beginObjectEdit('移动对象')
    for (let step = 1; step <= 4; step += 1) {
      node.x(node.x() + 25)
      preview.schedule([page.id])
      node.y(node.y() - 10)
      preview.schedule([page.id])
      assert.equal(runFrame(), 1, 'multiple dragmove events in one frame coalesce into one sync')
      const visual = resolveStageDomVisualTransform(store.activeObjects.value[page.id], preview.transforms)
      close(visual.x, start.x + (step * 25) / WORLD_UNIT_PX, 'DOM visual x follows node in real time')
      close(visual.y, start.y - (step * 10) / WORLD_UNIT_PX, 'DOM visual y follows node in real time')
      assert.deepEqual({ ...store.activeObjects.value[page.id].transform }, start, 'store transform untouched mid-gesture')
    }
    assert.equal(storeWrites, 0, 'no store writes during dragmove')
    assert.equal(sync.diffDocuments(documentBefore, sync.documentFromWorkspace(store.getSnapshot())).length, 0, 'nothing to sync mid-gesture')

    const lastPreview = { ...preview.transforms[page.id] }
    // Same steps as the wrapper dragend handler.
    const current = store.activeObjects.value[page.id]
    current.transform.x = Number((node.x() / WORLD_UNIT_PX).toFixed(6))
    current.transform.y = Number((node.y() / WORLD_UNIT_PX).toFixed(6))
    store.commitObjectEdit()
    preview.clear()
    stopWatch()
    assert.equal(Object.keys(preview.transforms).length, 0, 'temporary state cleared after commit')
    const formal = resolveStageDomVisualTransform(store.activeObjects.value[page.id], preview.transforms)
    assert.ok(Math.abs(formal.x - lastPreview.x) < 1e-6 && Math.abs(formal.y - lastPreview.y) < 1e-6, 'formal transform takes over at the previewed spot (no jump back)')
    assert.equal(storeWrites, 2, 'only the final x/y commit writes the store')
    const mutations = sync.diffDocuments(documentBefore, sync.documentFromWorkspace(store.getSnapshot()))
    assert.equal(mutations.length, 1, 'one sync mutation for the whole gesture')

    // A frame still pending when the gesture ends is cancelled and never re-applies.
    node.x(node.x() + 50)
    preview.schedule([page.id])
    assert.equal(frames.length, 1)
    preview.clear()
    assert.equal(cancelled, 1)
    assert.equal(runFrame(), 0)
    assert.equal(Object.keys(preview.transforms).length, 0)
    assert.equal(countUndoSteps(store), 2, 'one history entry for the drag (plus the add)')
  }

  // 2. Transformer resize/rotate: DOM follows by CSS scale; formal transform bakes width/height on end.
  {
    const store = createTheaterStageStore()
    const page = store.addObject('iframe')
    const text = store.addObject('text')
    const pageNode = nodeFor(page)
    const textNode = nodeFor(text)
    const preview = makePreview(store)
    const before = { ...page.transform }
    store.beginObjectEdit('批量变换对象')
    pageNode.setAttrs({ scaleX: 1.5, scaleY: 0.5, rotation: 30, x: pageNode.x() + 40 })
    textNode.setAttrs({ rotation: -15 })
    // transformer.on('transform') schedules every attached node.
    preview.schedule([pageNode, textNode].map(node => String(node.getAttr('stageObjectId') || '')))
    assert.equal(runFrame(), 1)
    const visual = resolveStageDomVisualTransform(store.activeObjects.value[page.id], preview.transforms)
    close(visual.x, before.x + 40 / WORLD_UNIT_PX, 'DOM visual x follows transform')
    close(visual.y, before.y, 'DOM visual y follows transform')
    assert.deepEqual([visual.rotation, visual.scaleX, visual.scaleY], [30, 1.5, 0.5], 'DOM visual rotation/scale follow transformer')
    assert.equal(preview.transforms[text.id].rotation, -15, 'DOM text follows rotation')
    assert.equal(store.activeObjects.value[page.id].transform.width, before.width, 'no width write (no iframe reflow) mid-gesture')
    assert.deepEqual({ ...store.activeObjects.value[page.id].transform }, before)

    const previewBox = { width: before.width * visual.scaleX, height: before.height * visual.scaleY }
    applyObjectNodeTransform(pageNode, store.activeObjects.value[page.id])
    applyObjectNodeTransform(textNode, store.activeObjects.value[text.id])
    store.commitObjectEdit()
    preview.clear()
    const formal = resolveStageDomVisualTransform(store.activeObjects.value[page.id], preview.transforms)
    const committed = store.activeObjects.value[page.id].transform
    assert.equal(formal, committed, 'store transform takes over after clear')
    assert.equal(committed.scaleX, 1)
    assert.equal(committed.rotation, 30)
    assert.ok(Math.abs(committed.width - previewBox.width) < 1e-6 && Math.abs(committed.height - previewBox.height) < 1e-6,
      'previewed visual box equals the committed box')
    assert.ok(Math.abs(committed.x - visual.x) < 1e-6)
    assert.equal(countUndoSteps(store), 3, 'one history entry for the transform (plus two adds)')
  }

  // 3. Group with a DOM descendant previews (keeping group scale); pure Konva objects are skipped.
  {
    const store = createTheaterStageStore()
    const image = store.addObject('image')
    const group = store.addObject('group')
    const page = store.addObject('iframe')
    assert.equal(store.setParent(page.id, group.id), true)
    const imageGroup = store.addObject('group')
    const nestedImage = store.addObject('image')
    assert.equal(store.setParent(nestedImage.id, imageGroup.id), true)
    ;[image, group, imageGroup, nestedImage].forEach(object => nodeFor(store.activeObjects.value[object.id]))
    const preview = makePreview(store)
    nodes.get(image.id).x(999)
    nodes.get(imageGroup.id).x(999)
    nodes.get(nestedImage.id).x(999)
    preview.schedule([image.id, imageGroup.id, nestedImage.id])
    assert.equal(frames.length, 0, 'pure Konva objects never request a DOM sync frame')
    assert.equal(Object.keys(preview.transforms).length, 0)
    nodes.get(group.id).setAttrs({ x: 120, scaleX: 2, scaleY: 3 })
    preview.schedule([group.id, image.id])
    assert.equal(runFrame(), 1)
    assert.deepEqual(Object.keys(preview.transforms), [group.id])
    assert.equal(preview.transforms[group.id].scaleX, 2)
    close(preview.transforms[group.id].x, 120 / WORLD_UNIT_PX, 'group x')
    preview.clear()
  }

  // 4. StageApp wires preview into every drag/transform path and clears it with the formal commit.
  {
    const script = app.scriptSetup.content
    const createObjectNode = declaration('createObjectNode')
    const handler = (source, event) => {
      const start = source.indexOf(`.on('${event}'`)
      assert.ok(start >= 0, `missing ${event} handler`)
      const next = source.indexOf(".on('", start + 1)
      return source.slice(start, next < 0 ? undefined : next)
    }
    assert.match(handler(createObjectNode, 'dragmove'), /domVisualPreview\.schedule\(\[object\.id\]\)/)
    assert.match(handler(createObjectNode, 'dragmove'), /domVisualPreview\.schedule\(multiDrag\.nodes\.keys\(\)\)/)
    for (const event of ['dragend', 'transformend']) {
      const body = handler(createObjectNode, event)
      const commits = body.split(/props\.store\.(?:commit|cancel)ObjectEdit\(\)/).length - 1
      const clears = body.split(/props\.store\.(?:commit|cancel)ObjectEdit\(\)\n\s*domVisualPreview\.clear\(\)/).length - 1
      assert.equal(clears, commits, `${event}: every commit/cancel clears the preview in the same task`)
    }
    assert.match(script, /transformer\.on\('transform', \(\) => \{\n\s*domVisualPreview\.schedule\(transformer!\.nodes\(\)/)
    assert.match(script, /else props\.store\.cancelObjectEdit\(\)\n\s*domVisualPreview\.clear\(\)/)
    assert.match(script, /domVisualPreview\.schedule\(selectionGroupDrag\.nodes\.keys\(\)\)/)
    assert.match(script, /watch\(\(\) => props\.store\.state\.activeSceneId,[\s\S]*?domVisualPreview\.clear\(\)/, 'scene changes clear transient DOM placement')
    assert.match(script, /watch\(\(\) => \[props\.syncReady, \.\.\.props\.permissions\],[\s\S]*?domVisualPreview\.clear\(\)/, 'sync or permission changes clear transient DOM placement')
    assert.match(script, /watch\(\(\) => \[props\.worldId, props\.channelId\],[\s\S]*?domVisualPreview\.clear\(\)/, 'world/channel changes clear transient DOM placement')
    assert.doesNotMatch(script, /domVisualPreview[^\n]*(beginObjectEdit|commitObjectEdit|props\.store\.state)/, 'preview never touches the store')
    assert.match(app.template.content, /<StageTextOverlay[\s\S]*?:visual-transforms="domVisualPreview\.transforms"/)
    const overlay = readSfc('StageTextOverlay.vue')
    assert.match(overlay.template.content, /<StageTextVisualObject[\s\S]*?:visual-transforms="props\.visualTransforms"/)
    const visualObject = readSfc('StageTextVisualObject.vue')
    assert.match(visualObject.scriptSetup.content, /resolveStageDomVisualTransform\(props\.object, props\.visualTransforms\)/)
    assert.match(visualObject.template.content, /<StageTextVisualObject[\s\S]*?:visual-transforms="props\.visualTransforms"/, 'nested DOM descendants receive the preview map')
  }

  // 5. Global "禁用交互" is a master switch for normal webpages and surface webpage testing.
  {
    const iframeInteractionDisabled = ref(false)
    const canEditAllObjects = ref(true)
    const surfaceInteractionTest = ref(null)
    const props = { store: { state: { liveState: { surfaceEmbeds: {
      background: { type: 'iframe', iframe: { url: 'https://example.com/bg', scale: 1 }, interactive: true },
      foreground: { type: 'iframe', iframe: { url: 'https://example.com/fg', scale: 1 }, interactive: true },
    } } } } }
    const surfaceIframeInteractive = new Function('iframeInteractionDisabled', 'canEditAllObjects', 'surfaceInteractionTest', 'props', transpile(`
      ${declaration('surfaceIframeInteractive')}
      return surfaceIframeInteractive
    `))(iframeInteractionDisabled, canEditAllObjects, surfaceInteractionTest, props)
    const both = () => ['background', 'foreground'].map(surfaceIframeInteractive)
    assert.deepEqual(both(), [false, false], 'editor: surfaces inert outside testing')
    for (const target of ['background', 'foreground']) {
      surfaceInteractionTest.value = target
      assert.deepEqual(both(), [target === 'background', target === 'foreground'], 'webpage testing unchanged')
      iframeInteractionDisabled.value = true
      assert.deepEqual(both(), [false, false], `global disable overrides ${target} testing`)
      iframeInteractionDisabled.value = false
      assert.deepEqual(both(), [target === 'background', target === 'foreground'], 'testing resumes when re-enabled')
    }
    surfaceInteractionTest.value = null
    canEditAllObjects.value = false
    assert.deepEqual(both(), [true, true], 'viewer follows embed.interactive')
    iframeInteractionDisabled.value = true
    assert.deepEqual(both(), [false, false], 'global disable overrides viewer surfaces')

    const surface = readSfc('StageSurfaceIframe.vue')
    assert.match(surface.template.content, /:interactive="interactive"[\s\S]*:block-focus="!interactive"/, 'non-interactive surfaces also block focus/inert')
    const styles = app.styles.map(style => style.content).join('\n')
    assert.match(styles, /\.is-iframe-interaction-disabled :deep\(\.theater-iframe-visual-object\)/, 'normal webpages stay disabled by the viewport rule')
    assert.match(styles, /\.is-iframe-interaction-disabled :deep\(\.theater-iframe-visual-object \*\) \{ pointer-events: none !important; \}/)
    assert.match(declaration('canInteractObject'), /!\(iframeInteractionDisabled\.value && object\.type === 'iframe'\)/, 'normal webpage actions stay gated')
  }

  console.log('theater stage DOM visual preview regression passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
