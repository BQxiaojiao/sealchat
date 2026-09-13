import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const marker = '// SealChat patch: split overlong unbroken tokens so sticky notes'
const scriptDir = dirname(fileURLToPath(import.meta.url))
const shapesPath = resolve(scriptDir, '../node_modules/@quickdrawjs/core/src/shapes.js')

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

const source = await readFile(shapesPath, 'utf8')
if (source.includes(marker)) {
  console.log('SealChat Quickdraw wrapping patch is already applied')
} else {
  if (!source.includes(original)) {
    throw new Error(
      'SealChat Quickdraw wrapping patch failed: expected @quickdrawjs/core 0.2.0 wrapLines() source was not found',
    )
  }
  await writeFile(shapesPath, source.replace(original, replacement), 'utf8')
  console.log('Applied SealChat Quickdraw wrapping patch')
}
