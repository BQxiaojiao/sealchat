import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadUtility(name, globals = {}) {
  const source = readFileSync(new URL(`../src/utils/${name}.ts`, import.meta.url), 'utf8');
  const exports = {};
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(compiled, {
    exports,
    URL,
    URLSearchParams,
    require: path => loadUtility(path.replace(/^\.\//, ''), globals),
    ...globals,
  });
  return exports;
}

const { primaryDomain, resolvePublicLinkBase } = loadUtility('publicLinkBase');

test('primary domain matches the first non-empty trimmed backend entry', () => {
  for (const [domain, expected] of [
    ['https://a.example;https://b.example', 'https://a.example'],
    ['a.example;b.example', 'a.example'],
    ['  https://a.example  ; https://b.example  ', 'https://a.example'],
    ['https://a.example;;https://b.example', 'https://a.example'],
    [' ; ; https://a.example;https://b.example', 'https://a.example'],
    ['https://a.example', 'https://a.example'],
    ['', undefined],
    [' ; ; ', undefined],
    [null, undefined],
    [undefined, undefined],
  ]) {
    assert.equal(primaryDomain(domain), expected);
    assert.equal(resolvePublicLinkBase({ domain }), expected
      ? (expected.startsWith('https://') ? expected : `https://${expected}`)
      : undefined);
  }
  assert.equal(resolvePublicLinkBase(), undefined);
  assert.equal(resolvePublicLinkBase(null), undefined);
  assert.equal(resolvePublicLinkBase({ domain: '', webUrl: '/sealchat' }), undefined);
});

test('public base joins deployment paths without duplicate boundary slashes', () => {
  for (const domain of ['https://a.example;https://b.example', 'https://a.example/;https://b.example']) {
    for (const [webUrl, expected] of [
      [undefined, 'https://a.example'],
      ['', 'https://a.example'],
      ['/', 'https://a.example'],
      ['/sealchat', 'https://a.example/sealchat'],
      ['sealchat', 'https://a.example/sealchat'],
      [' /sealchat/ ', 'https://a.example/sealchat'],
      ['//sealchat//', 'https://a.example/sealchat'],
    ]) {
      assert.equal(resolvePublicLinkBase({ domain, webUrl }), expected);
    }
  }
});

test('bare domains use the browser protocol and explicit HTTP(S) is preserved', () => {
  for (const protocol of ['http:', 'https:']) {
    const browser = loadUtility('publicLinkBase', { window: { location: { protocol } } });
    assert.equal(browser.resolvePublicLinkBase({ domain: 'a.example;b.example', webUrl: '/sealchat' }), `${protocol}//a.example/sealchat`);
    assert.equal(browser.resolvePublicLinkBase({ domain: 'http://a.example;https://b.example' }), 'http://a.example');
    assert.equal(browser.resolvePublicLinkBase({ domain: 'https://a.example;http://b.example' }), 'https://a.example');
    assert.equal(browser.resolvePublicLinkBase({ domain: '//a.example;//b.example' }), '//a.example');
  }
});

test('shared public base produces primary-only channel, message, iForm, note and internal surface links', () => {
  const config = { domain: ' ; https://a.example/;;https://b.example ', webUrl: '/sealchat' };
  const base = resolvePublicLinkBase(config);
  const { generateChannelLink, generateMessageLink } = loadUtility('messageLink');
  const { generateIFormEmbedLink } = loadUtility('iformEmbedLink');
  const { generateStickyNoteEmbedLink } = loadUtility('stickyNoteEmbedLink');
  const { generateInternalSurfaceLink, resolveInternalSurfaceLinkBase } = loadUtility('internalSurfaceLink');
  const context = { worldId: 'world', channelId: 'channel' };
  assert.equal(resolveInternalSurfaceLinkBase(config), base);
  const links = [
    [generateChannelLink(context, { base }), '/#/world/channel'],
    [generateMessageLink({ ...context, messageId: 'message' }, { base }), '/#/world/channel?msg=message'],
    [generateIFormEmbedLink({ ...context, formId: 'form' }, { base }), '/#/world/channel?iform=form'],
    [generateStickyNoteEmbedLink({ ...context, noteId: 'note' }, { base }), '/#/world/channel?snote=note'],
    [generateInternalSurfaceLink({ ...context, type: 'note', id: 'note' }, { base: resolveInternalSurfaceLinkBase(config) }), '/#/internal/note/note?world=world&channel=channel'],
  ];
  for (const [link, suffix] of links) {
    assert.equal(link, `https://a.example/sealchat${suffix}`);
    assert.ok(!link.includes(';'));
    assert.ok(!link.includes('b.example'));
  }
});
