import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoSync } from '../lib/auto-sync.js';
import { Atelier } from '../lib/workspace.js';
import './setup.mjs';

/**
 * @param {{books?: string[], chatId?: string}} [options]
 */
function makeContext(options = {}) {
    /** @type {Record<string, Function[]>} */
    const handlers = {};
    return {
        extensionSettings: { 'atelier': {} },
        chatId: options.chatId ?? 'chat-A',
        getCurrentChatId: () => options.chatId ?? 'chat-A',
        saveSettingsDebounced: () => { },
        eventTypes: { WORLDINFO_UPDATED: 'wi-updated', WORLDINFO_SETTINGS_UPDATED: 'wi-settings' },
        eventSource: {
            on: (type, handler) => {
                (handlers[type] ??= []).push(handler);
            },
        },
        emit(type) {
            for (const handler of handlers[type] ?? []) handler();
        },
        handlers,
        books: options.books ?? ['书'],
    };
}

/**
 * @param {any} context
 */
function makeWorkspace(context) {
    const calls = [];
    return {
        calls,
        isBound: () => true,
        isReady: () => true,
        ready: async () => { },
        activeBooks: async () => context.books,
        importAll: async mode => {
            calls.push(mode);
            return [{ created: 0 }];
        },
        onChange: () => () => { },
        bookDirs: () => [],
        fs: { isDir: () => false },
        applyBook: async () => ({ book: 'x', written: 0 }),
    };
}

test('默认开启', () => {
    const context = makeContext();
    const sync = new AutoSync(context, makeWorkspace(context));
    assert.equal(sync.enabled, true);
    assert.equal(context.extensionSettings['atelier'].autoSync, undefined);
});

test('关掉之后 setEnabled 会持久化，并且不再导入', async () => {
    const context = makeContext();
    const workspace = makeWorkspace(context);
    const sync = new AutoSync(context, workspace);

    sync.setEnabled(false);
    assert.equal(context.extensionSettings['atelier'].autoSync, false);

    await sync.run('test');
    assert.equal(workspace.calls.length, 0);

    sync.setEnabled(true);
    assert.equal(context.extensionSettings['atelier'].autoSync, true);
    await sync.run('test');
    assert.equal(workspace.calls.length, 1);
});

test('同一批书只导入一次（fill 模式）', async () => {
    const context = makeContext();
    const workspace = makeWorkspace(context);
    const sync = new AutoSync(context, workspace);

    await sync.run('first');
    await sync.run('second');

    assert.deepEqual(workspace.calls, ['fill']);
});

test('世界书变了（WORLDINFO_UPDATED）会重新导入', async () => {
    const context = makeContext();
    const workspace = makeWorkspace(context);
    const sync = new AutoSync(context, workspace);
    sync.install();

    await sync.run('first');
    context.emit('wi-updated');
    await sync.run('after-update');

    assert.deepEqual(workspace.calls, ['fill', 'fill']);
});

test('切换聊天后重新导入', async () => {
    const context = makeContext();
    const workspace = makeWorkspace(context);
    const sync = new AutoSync(context, workspace);

    await sync.run('first');
    sync.onChatChanged();
    context.chatId = 'chat-B';
    await sync.run('chat-b');

    assert.deepEqual(workspace.calls, ['fill', 'fill']);
});

test('没有启用任何世界书时不做任何事', async () => {
    const context = makeContext({ books: [] });
    const workspace = makeWorkspace(context);
    const sync = new AutoSync(context, workspace);

    await sync.run('empty');
    assert.equal(workspace.calls.length, 0);
});

test('没有绑定聊天时跳过', async () => {
    const context = makeContext();
    const workspace = makeWorkspace(context);
    workspace.isBound = () => false;
    const sync = new AutoSync(context, workspace);

    await sync.run('no-chat');
    assert.equal(workspace.calls.length, 0);
});

test('导入抛错不会把状态搞坏', async () => {
    const context = makeContext();
    const workspace = makeWorkspace(context);
    workspace.importAll = async () => {
        throw new Error('boom');
    };
    const sync = new AutoSync(context, workspace);

    await sync.run('fail');
    assert.equal(sync.running, false);
});

/* ------------------------- 停用的书要被移除 ------------------------- */

/**
 * 用真实的 Atelier + 假 context 建一个环境。
 * @param {{known: string[], active: string[], data: Record<string, any>}} options
 */
function makeRealEnv(options) {
    const metadata = {};
    const context = {
        chatMetadata: metadata,
        chatId: 'chat-A',
        getCurrentChatId: () => 'chat-A',
        saveMetadataDebounced: () => { },
        saveSettingsDebounced: () => { },
        characters: [],
        characterId: 0,
        powerUserSettings: { world_info: { globalSelect: [...options.active] } },
        getWorldInfoNames: () => options.known,
        loadWorldInfo: async name => (options.data[name] ? { entries: structuredClone(options.data[name]) } : null),
        saveWorldInfo: async (name, payload) => { options.data[name] = structuredClone(payload.entries); },
        extensionSettings: { 'atelier': {} },
        eventTypes: {},
        eventSource: { on: () => { } },
    };
    const workspace = new Atelier(context, { storage: null });
    const sync = new AutoSync(context, workspace);
    sync.install();
    return { context, workspace, sync, options };
}

