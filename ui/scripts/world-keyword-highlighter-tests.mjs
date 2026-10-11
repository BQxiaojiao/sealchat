import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const readSource = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function loadUtility(name) {
  const exports = {};
  vm.runInNewContext(compile(readSource(`../src/utils/${name}.ts`)), { exports });
  return exports;
}

// Use the store's actual compiler without initializing its API/reactive dependencies.
function readFunction(path, name) {
  const source = ts.createSourceFile(path, readSource(path), ts.ScriptTarget.Latest, true);
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(source);
    else ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(found, `Missing function ${name}`);
  return found;
}

const compilerContext = {
  exports: {},
  effectivePages: { value: {} },
  effectiveCompiledMap: { value: {} },
  DEFAULT_CATEGORY_PRIORITY: 0,
  console,
};
vm.runInNewContext(compile([
  readFunction('../src/utils/tools.ts', 'escapeRegExp'),
  readFunction('../src/stores/worldGlossary.ts', 'rebuildEffectiveCompiled'),
  'exports.rebuildEffectiveCompiled = rebuildEffectiveCompiled;',
].join('\n')), compilerContext);

function compileItems(items) {
  compilerContext.effectivePages.value.world = { items };
  compilerContext.exports.rebuildEffectiveCompiled('world');
  return compilerContext.effectiveCompiledMap.value.world;
}

const dependencies = {
  './keywordTooltipHoverBoundary': loadUtility('keywordTooltipHoverBoundary'),
  './worldKeywordTooltipCandidates': loadUtility('worldKeywordTooltipCandidates'),
};
const highlighter = {};
// Only the DOM operations used by wrapRanges are needed for these output checks.
const document = {
  createDocumentFragment: () => ({ children: [], appendChild(child) { this.children.push(child); } }),
  createTextNode: textContent => ({ textContent }),
  createElement: tagName => ({ tagName, dataset: {}, classList: { add() {} } }),
};
vm.runInNewContext(compile(`${readSource('../src/utils/worldKeywordHighlighter.ts')}
  exports.buildRanges = buildRanges;
  exports.wrapRanges = wrapRanges;
`), {
  exports: highlighter,
  require(name) {
    assert.ok(dependencies[name], `Unexpected dependency ${name}`);
    return dependencies[name];
  },
  document,
});

const item = (keyword, overrides = {}) => ({
  id: keyword, keyword, aliases: [], isEnabled: true, matchMode: 'plain',
  sourceType: 'world', categoryPriority: 0, sourceSortOrder: 0, sortOrder: 0,
  updatedAt: '', description: '', ...overrides,
});
const spells = [item('隐形术', { categoryPriority: 100 }), item('群体隐形术')];

function highlight(text, items) {
  const ranges = highlighter.buildRanges(text, compileItems(items));
  const node = { textContent: text, replaceWith(fragment) { this.fragment = fragment; } };
  highlighter.wrapRanges(node, ranges, { underlineOnly: false }, new Set());
  const children = node.fragment?.children || [node];
  assert.equal(children.map(child => child.textContent).join(''), text);
  const spans = children.filter(child => child.tagName === 'span');
  assert.equal(spans.length, ranges.length);
  return {
    ranges: Array.from(ranges, range => [range.start, range.end]),
    spans: spans.map(span => ({
      text: span.textContent,
      keywordId: span.dataset.keywordId,
      candidates: JSON.parse(span.dataset.keywordCandidates),
    })),
  };
}

