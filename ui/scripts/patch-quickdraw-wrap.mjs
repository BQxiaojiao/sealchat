import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const marker = '// SealChat Quickdraw inline-style patch v2'
const editorMarker = '// SealChat Quickdraw raw editor layout v2'
const legacyMarker = '// SealChat patch: split overlong unbroken tokens so sticky notes'
const scriptDir = dirname(fileURLToPath(import.meta.url))
const shapesPath = resolve(scriptDir, '../node_modules/@quickdrawjs/core/src/shapes.js')
const editorPath = resolve(scriptDir, '../node_modules/@quickdrawjs/core/src/editor.js')

const original = [
  'function wrapLines(text, font, fontSize, maxW) {',
  '  const ctx = measurer()',
  '  ctx.font = `500 ${fontSize}px ${font}`',
  '  const out = []',
  "  for (const para of String(text ?? '').split('\\n')) {",
  "    if (para === '') { out.push({ text: '', w: 0 }); continue }",
  "    let line = ''",
  '    for (const word of para.split(/(\\s+)/)) {',
  '      const test = line + word',
  '      if (line && maxW && ctx.measureText(test).width > maxW) {',
  '        out.push({ text: line, w: ctx.measureText(line).width })',
  '        line = word.trimStart()',
  '      } else line = test',
  '    }',
  '    out.push({ text: line, w: ctx.measureText(line).width })',
  '  }',
  '  return out',
  '}',
].join('\n')

