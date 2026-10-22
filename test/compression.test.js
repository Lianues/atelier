import './setup.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatCompression, buildTranscript, hashText, matchIndices, planRange } from '../lib/compression.js';
import { Atelier } from '../lib/workspace.js';

/**
 * @param {{messages?: any[], maxContext?: number}} [options]
 */
function makeContext(options = {}) {
    const metadata = {};
    const chat = options.messages ?? [];
    const context = {
        chat,
        chatMetadata: metadata,
        chatId: 'chat-A',
        getCurrentChatId: () => 'chat-A',
        maxContext: options.maxContext ?? 1000,
        saveMetadataDebounced: () => { },
        saveSettingsDebounced: () => { },
        extensionSettings: { 'atelier': {} },
        eventTypes: {},
        eventSource: { on: () => { } },
        characters: [],
        characterId: 0,
        powerUserSettings: { world_info: { globalSelect: [] } },
        getWorldInfoNames: () => [],
        loadWorldInfo: async () => null,
        saveWorldInfo: async () => { },
        getTokenCountAsync: async text => Math.max(1, Math.ceil(String(text).length / 2)),
        generateQuietPrompt: async () => '## 当前情境\n测试摘要',
    };
    return context;
}

/**
 * @param {any} context
 */
function makeCompression(context, options = {}) {
    const workspace = new Atelier(context, { storage: null });
    const compression = new ChatCompression(context, workspace, options);
    // 功能默认关闭，测试里统一打开；要测「默认关」就传 { enabled: false }
    if (options.enabled !== false) compression.setEnabled(true);
    return { workspace, compression };
}

/**
 * @param {number} count
 * @returns {any[]}
 */
function makeChat(count) {
    return Array.from({ length: count }, (_, index) => ({
        name: index % 2 === 0 ? 'User' : '角色',
        is_user: index % 2 === 0,
        is_system: false,
        mes: `第 ${index + 1} 条消息的内容`,
    }));
}

test('hashText：空白变化不影响指纹，内容变化影响', () => {
    assert.equal(hashText('abc  def'), hashText('abc def'));
    assert.equal(hashText('  abc def  '), hashText('abc def'));
    assert.notEqual(hashText('abc def'), hashText('abc deg'));
});

test('planRange：保护首条 + 尾部', () => {
    assert.deepEqual(planRange(20, 6), { start: 1, end: 14 });
    assert.deepEqual(planRange(5, 6), { start: 1, end: 1 });
});