const cases = [
  ['隐形术', spells, [[0, 3]], ['隐形术']],
  ['群体隐形术', spells, [[0, 5]], ['群体隐形术']],
  ['施放群体隐形术', spells, [[2, 7]], ['群体隐形术']],
  ['隐形术和群体隐形术', spells, [[0, 3], [4, 9]], ['隐形术', '群体隐形术']],
  ['高级隐形术', [item('隐形术')], [[2, 5]], ['隐形术']],
  ['高级隐形术', [...spells, item('高级隐形术')], [[0, 5]], ['高级隐形术']],
];
for (const [text, items, expectedRanges, expectedKeywords] of cases) {
  test(`${text} with ${items.map(entry => entry.keyword).join(', ')}`, () => {
    for (const entries of [items, [...items].reverse()]) {
      const result = highlight(text, entries);
      assert.deepEqual(result.ranges, expectedRanges);
      assert.deepEqual(result.spans.map(span => span.text), expectedKeywords);
      assert.deepEqual(result.spans.map(span => span.keywordId), expectedKeywords);
      assert.ok(result.spans.every(span => span.candidates.length === 1));
    }
  });
}

test('same start selects the longest range despite business priority', () => {
  const result = highlight('高级隐形术', [
    item('高级', { categoryPriority: 100 }), item('高级隐形术'),
  ]);
  assert.deepEqual(result.ranges, [[0, 5]]);
  assert.equal(result.spans[0].keywordId, '高级隐形术');
});

test('earliest range wins partial overlap, then matching continues at its end', () => {
  const result = highlight('甲乙丙丁戊己', [
    item('乙丙丁戊', { categoryPriority: 100 }), item('甲乙'), item('丙丁'), item('戊己'),
  ]);
  assert.deepEqual(result.ranges, [[0, 2], [2, 4], [4, 6]]);
  assert.deepEqual(result.spans.map(span => span.keywordId), ['甲乙', '丙丁', '戊己']);
});

const priorityCases = [
  ['categoryPriority', { categoryPriority: 1, sourceType: 'external_library' }, { sourceType: 'world' }],
  ['sourceType', { sourceType: 'world' }, { sourceType: 'external_library', sourceSortOrder: 100 }],
  ['sourceSortOrder', { sourceSortOrder: 1 }, { sortOrder: 100 }],
  ['sortOrder', { sortOrder: 1 }, { updatedAt: '2026-01-01' }],
  ['updatedAt', { updatedAt: '2026-01-02' }, { updatedAt: '2026-01-01' }],
  ['id', { id: 'a' }, { id: 'z' }],
];
for (const [field, preferred, other] of priorityCases) {
  test(`exact keyword/alias matches share one span and retain ${field} priority`, () => {
    const primary = item('另一术语', { id: 'preferred', aliases: ['隐形术'], ...preferred });
    const secondary = item('隐形术', { id: 'other', ...other });
    for (const entries of [[secondary, primary], [primary, secondary]]) {
      const result = highlight('隐形术', entries);
      assert.deepEqual(result.ranges, [[0, 3]]);
      assert.equal(result.spans[0].keywordId, primary.id);
      assert.deepEqual(result.spans[0].candidates, [
        { keywordId: primary.id, matchedVia: '隐形术' },
        { keywordId: secondary.id, matchedVia: '隐形术' },
      ]);
    }
  });
}

test('plain 群体隐形术 does not match standalone 隐形术', () => {
  const compiled = compileItems([item('群体隐形术')]);
  assert.equal(compiled[0].regex.test('隐形术'), false);
  assert.deepEqual(highlight('隐形术', [item('群体隐形术')]).spans, []);
});

test('explicit alias and regex conflicts retain both candidates', () => {
  for (const conflict of [
    item('群体隐形术', { aliases: ['隐形术'] }),
    item('(?:群体)?隐形术', { id: '群体隐形术', matchMode: 'regex' }),
  ]) {
    const result = highlight('隐形术', [item('隐形术'), conflict]);
    assert.deepEqual(result.ranges, [[0, 3]]);
    assert.equal(result.spans[0].candidates.length, 2);
    assert.deepEqual(new Set(result.spans[0].candidates.map(candidate => candidate.keywordId)),
      new Set(['隐形术', '群体隐形术']));
  }
});

test('same keyword hit via both keyword and alias remains one candidate', () => {
  const result = highlight('隐形术', [item('隐形术', { aliases: ['隐形术'] })]);
  assert.equal(result.spans[0].candidates.length, 1);
});