const styledHelpers = String.raw`
// SealChat Quickdraw inline-style patch v2
const INLINE_DELIMITERS = [
  { value: '***', bold: true, italic: true },
  { value: '**', bold: true, italic: false },
  { value: '~~', bold: false, italic: false, strike: true },
  { value: '*', bold: false, italic: true },
]
const PLAIN_STYLE = { bold: false, italic: false, strike: false }
const hasDelimiter = (value) => /\*\*\*|\*\*|~~|\*/.test(value)
function closingDelimiter(source, start, delimiter) {
  let at = source.indexOf(delimiter, start)
  while (at >= 0) {
    if (delimiter === '*' && (source[at - 1] === '*' || source[at + 1] === '*')) { at = source.indexOf(delimiter, at + delimiter.length); continue }
    if (delimiter === '**' && (source[at - 1] === '*' || source[at + 2] === '*')) { at = source.indexOf(delimiter, at + delimiter.length); continue }
    if (delimiter === '***' && (source[at - 1] === '*' || source[at + 3] === '*')) { at = source.indexOf(delimiter, at + delimiter.length); continue }
    return at
  }
  return -1
}
const sameStyle = (a, b) => a.bold === b.bold && a.italic === b.italic && a.strike === b.strike
function appendStyledRun(runs, text, style) {
  if (!text) return
  const previous = runs[runs.length - 1]
  if (previous && sameStyle(previous, style)) previous.text += text
  else runs.push({ text, bold: !!style.bold, italic: !!style.italic, strike: !!style.strike })
}
export function parseInlineStyle(text) {
  const source = String(text ?? '')
  const runs = []
  let plain = ''
  const flush = () => { if (plain) { appendStyledRun(runs, plain, PLAIN_STYLE); plain = '' } }
  for (let i = 0; i < source.length;) {
    let parsed = false
    for (const delimiter of INLINE_DELIMITERS) {
      if (!source.startsWith(delimiter.value, i)) continue
      const close = closingDelimiter(source, i + delimiter.value.length, delimiter.value)
      if (close > i + delimiter.value.length) {
        const inner = source.slice(i + delimiter.value.length, close)
        if (!hasDelimiter(inner)) { flush(); appendStyledRun(runs, inner, delimiter); i = close + delimiter.value.length; parsed = true }
        else { plain += source.slice(i, close + delimiter.value.length); i = close + delimiter.value.length; parsed = true }
      }
      break
    }
    if (parsed) continue
    const next = source.startsWith('***', i) ? 3 : source.startsWith('**', i) || source.startsWith('~~', i) ? 2 : 1
    plain += source.slice(i, i + next)
    i += next
  }
  flush()
  return runs
}
const fontForRun = (font, size, run) => (run.italic ? 'italic ' : '') + (run.bold ? 700 : 500) + ' ' + size + 'px ' + font
function wrapStyledLines(text, font, fontSize, maxW) {
  const ctx = measurer()
  const sourceRuns = parseInlineStyle(text)
  if (sourceRuns.every((run) => !run.bold && !run.italic && !run.strike)) return wrapLines(text, font, fontSize, maxW).map((line) => ({ runs: line.text ? [{ text: line.text, ...PLAIN_STYLE, width: line.w }] : [], text: line.text, w: line.w, width: line.w }))
  const paragraphs = [[]]
  for (const run of sourceRuns) {
    const parts = run.text.split('\n')
    for (let i = 0; i < parts.length; i++) { if (parts[i]) paragraphs[paragraphs.length - 1].push({ ...run, text: parts[i] }); if (i < parts.length - 1) paragraphs.push([]) }
  }
  const widthOf = (value, style) => { ctx.font = fontForRun(font, fontSize, style); return ctx.measureText(value).width }
  const lineOf = (runs) => { const w = runs.reduce((sum, run) => sum + run.width, 0); return { runs, text: runs.map((run) => run.text).join(''), w, width: w } }
  const out = []
  for (const para of paragraphs) {
    if (!para.length) { out.push(lineOf([])); continue }
    const line = []; let lineW = 0
    const push = () => { const done = line.splice(0); for (const run of done) run.width = widthOf(run.text, run); out.push(lineOf(done)); lineW = 0 }
    const append = (value, style) => { const width = widthOf(value, style); const prev = line[line.length - 1]; if (prev && sameStyle(prev, style)) { prev.text += value; prev.width += width } else line.push({ text: value, bold: !!style.bold, italic: !!style.italic, strike: !!style.strike, width }); lineW += width }
    for (const segment of para) for (const word of segment.text.split(/(\s+)/)) {
      if (!word) continue
      let token = word; let tokenW = widthOf(token, segment)
      if (!maxW || lineW + tokenW <= maxW) { append(token, segment); continue }
      if (line.length) push()
      token = token.trimStart(); if (!token) continue
      tokenW = widthOf(token, segment)
      if (!maxW || tokenW <= maxW) { append(token, segment); continue }
      for (const char of Array.from(token)) { const charW = widthOf(char, segment); if (line.length && lineW + charW > maxW) push(); append(char, segment) }
    }
    push()
  }
  return out
}

// Internal editor-only layout: measure the raw textarea value with the
// existing plain wrapping rules, without parsing Markdown delimiters.
export function rawTextLayout(text, font, fontSize, maxW, lineHeight = fontSize * 1.32) {
  const lines = wrapLines(text, font, fontSize, maxW)
  const textH = lines.length * lineHeight
  const w = maxW || Math.max(8, ...lines.map((line) => line.w)) + 2
  return { lines, w, h: Math.max(lineHeight, textH), textH }
}
`

const styledRender = String.raw`
function drawStyledLine(ctx, line, x, baseline, fontSize, font, color) {
  for (const run of line.runs) {
    ctx.font = fontForRun(font, fontSize, run)
    ctx.fillStyle = color
    ctx.fillText(run.text, x, baseline)
    if (run.strike && run.width > 0) {
      ctx.strokeStyle = color
      ctx.lineWidth = Math.max(1, fontSize * 0.06)
      ctx.lineCap = 'butt'
      const y = baseline - fontSize * 0.325
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + run.width, y); ctx.stroke()
    }
    x += run.width
  }
}
`

