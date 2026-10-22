import './setup.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { Atelier, META_KEY, BOOK_ROOT, HISTORY_DIR } from '../lib/workspace.js';
import { createToolHandlers } from '../lib/tools.js';
import { parseGrepArgs } from '../lib/grep.js';
import { parseYaml } from '../lib/yaml.js';

/**
 * @param {string} chatId
 * @param {Record<string, any>} meta
 * @param {Record<string, Record<string, any>>} books
 */
function makeContext(chatId, meta, books) {
    return {
        chatMetadata: meta,
        chatId,
        getCurrentChatId: () => chatId,
        saveMetadataDebounced: () => { },
        characters: [],
        characterId: 0,
        powerUserSettings: { world_info: { globalSelect: Object.keys(books) } },
        getWorldInfoNames: () => Object.keys(books),
        loadWorldInfo: async (name) => (books[name] ? { entries: structuredClone(books[name]) } : null),
        saveWorldInfo: async (name, data) => {
            books[name] = structuredClone(data.entries);
        },
    };
}

/**
 * @param {number} uid
 * @param {string} comment
 * @param {string} content
 */
function wiEntry(uid, comment, content) {
    return {
        uid,
        key: ['关键词'],
        keysecondary: [],
        comment,
        content,
        constant: false,
        vectorized: false,
        selective: true,
        selectiveLogic: 0,
        order: 100,
        position: 0,
        disable: false,
        excludeRecursion: false,
        preventRecursion: false,
        probability: 100,
        depth: 4,
        role: 0,
    };
}

test('ensure：建立骨架并写入聊天指针', async () => {
    const meta = {};
    const books = {};
    const ws = new Atelier(makeContext('chat-A', meta, books), { storage: null });

    assert.equal(ws.isBound(), true);
    assert.equal(await ws.ensure(), true);

    assert.equal(ws.fs.isDir(HISTORY_DIR), true);
    assert.equal(ws.fs.isDir(BOOK_ROOT), true);
    assert.match(ws.fs.read('/README.md'), /工作区/);

    const ref = meta[META_KEY];
    assert.equal(ref.storage, 'chat');
    assert.equal(ref.owner, 'chat-A');
    assert.ok(ref.sid);
    assert.ok(ref.nodes, 'IndexedDB 不可用时正文要落在元数据里');

    // 幂等
    assert.equal(await ws.ensure(), false);
});

test('importBook -> 目录结构 / yaml 内容 / md 正文', async () => {
    const meta = {};
    const books = { 测试书: { 0: wiEntry(0, '千束', '正文A'), 7: wiEntry(7, '泷奈', '正文B') } };
    const ws = new Atelier(makeContext('chat-A', meta, books), { storage: null });
    await ws.ensure();

    const result = await ws.importBook('测试书');
    assert.equal(result.created, 2);
    assert.equal(result.total, 2);

    const dir = `${BOOK_ROOT}/测试书`;
    assert.equal(ws.fs.isDir(dir), true);

    const metaDoc = parseYaml(ws.fs.read(`${dir}/_metadata.yaml`));
    assert.equal(metaDoc.name, '测试书');
    assert.equal(metaDoc.entries, 'world_book/测试书/entries');

    const files = ws.fs.list(`${dir}/entries`).map(item => item.name).sort();
    assert.deepEqual(files, ['0_千束.md', '0_千束.yaml', '7_泷奈.md', '7_泷奈.yaml']);

    const yamlDoc = parseYaml(ws.fs.read(`${dir}/entries/0_千束.yaml`));
    assert.equal(yamlDoc.index, 0);
    assert.equal(yamlDoc.name, '千束');
    assert.equal(yamlDoc.activationMode, 'keyword');
    assert.equal(ws.fs.read(`${dir}/entries/0_千束.md`), '正文A');

    // fill 模式第二次不重复创建
    const again = await ws.importBook('测试书');
    assert.equal(again.created, 0);
    assert.equal(again.skipped, 2);
});

