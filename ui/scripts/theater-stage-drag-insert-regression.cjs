// Existing local TypeScript/Node harness; no additional test dependencies.
// node scripts/theater-stage-drag-insert-regression.cjs
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const originalLoad = Module._load
const originalResolve = Module._resolveFilename
Module._load = function (request, ...args) {
  if (request === '@/stores/_config') return { api: {} }
  if (request === '@/stores/chat') return { chatEvent: { on() {}, off() {} } }
  return originalLoad.call(this, request, ...args)
}
Module._resolveFilename = function (request, parent, ...args) {
  if (request.startsWith('@/')) request = path.join(__dirname, '../src', request.slice(2))
  return originalResolve.call(this, request, parent, ...args)
}
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename)
global.crypto ||= require('node:crypto').webcrypto

require('./theater-stage-drag-insert-checks.ts')