const replacement = [
  'function wrapLines(text, font, fontSize, maxW) {',
  '  const ctx = measurer()',
  '  ctx.font = `500 ${fontSize}px ${font}`',
  '  const out = []',
  '  const width = (value) => ctx.measureText(value).width',
  '  const pushLine = (value) => out.push({ text: value, w: width(value) })',
  '',
  "  for (const para of String(text ?? '').split('\\n')) {",
  "    if (para === '') {",
  "      out.push({ text: '', w: 0 })",
  '      continue',
  '    }',
  '',
  "    let line = ''",
  '',
  '    for (const word of para.split(/(\\s+)/)) {',
  '      if (!word) continue',
  '',
  '      const test = line + word',
  '      if (!maxW || width(test) <= maxW) {',
  '        line = test',
  '        continue',
  '      }',
  '',
  '      if (line) {',
  '        pushLine(line)',
  "        line = ''",
  '      }',
  '',
  '      const token = word.trimStart()',
  '      if (!token) continue',
  '',
  '      if (width(token) <= maxW) {',
  '        line = token',
  '        continue',
  '      }',
  '',
  '      // SealChat patch: split overlong unbroken tokens so sticky notes',
  '      // wrap CJK text, URLs, UUIDs and continuous numbers inside NOTE_W.',
  '      for (const char of Array.from(token)) {',
  '        const next = line + char',
  '        if (line && width(next) > maxW) {',
  '          pushLine(line)',
  '          line = char',
  '        } else {',
  '          line = next',
  '        }',
  '      }',
  '    }',
  '',
  '    pushLine(line)',
  '  }',
  '',
  '  return out',
  '}',
].join('\n')

const [source, editorSource] = await Promise.all([
  readFile(shapesPath, 'utf8'),
  readFile(editorPath, 'utf8'),
])