test('buildTranscript：带说话人', () => {
    const text = buildTranscript([
        { is_user: true, mes: '你好' },
        { name: '莉可丽丝', mes: '嗯' },
    ]);
    assert.match(text, /### 1\. 用户\n你好/);
    assert.match(text, /### 2\. 莉可丽丝\n嗯/);
});

test('matchIndices：按指纹顺序匹配，跳过 system', () => {
    const chat = makeChat(6);
    const hashes = chat.slice(1, 4).map(message => hashText(message.mes));

    const request = [
        { role: 'system', content: '系统提示' },
        ...chat.map(message => ({ role: message.is_user ? 'user' : 'assistant', content: message.mes })),
        { role: 'system', content: '作者注释' },
    ];

    const matched = matchIndices(request, hashes);
    assert.deepEqual(matched, [2, 3, 4]);
});

test('matchIndices：内容被改过就返回 null', () => {
    const chat = makeChat(6);
    const hashes = chat.slice(1, 4).map(message => hashText(message.mes));

    const request = chat.map(message => ({ role: message.is_user ? 'user' : 'assistant', content: message.mes }));
    request[2].content = '被编辑过了';

    assert.equal(matchIndices(request, hashes), null);
});

test('matchIndices：消息不够也返回 null', () => {
    const chat = makeChat(2);
    const hashes = makeChat(5).map(message => hashText(message.mes));
    const request = chat.map(message => ({ role: 'user', content: message.mes }));
    assert.equal(matchIndices(request, hashes), null);
});

test('compress：原文按「楼层-分支」归档 + 摘要入 metadata', async () => {
    const context = makeContext({ messages: makeChat(20) });
    const { workspace, compression } = makeCompression(context);
    await workspace.ready();

    const result = await compression.compress({ trigger: 'manual' });
    assert.equal(result.compressed, true);

    const state = compression.state;
    assert.equal(state.messages, 13); // 20 - 1(首条) - 6(尾部)
    assert.equal(state.archive, '/chat_history/2-1.md ~ /chat_history/14-1.md');

    const first = workspace.fs.read('/chat_history/2-1.md');
    assert.match(first, /# 楼层 2 · 分支 1/);
    assert.match(first, /第 2 条消息的内容/);

    assert.equal(workspace.fs.exists('/chat_history/14-1.md'), true);
    assert.equal(workspace.fs.exists('/chat_history/1-1.md'), false, '首条被保护，不归档');
    assert.equal(workspace.fs.exists('/chat_history/15-1.md'), false, '尾部不参与压缩');

    assert.match(state.summary, /当前情境/);
});

test('applyToPrompt：把压缩段换成一条摘要消息', async () => {
    const context = makeContext({ messages: makeChat(20) });
    const { workspace, compression } = makeCompression(context);
    await workspace.ready();
    await compression.compress();

    const request = {
        chat: [
            { role: 'system', content: '系统提示' },
            ...context.chat.map(message => ({ role: message.is_user ? 'user' : 'assistant', content: message.mes })),
        ],
        dryRun: false,
    };
    const before = request.chat.length;

    compression.applyToPrompt(request);

    assert.equal(request.chat.length, before - 13 + 1);
    assert.equal(request.chat[0].role, 'system', 'system 提示不能被碰');
    const note = request.chat.find(message => String(message.content).includes('[上下文压缩]'));
    assert.ok(note, '要插入摘要消息');
    assert.match(note.content, /chat_history/);
});

test('applyToPrompt：dryRun 时不动', async () => {
    const context = makeContext({ messages: makeChat(20) });
    const { workspace, compression } = makeCompression(context);
    await workspace.ready();
    await compression.compress();

    const request = {
        chat: context.chat.map(message => ({ role: message.is_user ? 'user' : 'assistant', content: message.mes })),
        dryRun: true,
    };
    const before = request.chat.length;
    compression.applyToPrompt(request);
    assert.equal(request.chat.length, before);
});

test('applyToPrompt：消息改过就整体跳过', async () => {
    const context = makeContext({ messages: makeChat(20) });
    const { workspace, compression } = makeCompression(context);
    await workspace.ready();
    await compression.compress();

    const request = {
        chat: context.chat.map(message => ({ role: message.is_user ? 'user' : 'assistant', content: message.mes })),
        dryRun: false,
    };
    request.chat[3].content = '用户手改了这条';
    const before = request.chat.length;

    compression.applyToPrompt(request);
    assert.equal(request.chat.length, before, '对不上就不换');
});

test('maybeCompress：没到阈值不动，超了才压', async () => {
    const small = makeContext({ messages: makeChat(8), maxContext: 100000 });
    const smallCompression = makeCompression(small).compression;
    assert.equal((await smallCompression.maybeCompress()).skipped, 'below-threshold');

    // 每条消息 ~10 字 → 总字符 200，token 估算 100；窗口设 100 → 阈值 50 → 触发
    const big = makeContext({ messages: makeChat(20), maxContext: 100 });
    const bigCompression = makeCompression(big).compression;
    const result = await bigCompression.maybeCompress();
    assert.equal(result.compressed, true);
});

test('compress：关掉 compression 设置后不动', async () => {
    const context = makeContext({ messages: makeChat(20), maxContext: 100 });
    const { compression } = makeCompression(context);
    compression.settings.compression = false;

    const result = await compression.maybeCompress();
    assert.equal(result.skipped, 'disabled');
});

test('compress：在聊天里插入折叠块（system 消息 + extra 元信息）', async () => {
    const context = makeContext({ messages: makeChat(20) });
    const { workspace, compression } = makeCompression(context);
    await workspace.ready();

    await compression.compress({ trigger: 'manual' });

    const chat = context.chat;
    assert.equal(chat.length, 21, '压完要多出一条标记消息');

    const marker = chat[14];
    assert.equal(marker.is_system, true);
    assert.match(marker.mes, /\[上下文压缩\] 13 条对话已压缩/);
    assert.match(marker.mes, /chat_history/);
    assert.equal(marker.extra.at_compression.messages, 13);
    assert.match(marker.extra.at_compression.summary, /当前情境/);
});

test('compress：标记消息不进指纹，二次压缩不会卡住', async () => {
    const context = makeContext({ messages: makeChat(26) });
    const { workspace, compression } = makeCompression(context, { keepLast: 6 });
    await workspace.ready();

    await compression.compress();
    const first = compression.state;
    assert.equal(first.hashes.length, first.messages);

    // 再压一次：新的 range 里包含那条 system 标记，指纹必须把它排除
    await compression.compress();
    const second = compression.state;
    assert.equal(second.messages, second.hashes.length);
    assert.ok(second.hashes.length > 0);
});

test('默认关闭：没勾选不自动压缩，手动 compress 仍可用', async () => {
    const context = makeContext({ messages: makeChat(20), maxContext: 100 });
    const { workspace, compression } = makeCompression(context, { enabled: false });
    await workspace.ready();

    assert.equal(compression.enabled, false);
    assert.equal((await compression.maybeCompress()).skipped, 'disabled');

    // 手动压缩不受开关影响
    const result = await compression.compress({ trigger: 'manual' });
    assert.equal(result.compressed, true);
});

test('阈值 / 尾部条数会被夹到合法范围并持久化', async () => {
    const context = makeContext({ messages: makeChat(10) });
    const { compression } = makeCompression(context);

    assert.equal(compression.setThreshold(5), 0.95);
    assert.equal(context.extensionSettings['atelier'].compressionThreshold, 0.95);

    assert.equal(compression.setThreshold(0), 0.1);
    assert.equal(compression.setKeepLast(999), 40);
    assert.equal(compression.setKeepLast(0), 2);
});

test('removeMarker：删掉摘要消息并清空压缩状态', async () => {
    const context = makeContext({ messages: makeChat(20) });
    /** @type {number[]} */
    const deleted = [];
    context.deleteMessage = async id => {
        deleted.push(id);
        context.chat.splice(id, 1);
    };

    const { workspace, compression } = makeCompression(context);
    await workspace.ready();
    await compression.compress();

    assert.ok(compression.state, '压完应该有状态');
    const markerIndex = context.chat.findIndex(message => message.extra?.at_compression);
    assert.ok(markerIndex > 0, '聊天里应该有压缩标记');

    await compression.removeMarker(markerIndex);

    assert.deepEqual(deleted, [markerIndex]);
    assert.equal(compression.state, null, '状态要清掉，否则下次请求还会替换');
    assert.equal(context.chat.some(message => message.extra?.at_compression), false);
});

test('removeMarker：不是压缩标记就什么都不做', async () => {
    const context = makeContext({ messages: makeChat(4) });
    const deleted = [];
    context.deleteMessage = async id => { deleted.push(id); };

    const { workspace, compression } = makeCompression(context);
    await workspace.ready();

    await compression.removeMarker(1);
    assert.deepEqual(deleted, []);
});
