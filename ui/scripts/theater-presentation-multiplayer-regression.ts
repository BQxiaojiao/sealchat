import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { compileScript, parse } from '@vue/compiler-sfc'
import { createRenderer, h, nextTick, reactive } from 'vue'
import { createDefaultMediaFxSpec } from '../src/features/media-fx/media-fx'
import { createDefaultTheaterPresentation, createDefaultTheaterTransform } from '../src/types/theaterPresentation'
import {
  buildMultiplayerTheaterPresentationApply,
  createMultiplayerTheaterPresentationDraft,
  createTheaterPresentationEditorState,
  createTheaterVisualLayer,
  dispatchTheaterEditorCommand,
  undoTheaterEditor,
} from '../src/components/theater-presentation/theaterPresentationEditorState'
import { canUploadTheaterAppearancePurpose } from '../src/components/theater-presentation/theaterAppearanceAssetState'
import { resolveMultiplayerPortraitMediaFx } from '../src/components/theater-presentation/theaterPresentationMedia'

const media = { assetId: 'portrait', resourceAttachmentId: 'image', kind: 'static_image' as const, mimeType: 'image/png' as const, width: 400, height: 800 }
const fx = {
  ...createDefaultMediaFxSpec(),
  filter: { ...createDefaultMediaFxSpec().filter, brightness: 0.6 },
  advanced: { ...createDefaultMediaFxSpec().advanced, bloom: 0.7, edge: 0.3 },
  temporal: { ...createDefaultMediaFxSpec().temporal, glitch: 0.4, speed: 1.5 },
}
const presentation = { ...createDefaultTheaterPresentation(), portrait: { ...createTheaterVisualLayer(media, 'viewport', 'portrait'), mediaFx: fx, playbackRate: 1.75, blendMode: 'multiply' as const, fadeDurationMs: 300 } }
const fallback = { ...createDefaultTheaterTransform(), y: 0.1, height: 0.6 }
const draft = createMultiplayerTheaterPresentationDraft({ presentation, fallbackTransform: fallback })
assert.deepEqual(draft.portrait, presentation.portrait, 'multiplayer draft keeps all personal visual fields')
assert.deepEqual(draft.multiplayerPortraitTransform, fallback)
assert.equal(presentation.multiplayerPortraitTransform, undefined, 'draft does not mutate the source')
assert.deepEqual(createMultiplayerTheaterPresentationDraft({ presentation: { ...draft, multiplayerPortraitTransform: { ...fallback, y: 0.2 } }, fallbackTransform: fallback }).multiplayerPortraitTransform?.y, 0.2)

let state = createTheaterPresentationEditorState({ mode: 'base', presentation: draft })
state = dispatchTheaterEditorCommand(state, { type: 'set-multiplayer-transform', transform: { ...fallback, rotation: 15 } })
assert.deepEqual(state.draft.portrait?.transform, presentation.portrait.transform, 'multiplayer layout never overwrites the single-player transform')
const editedFx = { ...fx, advanced: { ...fx.advanced, glow: 0.5 }, temporal: { ...fx.temporal, grain: 0.3 } }
state = dispatchTheaterEditorCommand(state, { type: 'set-media-fx', target: { kind: 'portrait' }, mediaFx: editedFx })
const payload = buildMultiplayerTheaterPresentationApply(state.draft)
assert.deepEqual(payload.presentation.portrait?.mediaFx, editedFx, 'Basic / Advanced / Temporal survive Apply together')
assert.deepEqual(payload.multiplayerPortraitTransform, { ...fallback, rotation: 15 })
assert.deepEqual(payload.presentation.dialogue, presentation.dialogue, 'public dialogue context is never saved into the character')
assert.deepEqual(undoTheaterEditor(state).draft.portrait?.mediaFx, fx, 'FX and multiplayer layout share the editor history')
assert.deepEqual(undoTheaterEditor(undoTheaterEditor(state)).draft.multiplayerPortraitTransform, fallback)
const reopened = createMultiplayerTheaterPresentationDraft({ presentation: payload.presentation, fallbackTransform: fallback })
assert.deepEqual(reopened.portrait?.mediaFx, editedFx, 'saved FX survive reopen and single/multiplayer reuse')