let patched = source
const drawHelperCount = (source.match(/function drawStyledLine/g) || []).length
const wrapHelperCount = (source.match(/function wrapLines\(/g) || []).length
const markerCount = (source.match(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
const shapeReady = markerCount === 1 && wrapHelperCount === 1 && drawHelperCount === 1
if (!shapeReady) {
  if (!source.includes(original) && !source.includes(legacyMarker) && !source.includes('export function parseInlineStyle')) {
    throw new Error('SealChat Quickdraw 0.2.0 source was not found')
  }
  patched = patched.replaceAll(`${marker}\n`, '')

  // A fresh package has the original wrapLines() body. Older SealChat builds
  // may already contain the wrapping patch and the first Markdown patch, so
  // remove the known old bodies before installing one canonical helper block.
  patched = patched.replaceAll(original, '').replaceAll(replacement, '')
  const anchor = '\n\nexport function textLayout'
  if (!patched.includes(anchor)) throw new Error('SealChat Quickdraw textLayout anchor was not found')
  const helperStart = patched.indexOf('const INLINE_DELIMITERS = [')
  if (helperStart >= 0) {
    const helperEnd = patched.indexOf(anchor, helperStart)
    if (helperEnd < 0) throw new Error('SealChat Quickdraw inline-style helper anchor was not found')
    patched = patched.slice(0, helperStart) + replacement.trim() + '\n\n' + styledHelpers.trim() + patched.slice(helperEnd)
  } else {
    patched = patched.replace(anchor, `\n\n${replacement.trim()}\n\n${styledHelpers.trim()}${anchor}`)
  }
  const drawAnchor = '\n// the freehand outline as a Path2D, cached; live strokes (done !== true)'
  if (!patched.includes(drawAnchor)) throw new Error('SealChat Quickdraw draw helper anchor was not found')
  patched = patched
    .replace('const lines = wrapLines(p.text, font, fontSize, maxW)', 'const lines = wrapStyledLines(p.text, font, fontSize, maxW)')
    .replace('const lines = wrapLines(p.text, font, fontSize, NOTE_W - NOTE_PAD * 2)', 'const lines = wrapStyledLines(p.text, font, fontSize, NOTE_W - NOTE_PAD * 2)')
    .replace("      ctx.font = `500 ${l.fontSize}px ${l.font}`\n", '')
    .replace("      ctx.textAlign = align === 'middle' ? 'center' : align === 'end' ? 'right' : 'left'\n      const ax = align === 'middle' ? l.w / 2 : align === 'end' ? l.w : 0", "      ctx.textAlign = 'left'")
    .replace('          ctx.fillText(line.text, ax, y)', '          const x = align === \'middle\' ? (l.w - line.w) / 2 : align === \'end\' ? l.w - line.w : 0\n          drawStyledLine(ctx, line, x, y, l.fontSize, l.font, col.stroke)')
    .replace('      ctx.textAlign = \'center\'\n      ctx.textBaseline = \'alphabetic\'', "      ctx.textAlign = 'left'\n      ctx.textBaseline = 'alphabetic'")
    .replace('          ctx.fillText(line.text, NOTE_W / 2, y)', '          drawStyledLine(ctx, line, (NOTE_W - line.w) / 2, y, l.fontSize, l.font, theme.noteText)')
  if (!patched.includes('function drawStyledLine')) patched = patched.replace(drawAnchor, `\n${styledRender}${drawAnchor}`)
  if (!patched.includes(marker)) throw new Error('SealChat Quickdraw inline-style marker was not written')
  await writeFile(shapesPath, patched, 'utf8')
}

let patchedEditor = editorSource
if (!editorSource.includes(editorMarker)) {
  const importNeedle = '  scaleShape, textLayout, noteLayout, NOTE_W, sampleLinePts,'
  if (!patchedEditor.includes(importNeedle)) throw new Error('SealChat Quickdraw editor import anchor was not found')
  patchedEditor = patchedEditor.replace(importNeedle, '  scaleShape, textLayout, noteLayout, rawTextLayout, NOTE_W, sampleLinePts,')

  const methodNeedle = '  _layoutTextEditor() {\n'
  if (!patchedEditor.includes(methodNeedle)) throw new Error('SealChat Quickdraw editor layout anchor was not found')
  patchedEditor = patchedEditor.replace(methodNeedle, `${methodNeedle}    ${editorMarker}\n`)

  const noteNeedle = `      lay = noteLayout(shape)\n      const s = shape.props.scale || 1\n      // anchor the textarea where the canvas draws the (vertically centered)\n      // text block, so committing doesn't jump the text — 20 = NOTE_PAD\n      const yStart = Math.max(20, lay.boxH / 2 - lay.textH / 2)`
  if (!patchedEditor.includes(noteNeedle)) throw new Error('SealChat Quickdraw note editor layout anchor was not found')
  patchedEditor = patchedEditor.replace(noteNeedle, `      lay = noteLayout(shape)\n      const raw = rawTextLayout(ta.value, lay.font, lay.fontSize, NOTE_W - 40, lay.lh)\n      const s = shape.props.scale || 1\n      // Keep the textarea sized and positioned from its raw Markdown value.\n      const yStart = Math.max(20, lay.boxH / 2 - raw.textH / 2)`)
    .replace('      h = lay.textH * s\n', '      h = raw.textH * s\n')

  const textNeedle = `      lay = textLayout(shape)\n      pos = this.pageToScreen(shape.x, shape.y)\n      w = Math.max(lay.w + 4, 40)\n      h = lay.h + 4\n      const p = shape.props\n      align = p.align === 'middle' ? 'center' : p.align === 'end' ? 'right' : 'left'`
  if (!patchedEditor.includes(textNeedle)) throw new Error('SealChat Quickdraw text editor layout anchor was not found')
  patchedEditor = patchedEditor.replace(textNeedle, `      lay = textLayout(shape)\n      const p = shape.props\n      const rawMaxW = p.autosize === false && p.w ? p.w : 0\n      const raw = rawTextLayout(ta.value, lay.font, lay.fontSize, rawMaxW, lay.lh)\n      pos = this.pageToScreen(shape.x, shape.y)\n      w = Math.max(raw.w + 4, 40)\n      h = raw.h + 4\n      align = p.align === 'middle' ? 'center' : p.align === 'end' ? 'right' : 'left'`)

  if (!patchedEditor.includes(editorMarker)) throw new Error('SealChat Quickdraw raw editor marker was not written')
  await writeFile(editorPath, patchedEditor, 'utf8')
}

if (shapeReady && editorSource.includes(editorMarker)) {
  console.log('SealChat Quickdraw inline-style patch v2 is already applied')
} else {
  console.log('Applied SealChat Quickdraw inline-style patch v2')
}