/**
 * @param {number} uid
 * @param {string} comment
 */
function entry(uid, comment) {
    return {
        uid,
        key: ['k'],
        keysecondary: [],
        comment,
        content: `正文 ${uid}`,
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

test('停用世界书后，对应目录会被自动移除', async () => {
    const env = makeRealEnv({
        known: ['甲', '乙'],
        active: ['甲', '乙'],
        data: { 甲: { 0: entry(0, 'a') }, 乙: { 1: entry(1, 'b') } },
    });

    await env.sync.run('first');
    assert.equal(env.workspace.fs.isDir('/world_book/甲'), true);
    assert.equal(env.workspace.fs.isDir('/world_book/乙'), true);

    // 停用「乙」
    env.context.powerUserSettings.world_info.globalSelect.length = 0;
    env.context.powerUserSettings.world_info.globalSelect.push('甲');

    await env.sync.run('deactivate');

    assert.equal(env.workspace.fs.isDir('/world_book/甲'), true, '启用的书要留着');
    assert.equal(env.workspace.fs.isDir('/world_book/乙'), false, '停用的书要移除');
    assert.equal(env.workspace.fs.exists('/world_book/乙/entries/1_b.yaml'), false);
    assert.equal('/world_book/乙' in env.workspace.store.books, false);
});

test('全部停用时清空 world_book 下的书目录', async () => {
    const env = makeRealEnv({
        known: ['甲'],
        active: ['甲'],
        data: { 甲: { 0: entry(0, 'a') } },
    });

    await env.sync.run('first');
    assert.equal(env.workspace.fs.isDir('/world_book/甲'), true);

    env.context.powerUserSettings.world_info.globalSelect.length = 0;
    await env.sync.run('all-off');

    assert.equal(env.workspace.fs.isDir('/world_book/甲'), false);
    assert.deepEqual(env.workspace.bookDirs(), []);
});

test('世界书列表还没加载好（空列表）时不动手', async () => {
    const env = makeRealEnv({
        known: ['甲'],
        active: ['甲'],
        data: { 甲: { 0: entry(0, 'a') } },
    });

    await env.sync.run('first');

    // 模拟启动早期：世界书列表还没拿到，启用列表也是空
    env.options.known = [];
    env.options.data = {};
    env.context.powerUserSettings.world_info.globalSelect.length = 0;

    await env.sync.run('early-startup');

    assert.equal(env.workspace.fs.isDir('/world_book/甲'), true, '不能因为列表没加载就把工作区删空');
});

/* ------------------------- 工作区改动自动写回 ------------------------- */

test('改工作区里的世界书文件 → 自动写回酒馆', async () => {
    const env = makeRealEnv({
        known: ['甲'],
        active: ['甲'],
        data: { 甲: { 0: entry(0, 'a') } },
    });

    await env.sync.run('import');
    const mdPath = '/world_book/甲/entries/0_a.md';
    assert.equal(env.workspace.fs.read(mdPath), '正文 0');

    env.workspace.fs.write(mdPath, '改过的正文');
    env.workspace.touch('tool-edit', { path: mdPath });
    await env.sync.writeBack();

    assert.equal(env.options.data['甲'][0].content, '改过的正文');
    assert.equal(env.sync.dirtyDirs.size, 0);
});

test('改 yaml 也会写回（标题等字段）', async () => {
    const env = makeRealEnv({
        known: ['甲'],
        active: ['甲'],
        data: { 甲: { 0: entry(0, 'a') } },
    });

    await env.sync.run('import');
    const yamlPath = '/world_book/甲/entries/0_a.yaml';
    env.workspace.fs.write(yamlPath, env.workspace.fs.read(yamlPath).replace('name: a', 'name: 改过'));
    env.workspace.touch('tool-edit', { path: yamlPath });
    await env.sync.writeBack();

    assert.equal(env.options.data['甲'][0].comment, '改过');
});

test('改动不在世界书目录里 → 不写回', async () => {
    const env = makeRealEnv({
        known: ['甲'],
        active: ['甲'],
        data: { 甲: { 0: entry(0, 'a') } },
    });

    await env.sync.run('import');
    env.workspace.fs.write('/demo/a.txt', 'x');
    env.workspace.touch('tool-write', { path: '/demo/a.txt' });

    assert.equal(env.sync.dirtyDirs.size, 0);
    await env.sync.writeBack();
});

test('关掉自动同步后，工作区改动不再自动写回', async () => {
    const env = makeRealEnv({
        known: ['甲'],
        active: ['甲'],
        data: { 甲: { 0: entry(0, 'a') } },
    });

    await env.sync.run('import');
    env.sync.setEnabled(false);

    const mdPath = '/world_book/甲/entries/0_a.md';
    env.workspace.fs.write(mdPath, '不应该写回');
    env.workspace.touch('tool-edit', { path: mdPath });
    await env.sync.writeBack();

    assert.equal(env.options.data['甲'][0].content, '正文 0');
    assert.equal(env.sync.dirtyDirs.size, 0);
});
