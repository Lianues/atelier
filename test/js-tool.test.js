import './setup.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { Atelier } from '../lib/workspace.js';
import { createAtelierApi, runWorkspaceScript } from '../lib/js-tool.js';

/**
 * @param {Record<string, any>} books
 */
function makeWorkspace(books = {}) {
    const metadata = {};
    const context = {
        chatMetadata: metadata,
        chatId: 'chat-A',
        getCurrentChatId: () => 'chat-A',
        saveMetadataDebounced: () => { },
        characters: [],
        characterId: 0,
        powerUserSettings: { world_info: { globalSelect: Object.keys(books) } },
        getWorldInfoNames: () => Object.keys(books),
        loadWorldInfo: async name => (books[name] ? { entries: structuredClone(books[name]) } : null),
        saveWorldInfo: async () => { },
    };
    return new Atelier(context, { storage: null });
}

/**
 * @param {number} uid
 * @param {string} comment
 * @param {string} content
 * @param {Record<string, any>} [extra]
 */
function wiEntry(uid, comment, content, extra = {}) {
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
        ...extra,
    };
}

test('ws 只暴露必要的原语（其余交给 JS 自己写）', () => {
    const ws = makeWorkspace();
    const api = createAtelierApi(ws);
    assert.deepEqual(Object.keys(api).sort(), ['files', 'move', 'parseYaml', 'read', 'remove', 'write']);
});

test('js：列文件、读文件', async () => {
    const ws = makeWorkspace();
    await ws.ensure();

    assert.equal(await runWorkspaceScript('return at.files().length', ws), '1');
    assert.equal(await runWorkspaceScript('return at.read("/README.md").startsWith("# 工作区")', ws), 'true');
});

test('js：联合搜索 —— 纯 JS + files/read/parseYaml', async () => {
    const ws = makeWorkspace({
        书: {
            0: wiEntry(0, '千束', '她喜欢咖啡', { key: ['千束', 'Chisato'] }),
            1: wiEntry(1, '泷奈', '她喜欢枪械', { key: ['泷奈'] }),
        },
    });
    await ws.ensure();
    await ws.importBook('书');

    const output = await runWorkspaceScript(`
        const yamls = at.files('/world_book').filter(f => f.includes('/entries/') && f.endsWith('.yaml'));
        const entries = yamls.map(path => ({
            path,
            yaml: at.parseYaml(at.read(path)),
            md: at.read(path.replace(/\\.yaml$/, '.md')),
        }));
        return entries
            .filter(e => (e.yaml.key ?? []).includes('千束') && e.md.includes('咖啡'))
            .map(e => ({ name: e.yaml.name, book: e.path.split('/')[2] }));
    `, ws);

    assert.deepEqual(JSON.parse(output), [{ name: '千束', book: '书' }]);
});

test('js：跨文件统计（纯 JS）', async () => {
    const ws = makeWorkspace();
    await ws.ensure();
    ws.fs.write('/a/1.txt', 'x\nx\n');
    ws.fs.write('/b/2.txt', 'x');

    const output = await runWorkspaceScript(`
        let total = 0;
        for (const path of at.files().filter(p => p.startsWith('/a') || p.startsWith('/b'))) total += (at.read(path).match(/x/g) ?? []).length;
        return total;
    `, ws);

    assert.equal(output, '3');
});

test('js：console.log 会被带回', async () => {
    const ws = makeWorkspace();
    await ws.ensure();

    const output = await runWorkspaceScript('console.log("hello", { a: 1 }); return 42;', ws);
    assert.match(output, /hello \{"a":1\}/);
    assert.match(output, /42/);
});

test('js：无返回值也无输出时给出提示', async () => {
    const ws = makeWorkspace();
    await ws.ensure();
    assert.match(await runWorkspaceScript('const x = 1;', ws), /无返回值/);
});

test('js：对象返回值序列化成 JSON', async () => {
    const ws = makeWorkspace();
    await ws.ensure();
    const output = await runWorkspaceScript('return { ok: true, n: 2 };', ws);
    assert.deepEqual(JSON.parse(output), { ok: true, n: 2 });
});

test('js：语法错误 / 运行时错误 / 空代码都会报错', async () => {
    const ws = makeWorkspace();
    await ws.ensure();

    await assert.rejects(() => runWorkspaceScript('return (', ws), /语法错误/);
    await assert.rejects(() => runWorkspaceScript('throw new Error("boom")', ws), /执行失败：boom/);
    await assert.rejects(() => runWorkspaceScript('   ', ws), /code 不能为空/);
});