test('edit / write 工具改文件 -> applyBook 写回世界书', async () => {
    const meta = {};
    const books = { 书: { 0: wiEntry(0, '千束', '正文A') } };
    const ws = new Atelier(makeContext('chat-A', meta, books), { storage: null });
    await ws.ensure();
    await ws.importBook('书');

    const tools = createToolHandlers(ws);

    assert.match(await tools.read({ path: '/world_book/书/entries/0_千束.md' }), /正文A/);
    assert.match(await tools.read({ path: '/world_book/书' }), /entries\//);

    const editResult = await tools.edit({
        path: '/world_book/书/entries/0_千束.md',
        hunks: [{ oldContent: '正文A', newContent: '正文A（已改）' }],
    });
    assert.match(editResult, /replaced 1/);

    // 改 yaml 里的标题与关键词
    await tools.edit({
        path: '/world_book/书/entries/0_千束.yaml',
        hunks: [{ oldContent: 'name: 千束', newContent: 'name: 千束（改）' }],
    });

    const applied = await ws.applyBook('/world_book/书');
    assert.equal(applied.written, 1);
    assert.equal(applied.warnings.length, 0);

    assert.equal(books['书'][0].content, '正文A（已改）');
    assert.equal(books['书'][0].comment, '千束（改）');
});

test('applyBook：uid 重复会报错', async () => {
    const meta = {};
    const books = { 书: { 0: wiEntry(0, 'a', 'x') } };
    const ws = new Atelier(makeContext('chat-A', meta, books), { storage: null });
    await ws.ensure();
    await ws.importBook('书');

    const dir = `${BOOK_ROOT}/书/entries`;
    ws.fs.write(`${dir}/1_b.yaml`, 'index: 0\nname: b\n');
    ws.fs.write(`${dir}/1_b.md`, 'y');

    await assert.rejects(() => ws.applyBook('/world_book/书'), /uid 0 重复/);
});

test('edit 工具：找不到 / 多处命中 的报错', async () => {
    const meta = {};
    const books = {};
    const ws = new Atelier(makeContext('chat-A', meta, books), { storage: null });
    await ws.ensure();
    const tools = createToolHandlers(ws);

    await tools.write({ path: '/a.txt', content: 'x\ny\nx\n' });
    await assert.rejects(() => tools.edit({ path: '/a.txt', hunks: [{ oldContent: 'zzz', newContent: 'q' }] }), /找不到 oldContent/);
    await assert.rejects(() => tools.edit({ path: '/a.txt', hunks: [{ oldContent: 'x', newContent: 'q' }] }), /出现 2 次/);

    const result = await tools.edit({ path: '/a.txt', hunks: [{ oldContent: 'x', newContent: 'q', replaceAll: true }] });
    assert.match(result, /replaced 2/);
    assert.equal(ws.fs.read('/a.txt'), 'q\ny\nq\n');
});

test('importAll：reset 清空 world_book 后重建', async () => {
    const meta = {};
    const books = { 甲: { 0: wiEntry(0, 'a', 'A') }, 乙: { 5: wiEntry(5, 'b', 'B') } };
    const ws = new Atelier(makeContext('chat-A', meta, books), { storage: null });
    await ws.ensure();

    await ws.importAll('fill');
    assert.equal(ws.bookDirs().length, 2);

    // 手加一个野文件 + 改一个正文
    ws.fs.write('/world_book/甲/entries/99_野.md', '野生');
    ws.fs.write('/world_book/甲/entries/0_a.md', '被改过');

    const results = await ws.importAll('reset');
    assert.equal(results.length, 2);
    assert.equal(ws.fs.exists('/world_book/甲/entries/99_野.md'), false);
    assert.equal(ws.fs.read('/world_book/甲/entries/0_a.md'), 'A');
    assert.deepEqual(ws.bookDirs().map(item => item.book).sort(), ['乙', '甲']);
});

test('分支/改名：owner 不匹配时克隆，两边互不影响', async () => {
    const meta = {};
    const books = { 书: { 0: wiEntry(0, 'a', '原文') } };
    const ws = new Atelier(makeContext('chat-A', meta, books), { storage: null });
    await ws.ensure();
    await ws.importBook('书');
    const sidA = meta[META_KEY].sid;

    // 模拟分支：chat_metadata 被整份复制到新聊天
    const branchMeta = structuredClone(meta);
    const wsBranch = new Atelier(makeContext('chat-B', branchMeta, books), { storage: null });
    await wsBranch.ready();

    assert.notEqual(branchMeta[META_KEY].sid, sidA, '分支必须换一个新的 sid');
    assert.equal(branchMeta[META_KEY].owner, 'chat-B');
    assert.equal(wsBranch.fs.read('/world_book/书/entries/0_a.md'), '原文', '分支要继承内容');

    wsBranch.fs.write('/world_book/书/entries/0_a.md', '分支里改的');
    assert.equal(ws.fs.read('/world_book/书/entries/0_a.md'), '原文', '原聊天不受影响');
});

test('movePath：世界书目录改名后，目录→书名映射跟着走', async () => {
    const meta = {};
    const books = { 书: { 0: wiEntry(0, '条目', '正文') } };
    const ws = new Atelier(makeContext('chat-A', meta, books), { storage: null });

    await ws.importBook('书');
    const before = ws.bookDirs();
    assert.equal(before.length, 1);

    const from = before[0].dir;
    const to = '/world_book/改名后';
    ws.movePath(from, to);

    assert.equal(ws.fs.isDir(to), true);
    assert.equal(ws.fs.exists(from), false);
    assert.equal(ws.store.books[to], '书', '映射要指向新目录，书名不变');

    // 改名后仍能写回原世界书
    const result = await ws.applyBook(to);
    assert.equal(result.book, '书');
    assert.equal(result.written, 1);
});

test('removePath：删世界书目录时清掉目录→书名映射', async () => {
    const meta = {};
    const books = { 书: { 0: wiEntry(0, '条目', '正文') } };
    const ws = new Atelier(makeContext('chat-A', meta, books), { storage: null });

    await ws.importBook('书');
    const dir = ws.bookDirs()[0].dir;
    assert.equal(ws.store.books[dir], '书');

    const removed = ws.removePath(dir);
    assert.ok(removed > 1);
    assert.equal(ws.fs.exists(dir), false);
    assert.equal(dir in ws.store.books, false);
    assert.deepEqual(ws.bookDirs(), []);
});

test('read：startLine/endLine 是 1-based 闭区间', async () => {
    const ws = new Atelier(makeContext('chat-A', {}, {}), { storage: null });
    await ws.ensure();
    const tools = createToolHandlers(ws);

    await tools.write({ path: '/r.txt', content: 'a\nb\nc\nd\ne' });

    assert.equal(await tools.read({ path: '/r.txt', startLine: 2, endLine: 4 }), '# /r.txt lines 2-4 of 5\nb\nc\nd');
    assert.equal(await tools.read({ path: '/r.txt', startLine: 4 }), '# /r.txt lines 4-5 of 5\nd\ne');
    assert.equal(await tools.read({ path: '/r.txt', endLine: 2 }), '# /r.txt lines 1-2 of 5\na\nb');
    assert.equal(await tools.read({ path: '/r.txt', startLine: 9 }), '# /r.txt lines 9-8 of 5\n');
});

test('write：内容没变时返回 Unchanged，不重复落盘', async () => {
    const ws = new Atelier(makeContext('chat-A', {}, {}), { storage: null });
    await ws.ensure();
    const tools = createToolHandlers(ws);

    assert.equal(await tools.write({ path: '/w.txt', content: 'same' }), 'Created /w.txt (4 bytes, 1 lines)');
    assert.equal(await tools.write({ path: '/w.txt', content: 'same' }), 'Unchanged /w.txt (4 bytes, 1 lines)');
    assert.equal(await tools.write({ path: '/w.txt', content: 'changed' }), 'Updated /w.txt (7 bytes, 1 lines)');
});

test('edit：hunks 一次改多处，按顺序应用', async () => {
    const ws = new Atelier(makeContext('chat-A', {}, {}), { storage: null });
    await ws.ensure();
    const tools = createToolHandlers(ws);

    await tools.write({ path: '/h.txt', content: 'name: A\nage: 1\ntag: x\n' });

    const result = await tools.edit({
        path: '/h.txt',
        hunks: [
            { oldContent: 'name: A', newContent: 'name: B' },
            { oldContent: 'age: 1', newContent: 'age: 2' },
        ],
    });

    assert.match(result, /2 hunk\(s\), replaced 2 occurrence\(s\)/);
    assert.equal(ws.fs.read('/h.txt'), 'name: B\nage: 2\ntag: x\n');
});

test('edit：hunk 的 replaceAll 与报错位置', async () => {
    const ws = new Atelier(makeContext('chat-A', {}, {}), { storage: null });
    await ws.ensure();
    const tools = createToolHandlers(ws);

    await tools.write({ path: '/m.txt', content: 'x x x\n' });

    await assert.rejects(
        () => tools.edit({ path: '/m.txt', hunks: [{ oldContent: 'x', newContent: 'y' }] }),
        /oldContent 在 \/m\.txt 中出现 3 次/,
    );

    const result = await tools.edit({ path: '/m.txt', hunks: [{ oldContent: 'x', newContent: 'y', replaceAll: true }] });
    assert.match(result, /replaced 3 occurrence\(s\)/);
    assert.equal(ws.fs.read('/m.txt'), 'y y y\n');
});

test('edit：hunks 里第几个出错要说清楚', async () => {
    const ws = new Atelier(makeContext('chat-A', {}, {}), { storage: null });
    await ws.ensure();
    const tools = createToolHandlers(ws);

    await tools.write({ path: '/n.txt', content: 'aaa' });

    await assert.rejects(
        () => tools.edit({
            path: '/n.txt',
            hunks: [
                { oldContent: 'aaa', newContent: 'bbb' },
                { oldContent: 'zzz', newContent: 'q' },
            ],
        }),
        /第 2 个 hunk：在 \/n\.txt 中找不到 oldContent/,
    );
});

test('grep 工具：返回 ripgrep 风格文本', async () => {
    const ws = new Atelier(makeContext('chat-A', {}, {}), { storage: null });
    await ws.ensure();
    const tools = createToolHandlers(ws);

    await tools.write({ path: '/a/one.md', content: 'line1\nfoo bar\nline3\n' });
    await tools.write({ path: '/a/two.yaml', content: 'name: foo\n' });

    const text = await tools.grep({ args: 'foo' });
    assert.match(text, /\/a\/one\.md:2:1: foo bar/);
    assert.match(text, /\/a\/two\.yaml:1:7: name: foo/);
    assert.match(text, /2 条命中 · 扫描 \d+ 个文件/);
});

test('grep 工具：glob / count / filesOnly / context / 无命中 / 空 pattern', async () => {
    const ws = new Atelier(makeContext('chat-A', {}, {}), { storage: null });
    await ws.ensure();
    const tools = createToolHandlers(ws);

    await tools.write({ path: '/g/a.md', content: 'x\nTARGET\ny\n' });
    await tools.write({ path: '/g/b.yaml', content: 'TARGET here\n' });

    const globbed = await tools.grep({ args: 'TARGET -g "*.yaml"' });
    assert.match(globbed, /\/g\/b\.yaml:1:1/);
    assert.doesNotMatch(globbed, /a\.md/);

    const counted = await tools.grep({ args: 'TARGET -c' });
    assert.match(counted, /\/g\/a\.md: 1/);
    assert.match(counted, /\/g\/b\.yaml: 1/);

    const only = await tools.grep({ args: 'TARGET -l' });
    assert.match(only, /^\/g\/a\.md$/m);

    const withContext = await tools.grep({ args: 'TARGET -C 1 /g/a.md' });
    assert.match(withContext, /  - x/);
    assert.match(withContext, /  - y/);

    const none = await tools.grep({ args: '绝对没有这个' });
    assert.match(none, /没有匹配（扫描 \d+ 个文件/);

    await assert.rejects(() => tools.grep({ args: '' }), /缺少 pattern/);
});

test('grep：Unicode 属性 \\p{Script=Han} 自动启用 u 标志', async () => {
    const ws = new Atelier(makeContext('chat-A', {}, {}), { storage: null });
    await ws.ensure();
    const tools = createToolHandlers(ws);

    await tools.write({ path: '/u.md', content: '第一行 千束\nsecond line\n' });

    const text = await tools.grep({ args: '\\p{Script=Han}+' });
    assert.match(text, /\/u\.md:1:1: 第一行/);

    // 属性名写错要报错，而不是静默搜不到
    await assert.rejects(() => tools.grep({ args: '\\p{Han}+' }), /Unicode 属性要写成/);
});

test('grep 工具：多行匹配压成一行输出', async () => {
    const ws = new Atelier(makeContext('chat-A', {}, {}), { storage: null });
    await ws.ensure();
    const tools = createToolHandlers(ws);

    await tools.write({ path: '/m.md', content: 'A\nB\nC\n' });

    const text = await tools.grep({ args: 'A[\\s\\S]*B' });
    assert.match(text, /\/m\.md:1:1: A⏎B/);
    assert.equal(text.split('\n').filter(line => line.includes('/m.md:')).length, 1);
});

test('grep 参数串：引号、短选项、-- 终止符', () => {
    assert.deepEqual(parseGrepArgs('千束'), { pattern: '千束', options: { path: undefined } });
    assert.deepEqual(
        parseGrepArgs('TARGET -i -g "*.yaml" -C 1 /world_book'),
        { pattern: 'TARGET', options: { ignoreCase: true, glob: '*.yaml', context: 1, path: '/world_book' } },
    );
    assert.deepEqual(parseGrepArgs('-F "a.b"'), { pattern: 'a.b', options: { fixed: true, path: undefined } });
    assert.deepEqual(parseGrepArgs('x -l'), { pattern: 'x', options: { mode: 'files', path: undefined } });
    assert.deepEqual(parseGrepArgs('x -c -m 5'), { pattern: 'x', options: { mode: 'count', maxResults: 5, path: undefined } });
    assert.deepEqual(parseGrepArgs('-- -开头'), { pattern: '-开头', options: { path: undefined } });
    assert.deepEqual(parseGrepArgs("'带 空格'"), { pattern: '带 空格', options: { path: undefined } });
    assert.deepEqual(parseGrepArgs('x -g*.md'), { pattern: 'x', options: { glob: '*.md', path: undefined } });
});

test('grep 参数串：报错说清楚', () => {
    assert.throws(() => parseGrepArgs(''), /缺少 pattern/);
    assert.throws(() => parseGrepArgs('x -Z'), /不认识的选项 -Z/);
    assert.throws(() => parseGrepArgs('x -g'), /-g 后面缺少 GLOB/);
    assert.throws(() => parseGrepArgs('x "未闭合'), /引号没有闭合/);
    assert.throws(() => parseGrepArgs('x /a /b'), /只支持一个搜索路径/);
    assert.throws(() => parseGrepArgs('x -C abc'), /需要数字/);
});