assert.equal(canUploadTheaterAppearancePurpose('controller', 'portrait'), false)
for (const mode of ['base', 'variant', 'multiplayer'] as const) assert.equal(canUploadTheaterAppearancePurpose(mode, 'portrait'), true)
assert.equal(canUploadTheaterAppearancePurpose('controller', 'dialogue-frame'), true)
const legacyFx = { ...createDefaultMediaFxSpec(), filter: { ...createDefaultMediaFxSpec().filter, saturation: 0.2 } }
assert.deepEqual(resolveMultiplayerPortraitMediaFx(fx, legacyFx), fx)
assert.deepEqual(resolveMultiplayerPortraitMediaFx(undefined, legacyFx), legacyFx)
assert.deepEqual(resolveMultiplayerPortraitMediaFx(createDefaultMediaFxSpec(), legacyFx), legacyFx, 'empty personal FX uses the legacy fallback')
assert.equal(resolveMultiplayerPortraitMediaFx(undefined, undefined), null)
assert.equal(resolveMultiplayerPortraitMediaFx(createDefaultMediaFxSpec(), createDefaultMediaFxSpec()), null)

// Compile the actual SFC scripts and mount on Vue's existing no-DOM renderer.
// Heavy browser-only dependencies are stubbed; draft, dispatch and Apply are real.
const renderer = createRenderer({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
  parentNode: () => null, nextSibling: () => null,
})
const uiRoot = path.join(__dirname, '..')
const read = (file: string) => fs.readFileSync(path.join(uiRoot, file), 'utf8')
const residentsSource = read('src/views/theater/dialogue/TheaterDialogueResidents.vue')
assert.equal(residentsSource.includes('object-fit: contain !important'), false, 'multiplayer residents must not override the character portrait fit')
const previewSource = read('src/components/theater-presentation/TheaterPresentationPreview.vue')
assert.ok(previewSource.includes('aria-label="多人立绘预览占位"'), 'empty multiplayer portraits expose a visible stage placeholder')
assert.ok(previewSource.includes("'is-placeholder': !draft.portrait && Boolean(multiplayerPortraitTransform)"), 'empty multiplayer placeholder keeps the multiplayer layout bounds')
const uploads: unknown[] = []
const asset = { id: 'uploaded', purpose: 'portrait', status: 'ready', progress: 1, media: { ...media, assetId: 'uploaded', resourceAttachmentId: 'new-image' } }
const stubs: Record<string, unknown> = {
  '@/composables/useImageCompressor': { compressImage: async (file: unknown) => file },
  '@/composables/useTheaterAppearanceAssets': {
    uploadTheaterAppearanceAsset: async (input: unknown) => { uploads.push(input); return asset },
    waitForTheaterAppearanceAsset: async (_channel: string, initial: unknown, progress: (value: unknown) => void) => { progress(initial); return initial },
    getTheaterAssetErrorCode: () => 'UPLOAD_FAILED',
  },
  '@/features/media-fx/media-fx-gpu': { mediaFxGpuSupported: () => true, subscribeMediaFxGpuAvailability: () => () => undefined },
  '@/services/font/platformFontApi': { listPlatformFonts: async () => [] },
  '@/services/font/platformFontSelectPreview': { createPlatformFontSelectPreviewController: () => ({ platformFontOptions: [], renderPlatformFontLabel() {}, renderPlatformFontOption() {}, handleDropdownVisible() {}, primeSelectedPreview() {} }) },
}
const load = (file: string) => {
  const { descriptor } = parse(read(file))
  const compiled = compileScript(descriptor, { id: 'multiplayer-regression' })
  const module = { exports: {} as { default: any } }
  const localRequire = (id: string) => {
    if (id in stubs) return stubs[id]
    if (id.endsWith('.vue') || id.startsWith('@vicons/')) return {}
    if (id.startsWith('.')) return require(path.resolve(path.dirname(path.join(uiRoot, file)), id))
    return require(id)
  }
  new Function('require', 'module', 'exports', ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(localRequire, module, module.exports)
  module.exports.default.render = () => null
  return module.exports.default
}
const mount = (component: any, props: Record<string, unknown>) => {
  let instance: any
  const app = renderer.createApp({ render: () => h(component, { ...props, ref: (value: unknown) => { instance = value } }) })
  app.mount({})
  return { app, get editor() { return instance.$.setupState } }
}

const run = async () => {
  const originalWindow = globalThis.window
  const fakeWindow = { addEventListener() {}, removeEventListener() {} } as any
  fakeWindow.parent = fakeWindow
  globalThis.window = fakeWindow
  try {
    const emitted: any[] = []
    const template = {
      presentation: { ...createDefaultTheaterPresentation(), dialogue: { ...createDefaultTheaterPresentation().dialogue, nameGap: 0.2 } },
      portraitStyle: { enabled: true, transform: fallback, fit: 'cover', playbackRate: 0.5, blendMode: 'screen', fadeDurationMs: 90, mediaFx: legacyFx },
    }
    const props = reactive({ show: true, mode: 'multiplayer', presentation, controllerTemplate: template, channelId: 'channel', identityId: 'identity', applying: false, onApplyMultiplayer: (value: unknown) => emitted.push(value) })
    const modal = mount(load('src/components/theater-presentation/TheaterPresentationEditorModal.vue'), props)
    const editor = modal.editor
    assert.deepEqual(editor.editor.draft.value.portrait, presentation.portrait)
    assert.deepEqual(editor.previewDraft.portrait.mediaFx, fx)
    assert.equal(editor.previewDraft.dialogue.nameGap, 0.2)
    assert.deepEqual(editor.editor.draft.value.dialogue, presentation.dialogue)
    const inspector = mount(load('src/components/theater-presentation/TheaterPresentationInspector.vue'), {
      draft: editor.editor.draft.value, selection: { kind: 'portrait' }, mode: 'base', sectionModes: editor.editor.sectionModes.value,
      portraitStyle: null, portraitTransform: editor.multiplayerTransform,
      onDispatch: editor.dispatch, onTransactionStart: editor.beginEditTransaction, onTransactionEnd: editor.commitEditTransaction,
    })
    assert.equal(inspector.editor.mediaFxDisabled, false)
    inspector.editor.updateMediaFx(editedFx)
    inspector.editor.setTransform('height', 0.5)
    inspector.editor.endMediaFxEdit()
    editor.commitEditTransaction()
    assert.deepEqual(editor.editor.draft.value.portrait.transform, presentation.portrait.transform)
    let clicked = 0
    editor.fileInput = { click: () => { clicked++ } }
    editor.triggerUpload('portrait')
    assert.equal(clicked, 1, 'multiplayer portrait upload reaches the existing input')
    await editor.handleFile({ target: { value: 'file', files: [{ type: 'image/png', name: 'portrait.png', size: 0 }] } })
    assert.equal(uploads.length, 1)
    assert.equal(editor.editor.draft.value.portrait.media.assetId, 'uploaded')
    inspector.editor.updateMediaFx(editedFx)
    editor.apply()
    assert.equal(emitted.length, 1, 'Apply emits one combined save event')
    assert.deepEqual(emitted[0].presentation.portrait.mediaFx, editedFx)
    assert.equal(emitted[0].presentation.portrait.media.assetId, 'uploaded')
    assert.equal(emitted[0].multiplayerPortraitTransform.height, 0.5)
    assert.deepEqual(template.portraitStyle.mediaFx, legacyFx, 'personal edits never update the controller style')
    props.applying = true
    await nextTick()
    editor.apply()
    assert.equal(emitted.length, 1, 'loading blocks duplicate Apply')
    props.applying = false
    props.mode = 'base'
    await nextTick()
    assert.deepEqual(editor.editor.draft.value.portrait.mediaFx, editedFx, 'switch to single-player keeps the visual draft')
    props.mode = 'multiplayer'
    await nextTick()
    assert.deepEqual(editor.editor.draft.value.portrait.mediaFx, editedFx)
    props.show = false
    await nextTick()
    props.presentation = emitted[0].presentation
    props.show = true
    await nextTick()
    assert.deepEqual(editor.editor.draft.value.portrait.mediaFx, editedFx, 'reopen uses the saved character FX')
    inspector.app.unmount()
    modal.app.unmount()
  } finally { globalThis.window = originalWindow }
}

const runExternalPreviewTests = async () => {
  const originalWindow = globalThis.window
  const posted: any[] = []
  const parent = {
    postMessage(value: unknown) {
      // Browser postMessage performs structured clone. This intentionally reproduces the
      // DataCloneError that Vue Proxy arrays used to trigger in multiplayer preview data.
      posted.push(structuredClone(value))
    },
  }
  const fakeWindow = {
    parent,
    location: { hash: '#?mode=theater', origin: 'https://sealchat.test' },
    addEventListener() {},
    removeEventListener() {},
  } as any
  globalThis.window = fakeWindow
  try {
    const template = reactive({
      presentation: { ...createDefaultTheaterPresentation(), portraitDecorations: [] },
      portraitStyle: { enabled: true, transform: fallback, fit: 'cover', playbackRate: 1, blendMode: 'normal', fadeDurationMs: 90, mediaFx: legacyFx },
    })
    const props = reactive({ show: false, mode: 'multiplayer', presentation, controllerTemplate: template, channelId: 'channel', identityId: 'identity', applying: false })
    const modal = mount(load('src/components/theater-presentation/TheaterPresentationEditorModal.vue'), props)
    props.show = true
    await nextTick()
    await nextTick()
    assert.equal(posted.at(-1)?.type, 'sealchat.theater.appearance-preview.start')
    assert.deepEqual(posted.at(-1)?.draft.portrait.mediaFx, fx, 'external multiplayer preview starts with personal FX')
    modal.editor.dispatch({ type: 'set-media-fx', target: { kind: 'portrait' }, mediaFx: editedFx })
    await nextTick()
    assert.equal(posted.at(-1)?.type, 'sealchat.theater.appearance-preview.update')
    assert.deepEqual(posted.at(-1)?.draft.portrait.mediaFx, editedFx, 'advanced/temporal edits cross the iframe bridge immediately')
    modal.app.unmount()

    posted.length = 0
    const emptyProps = reactive({ show: false, mode: 'multiplayer', presentation: createDefaultTheaterPresentation(), controllerTemplate: template, channelId: 'channel', identityId: 'identity', applying: false })
    const emptyModal = mount(load('src/components/theater-presentation/TheaterPresentationEditorModal.vue'), emptyProps)
    emptyProps.show = true
    await nextTick()
    await nextTick()
    assert.equal(posted.at(-1)?.draft.portrait, null)
    assert.deepEqual(posted.at(-1)?.multiplayerPortraitTransform, fallback, 'empty portraits still publish multiplayer preview bounds')
    emptyModal.app.unmount()
  } finally {
    globalThis.window = originalWindow
  }
}

// Exercise the real parent handlers with controlled save results, without mounting chat.
const runSaveTests = async () => {
  const source = read('src/views/chat/chat.vue')
  const handlers = source.slice(source.indexOf('const handleTheaterPresentationApply ='), source.indexOf('const handleSetWorldTheaterTemplate ='))
  const context = {
    theaterPresentationApplying: { value: false }, theaterPresentationEditorMode: { value: 'multiplayer' }, theaterPresentationEditorVisible: { value: true },
    identityForm: reactive({ theaterPresentation: presentation }), editingIdentity: { value: { id: 'identity' } },
    chat: { curChannel: { id: 'channel' }, sharedChannelIdentityTheaterPresentationSet: async (_id: string, _input: any): Promise<any> => null, upsertChannelIdentity(_identity: unknown) {} },
    isManagingBotIdentity: { value: false }, currentIdentityTargetUserId: { value: '' }, message: { error(_text: string) {} },
    cloneChannelIdentityTheaterPresentation: (value: unknown) => value ? JSON.parse(JSON.stringify(value)) : null,
    submitIdentityForm: async () => false,
  }
  const code = ts.transpileModule(handlers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  // submitIdentityForm is captured by the factory; use a mutable result/gate.
  let finish!: (value: boolean) => void
  const saveContext = { ...context, submitIdentityForm: () => new Promise<boolean>(resolve => { finish = resolve }) }
  const save = new Function(...Object.keys(saveContext), `${code}; return handleMultiplayerPortraitApply`)(...Object.values(saveContext))
  const pending = save(payload)
  assert.equal(context.theaterPresentationApplying.value, true)
  assert.equal(context.theaterPresentationEditorVisible.value, true, 'Modal remains open until save confirms')
  await save(payload)
  finish(false)
  await pending
  assert.equal(context.theaterPresentationApplying.value, false)
  assert.equal(context.theaterPresentationEditorVisible.value, true)
  assert.deepEqual(context.identityForm.theaterPresentation, presentation, 'failed save restores confirmed form data')
  const success = save(payload)
  finish(true)
  await success
  assert.equal(context.theaterPresentationEditorVisible.value, false)
  assert.deepEqual(context.identityForm.theaterPresentation, payload.presentation)
  const canonical = { ...payload.presentation, portrait: { ...payload.presentation.portrait!, fadeDurationMs: 350 } }
  Object.assign(context.editingIdentity.value, { sharedIdentityId: 'shared', sharedRevision: 4 })
  context.theaterPresentationEditorVisible.value = true
  context.chat.sharedChannelIdentityTheaterPresentationSet = async (_id, input) => {
    assert.equal(input.expectedRevision, 4)
    assert.deepEqual(input.theaterPresentation, payload.presentation, 'shared save sends visuals and layout in one existing request')
    return { ...context.editingIdentity.value, sharedRevision: 5, theaterPresentation: canonical }
  }
  await save(payload)
  assert.deepEqual(context.identityForm.theaterPresentation, canonical, 'server canonical presentation wins over the local draft')
  assert.equal(context.theaterPresentationEditorVisible.value, false)
  context.theaterPresentationEditorVisible.value = true
  context.chat.sharedChannelIdentityTheaterPresentationSet = async () => { throw new Error('shared save failed') }
  await save(payload)
  assert.equal(context.theaterPresentationEditorVisible.value, true)
  assert.equal(context.theaterPresentationApplying.value, false)
  assert.deepEqual(context.identityForm.theaterPresentation, canonical, 'failed shared save preserves the confirmed presentation')
}

run().then(runExternalPreviewTests).then(runSaveTests).then(() => console.log('theater presentation multiplayer tests passed'), error => { console.error(error); process.exitCode = 1 })