test('js：异步超时会中断', async () => {
    const ws = makeWorkspace();
    await ws.ensure();

    await assert.rejects(
        () => runWorkspaceScript('await new Promise(r => setTimeout(r, 500)); return 1;', ws, { timeout: 50 }),
        /执行超时/,
    );
});

test('js：可写，写进去的内容能在工作区里看到', async () => {
    const ws = makeWorkspace();
    await ws.ensure();

    const output = await runWorkspaceScript(`
        const created = at.write('/demo/a.txt', 'hello');
        return { created: created.created, content: at.read('/demo/a.txt') };
    `, ws);

    assert.deepEqual(JSON.parse(output), { created: true, content: 'hello' });
    assert.equal(ws.fs.read('/demo/a.txt'), 'hello');
});

test('js：parseYaml 能把条目配置解析成对象', async () => {
    const ws = makeWorkspace();
    await ws.ensure();
    ws.fs.write('/x.yaml', 'index: 3\nname: 泷奈\nkey:\n  - a\n  - b\n');

    const output = await runWorkspaceScript(
        'const y = at.parseYaml(at.read("/x.yaml")); return { index: y.index, keys: y.key.length };',
        ws,
    );

    assert.deepEqual(JSON.parse(output), { index: 3, keys: 2 });
});

test('js：能访问页面全局（不是沙箱）', async () => {
    const ws = makeWorkspace();
    await ws.ensure();

    globalThis.__at_probe = { hit: 7 };
    try {
        assert.equal(await runWorkspaceScript('return __at_probe.hit', ws), '7');
    } finally {
        delete globalThis.__at_probe;
    }
});

test('js：st 就是 SillyTavern.getContext()', async () => {
    const ws = makeWorkspace();
    await ws.ensure();

    globalThis.SillyTavern = { getContext: () => ({ marker: 'ok' }) };
    try {
        assert.equal(await runWorkspaceScript('return st.marker', ws), 'ok');
    } finally {
        delete globalThis.SillyTavern;
    }

    assert.equal(await runWorkspaceScript('return st === null', ws), 'true');
});

test('js：ws.move 能移动 / 重命名文件', async () => {
    const ws = makeWorkspace();
    await ws.ensure();
    ws.fs.write('/demo/a.txt', 'hi');

    const output = await runWorkspaceScript(`
        const result = at.move('/demo/a.txt', '/demo/b.txt');
        return {
            nodes: result.nodes,
            oldGone: !at.files().includes('/demo/a.txt'),
            content: at.read('/demo/b.txt'),
        };
    `, ws);

    assert.deepEqual(JSON.parse(output), { nodes: 1, oldGone: true, content: 'hi' });
});

test('js：ws.move 也能搬整个目录', async () => {
    const ws = makeWorkspace();
    await ws.ensure();
    ws.fs.write('/old/a.txt', '1');
    ws.fs.write('/old/sub/b.txt', '2');

    const output = await runWorkspaceScript(`
        at.move('/old', '/new');
        return at.files().filter(p => p.startsWith('/new')).sort();
    `, ws);

    assert.deepEqual(JSON.parse(output), ['/new/a.txt', '/new/sub/b.txt']);
});

test('js：ws.remove 能删文件和整个目录', async () => {
    const ws = makeWorkspace();
    await ws.ensure();
    ws.fs.write('/demo/a.txt', '1');
    ws.fs.write('/dir/sub/b.txt', '2');

    const output = await runWorkspaceScript(`
        const one = at.remove('/demo/a.txt');
        const many = at.remove('/dir');
        return { one: one.nodes, many: many.nodes, left: at.files().filter(p => p.startsWith('/demo') || p.startsWith('/dir')) };
    `, ws);

    assert.deepEqual(JSON.parse(output), { one: 1, many: 3, left: [] }); // /dir + /dir/sub + b.txt
});

test('js：改名 = move，内容不变、旧路径消失', async () => {
    const ws = makeWorkspace();
    await ws.ensure();
    ws.fs.write('/world_book/甲/entries/3_旧标题.md', '正文');

    const output = await runWorkspaceScript(`
        at.move('/world_book/甲/entries/3_旧标题.md', '/world_book/甲/entries/3_新标题.md');
        return { files: at.files('/world_book/甲/entries'), content: at.read('/world_book/甲/entries/3_新标题.md') };
    `, ws);

    assert.deepEqual(JSON.parse(output), {
        files: ['/world_book/甲/entries/3_新标题.md'],
        content: '正文',
    });
});

test('js：at 是工作区 API', async () => {
    const ws = makeWorkspace();
    await ws.ensure();

    assert.equal(await runWorkspaceScript('return at.files().length', ws), '1');
    assert.equal(await runWorkspaceScript('return typeof at.read === "function"', ws), 'true');
});
