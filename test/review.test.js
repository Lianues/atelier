import './setup.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { SelfReview, appendUnique, buildReviewPrompt, parseReviewOutput } from '../lib/review.js';
import { Atelier, HISTORY_DIR } from '../lib/workspace.js';

/**
 * @param {{messages?: any[], generate?: (options: any) => Promise<string>}} [options]
 */
function makeContext(options = {}) {
    const metadata = {};
    const context = {
        chat: options.messages ?? [],
        chatMetadata: metadata,
        chatId: 'chat-A',
        getCurrentChatId: () => 'chat-A',
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
        generateQuietPrompt: options.generate ?? (async () => '{"save":[]}'),
    };
    return context;
}

/**
 * @param {any} context
 * @param {Record<string, any>} [options]
 */
function makeReview(context, options = {}) {
    const workspace = new Atelier(context, { storage: null });
    const review = new SelfReview(context, workspace, options);
    // 功能默认关闭，测试里统一打开；要测「默认关」就传 { enabled: false }
    if (options.enabled !== false) review.setEnabled(true);
    return { workspace, review };
}

/**
 * @param {number} count
 */
function makeChat(count) {
    return Array.from({ length: count }, (_, index) => ({
        name: index % 2 === 0 ? 'User' : '角色',
        is_user: index % 2 === 0,
        is_system: false,
        mes: `第 ${index + 1} 条对话`,
    }));
}

test('parseReviewOutput：裸 JSON / 代码块 / 前后废话都能解析', () => {
    assert.deepEqual(parseReviewOutput('{"save":[{"file":"user-pref","text":"喜欢短句"}]}'), [
        { file: 'user-pref', text: '喜欢短句' },
    ]);

    assert.deepEqual(parseReviewOutput('好的：\n```json\n{"save":[{"file":"world","text":"学院在城北"}]}\n```'), [
        { file: 'world', text: '学院在城北' },
    ]);

    assert.deepEqual(parseReviewOutput('说明一下 {"save":[{"file":"style","text":"少用形容词"}]} 完毕'), [
        { file: 'style', text: '少用形容词' },
    ]);
});

test('parseReviewOutput：过滤非法分类 / 空内容 / 太短的', () => {
    const text = JSON.stringify({
        save: [
            { file: 'world_book', text: '不该写到这里' },
            { file: 'user-pref', text: '' },
            { file: 'user-pref', text: '无' },
            { file: 'user-pref', text: 'a' },
            { file: 'user-pref', text: '真的偏好' },
        ],
    });
    assert.deepEqual(parseReviewOutput(text), [{ file: 'user-pref', text: '真的偏好' }]);
});

test('parseReviewOutput：不是 JSON 就返回空数组', () => {
    assert.deepEqual(parseReviewOutput('Nothing to save.'), []);
    assert.deepEqual(parseReviewOutput(''), []);
    assert.deepEqual(parseReviewOutput('{"save": "oops"}'), []);
});

test('appendUnique：重复的跳过，新的追加', () => {
    const base = '# 用户偏好\n\n- 喜欢短句\n';
    assert.equal(appendUnique(base, '喜欢短句！').added, false);
    assert.equal(appendUnique(base, '不喜欢 emoji').added, true);
    assert.match(appendUnique(base, '不喜欢 emoji').content, /- 不喜欢 emoji\n$/);
});

test('buildReviewPrompt：带上已有记忆和四类说明', () => {
    const prompt = buildReviewPrompt('对话内容', { 'user-pref': '- 喜欢短句' });
    assert.match(prompt, /user-pref/);
    assert.match(prompt, /已有记忆/);
    assert.match(prompt, /喜欢短句/);
    assert.match(prompt, /只返回 JSON/);
});

test('run：解析结果写进 /记忆，并记一行日志', async () => {
    const context = makeContext({
        messages: makeChat(6),
        generate: async () => JSON.stringify({
            save: [
                { file: 'user-pref', text: '称呼用「你」' },
                { file: 'world', text: '学院在城北' },
            ],
        }),
    });
    const { workspace, review } = makeReview(context);
    await workspace.ready();

    const result = await review.run({ trigger: 'manual' });
    assert.equal(result.saved, 2);

    const pref = workspace.fs.read('/记忆/用户偏好.md');
    assert.match(pref, /称呼用「你」/);
    assert.match(workspace.fs.read('/记忆/世界设定.md'), /学院在城北/);
    assert.match(workspace.fs.read('/记忆/回顾记录.md'), /新增 2 条/);
});

test('run：写进 /world_book 的请求会被丢弃', async () => {
    const context = makeContext({
        messages: makeChat(4),
        generate: async () => '{"save":[{"file":"world","text":"学院在城北"},{"file":"todo","text":"待确认的事"}]}',
    });
    const { workspace, review } = makeReview(context);
    await workspace.ready();

    await review.run({ trigger: 'manual' });

    assert.equal(workspace.fs.exists('/world_book'), false, '回顾永远不碰世界书');
    assert.match(workspace.fs.read('/记忆/待确认.md'), /待确认的事/);
});

test('run：重复跑不会写重复条目', async () => {
    const context = makeContext({
        messages: makeChat(4),
        generate: async () => '{"save":[{"file":"user-pref","text":"称呼用「你」"}]}',
    });
    const { workspace, review } = makeReview(context);
    await workspace.ready();

    await review.run({ trigger: 'manual' });
    const second = await review.run({ trigger: 'manual' });

    assert.equal(second.saved, 0);
    const lines = workspace.fs.read('/记忆/用户偏好.md').split('\n').filter(line => line.startsWith('- '));
    assert.equal(lines.length, 1);
});

test('onTurn：攒够 interval 个用户轮才跑，跑完清零', async () => {
    let calls = 0;
    const context = makeContext({
        messages: makeChat(6),
        generate: async () => {
            calls += 1;
            return '{"save":[{"file":"style","text":"多用短段落"}]}';
        },
    });
    const { workspace, review } = makeReview(context, { interval: 3 });
    await workspace.ready();
    review.state.lastUserCount = review.userMessageCount();

    const say = () => context.chat.push({ name: 'User', is_user: true, is_system: false, mes: '用户又说话了' });

    say();
    await review.onTurn();
    say();
    await review.onTurn();
    assert.equal(calls, 0, '不到 3 轮不跑');

    say();
    await review.onTurn();
    assert.equal(calls, 1, '第 3 个用户轮跑一次');

    say();
    await review.onTurn();
    assert.equal(calls, 1, '计数已清零，第 4 轮不跑');
    assert.equal(review.state.turns, 1);
});

test('onTurn：工具重入不增加用户轮（GENERATION_ENDED 会重复触发）', async () => {
    let calls = 0;
    const context = makeContext({
        messages: makeChat(6),
        generate: async () => {
            calls += 1;
            return '{"save":[]}';
        },
    });
    const { workspace, review } = makeReview(context, { interval: 2 });
    await workspace.ready();
    review.state.lastUserCount = review.userMessageCount();

    // 一条用户消息 + 之后 3 轮工具重入，全都触发 GENERATION_ENDED
    context.chat.push({ name: 'User', is_user: true, is_system: false, mes: '用户消息' });
    await review.onTurn();
    assert.equal(review.state.turns, 1);

    await review.onTurn();
    await review.onTurn();
    assert.equal(review.state.turns, 1, '用户消息没变，不该继续加');
    assert.equal(calls, 0);
});

test('onTurn：删过消息会重新对齐基线', async () => {
    const context = makeContext({ messages: makeChat(6) });
    const { workspace, review } = makeReview(context, { interval: 5 });
    await workspace.ready();
    review.state.lastUserCount = review.userMessageCount();

    // 删掉一条用户消息
    const index = context.chat.findIndex(message => message.is_user);
    context.chat.splice(index, 1);
    await review.onTurn();
    assert.equal(review.state.turns, 0, '变少只对齐，不计数');
    assert.equal(review.state.lastUserCount, review.userMessageCount());

    context.chat.push({ name: 'User', is_user: true, is_system: false, mes: '新消息' });
    await review.onTurn();
    assert.equal(review.state.turns, 1);
});

test('onTurn：关掉回顾就不再自动跑', async () => {
    let calls = 0;
    const context = makeContext({
        messages: makeChat(6),
        generate: async () => {
            calls += 1;
            return '{"save":[]}';
        },
    });
    const { workspace, review } = makeReview(context, { interval: 1 });
    await workspace.ready();
    review.setEnabled(false);

    context.chat.push({ name: 'User', is_user: true, is_system: false, mes: '新消息' });
    await review.onTurn();
    assert.equal(calls, 0);
});

test('replaces：命中旧条目就原地改写，不新增行', () => {
    const base = '# 用户偏好\n\n- 喜欢长句\n- 称呼用「你」\n';
    const { content, added } = appendUnique(base, '喜欢短句', '喜欢长句');
    assert.equal(added, true);

    const bullets = content.split('\n').filter(line => line.startsWith('- '));
    assert.deepEqual(bullets, ['- 喜欢短句', '- 称呼用「你」']);
});

test('replaces：匹配不到就退回追加', () => {
    const base = '# 用户偏好\n\n- 称呼用「你」\n';
    const { content } = appendUnique(base, '喜欢短句', '根本没有这条');
    assert.match(content, /- 喜欢短句/);
});

test('parseReviewOutput：解析 replaces 字段', () => {
    const text = '{"save":[{"file":"style","text":"新写法","replaces":"旧写法"}]}';
    assert.deepEqual(parseReviewOutput(text), [{ file: 'style', text: '新写法', replaces: '旧写法' }]);
});

test('双计数器：工具调用攒够也触发回顾', async () => {
    let calls = 0;
    const context = makeContext({
        messages: makeChat(6),
        generate: async () => {
            calls += 1;
            return '{"save":[]}';
        },
    });
    const { workspace, review } = makeReview(context, { toolInterval: 3 });
    await workspace.ready();
    review.install();

    review.onWorkspaceChange('tool-write', { path: '/demo/a.txt' });
    review.onWorkspaceChange('js-write', { path: '/demo/b.txt' });
    assert.equal(calls, 0);

    review.onWorkspaceChange('tool-edit', { path: '/demo/c.txt' });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls, 1, '第 3 次工具调用触发回顾');
});

test('自写 /记忆 会清零两个计数器', async () => {
    const context = makeContext({ messages: makeChat(4) });
    const { workspace, review } = makeReview(context, { toolInterval: 2 });
    await workspace.ready();

    const state = review.state;
    state.turns = 5;
    state.iters = 1;

    review.onWorkspaceChange('tool-write', { path: '/记忆/用户偏好.md' });

    assert.equal(state.turns, 0);
    assert.equal(state.iters, 0);
});

test('提示词注入：install 时写入，destroy 时清空', async () => {
    const context = makeContext({ messages: makeChat(2) });
    const calls = [];
    context.setExtensionPrompt = (...args) => calls.push(args);

    const { workspace, review } = makeReview(context);
    await workspace.ready();

    calls.length = 0; // setEnabled 也会刷一次提示词，这里只测 install
    review.install();
    assert.equal(calls.length, 1);
    assert.match(calls[0][1], /\/记忆\//);

    review.destroy();
    assert.equal(calls.at(-1)[1], '');
});

/**
 * 带事件总线的 context：记录 handler，可手动 emit。
 * @param {Record<string, any>} options
 */
function makeEventedContext(options = {}) {
    const context = makeContext(options);
    /** @type {Record<string, Function[]>} */
    const handlers = {};
    context.eventTypes = {
        GENERATION_ENDED: 'generation_ended',
        TOOL_CALLS_PERFORMED: 'tool_calls_performed',
        CHAT_CHANGED: 'chat_changed',
    };
    context.eventSource = {
        on: (type, handler) => {
            (handlers[type] ??= []).push(handler);
        },
    };
    context.emit = (type, ...args) => {
        for (const handler of handlers[type] ?? []) handler(...args);
    };
    return context;
}

test('工具轮：TOOL_CALLS_PERFORMED 一轮 +1，不管里面几个并行调用', async () => {
    let calls = 0;
    const context = makeEventedContext({
        messages: makeChat(6),
        generate: async () => {
            calls += 1;
            return '{"save":[]}';
        },
    });
    const { workspace, review } = makeReview(context, { toolInterval: 3 });
    await workspace.ready();
    review.install();

    // 同一轮里 4 个并行调用
    context.emit('tool_calls_performed', [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }]);
    assert.equal(review.state.iters, 1, '一轮只算 1，不是 4');

    context.emit('tool_calls_performed', [{ name: 'e' }]);
    context.emit('tool_calls_performed', [{ name: 'f' }]);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls, 1, '第 3 轮触发回顾');
});

test('工具轮：没有 TOOL_CALLS_PERFORMED 时退化成按调用计', async () => {
    const context = makeContext({ messages: makeChat(4) });
    const { workspace, review } = makeReview(context, { toolInterval: 5 });
    await workspace.ready();
    review.install(); // eventTypes 是空的

    review.onWorkspaceChange('tool-write', { path: '/demo/a.txt' });
    review.onWorkspaceChange('js-write', { path: '/demo/b.txt' });
    assert.equal(review.state.iters, 2);
});

test('切聊天：重新对齐用户消息基线', async () => {
    const context = makeEventedContext({ messages: makeChat(6) });
    const { workspace, review } = makeReview(context, { interval: 2 });
    await workspace.ready();
    review.install();

    context.chat.push({ name: 'User', is_user: true, is_system: false, mes: '新聊天的历史' });
    context.emit('chat_changed');

    assert.equal(review.state.lastUserCount, review.userMessageCount());
    assert.equal(review.state.turns, 0);
});

test('默认关闭：没勾选不自动回顾，手动 run 仍可用', async () => {
    let calls = 0;
    const context = makeContext({
        messages: makeChat(6),
        generate: async () => {
            calls += 1;
            return '{"save":[]}';
        },
    });
    const { workspace, review } = makeReview(context, { enabled: false, interval: 1 });
    await workspace.ready();
    review.state.lastUserCount = review.userMessageCount();

    context.chat.push({ name: 'User', is_user: true, is_system: false, mes: '新消息' });
    await review.onTurn();
    assert.equal(calls, 0, '没勾选就不该自动跑');

    const manual = await review.run({ trigger: 'manual' });
    assert.equal(manual.skipped, undefined);
    assert.equal(calls, 1, '手动回顾照常工作');
});

test('阈值会夹到 2–200 并持久化', async () => {
    const context = makeContext({ messages: makeChat(4) });
    const { review } = makeReview(context);

    assert.equal(review.setInterval(1), 10);
    assert.equal(review.setInterval(999), 200);
    assert.equal(context.extensionSettings['atelier'].reviewTurns, 200);
    assert.equal(review.setToolInterval(0), 10);
});

test('run：有新增时在聊天末尾插一条总结提示', async () => {
    const context = makeContext({
        messages: makeChat(4),
        generate: async () => '{"save":[{"file":"user-pref","text":"称呼用「你」"}]}',
    });
    const { workspace, review } = makeReview(context);
    await workspace.ready();

    await review.run({ trigger: 'manual' });

    const marker = context.chat.at(-1);
    assert.equal(marker.is_system, true);
    assert.match(marker.mes, /\[自我总结\] 新增 1 条/);
    assert.equal(marker.extra.at_review.saved, 1);
    assert.equal(marker.extra.at_review.items[0].file, 'user-pref');
});

test('run：没有新增就不插提示', async () => {
    const context = makeContext({ messages: makeChat(4), generate: async () => '{"save":[]}' });
    const { workspace, review } = makeReview(context);
    await workspace.ready();

    const before = context.chat.length;
    await review.run({ trigger: 'manual' });
    assert.equal(context.chat.length, before);
});

test('removeMarker：只删提示，/记忆 文件一个字都不动', async () => {
    const context = makeContext({
        messages: makeChat(4),
        generate: async () => '{"save":[{"file":"style","text":"多用短段落"}]}',
    });
    /** @type {number[]} */
    const deleted = [];
    context.deleteMessage = async id => {
        deleted.push(id);
        context.chat.splice(id, 1);
    };

    const { workspace, review } = makeReview(context);
    await workspace.ready();
    await review.run({ trigger: 'manual' });

    const before = workspace.fs.read('/记忆/文风.md');
    const index = context.chat.findIndex(message => message.extra?.at_review);
    assert.ok(index >= 0, '应该有总结提示');

    await review.removeMarker(index);

    assert.deepEqual(deleted, [index]);
    assert.equal(context.chat.some(message => message.extra?.at_review), false);
    assert.equal(workspace.fs.read('/记忆/文风.md'), before, '记忆文件不能被删');
});

test('removeMarker：不是总结提示就什么都不做', async () => {
    const context = makeContext({ messages: makeChat(4) });
    const deleted = [];
    context.deleteMessage = async id => { deleted.push(id); };

    const { workspace, review } = makeReview(context);
    await workspace.ready();

    await review.removeMarker(1);
    assert.deepEqual(deleted, []);
});

test('归档：按「楼层-分支.md」存原文到 /chat_history', async () => {
    const messages = [
        { name: 'User', is_user: true, mes: '第一句', send_date: 1700000000000, swipe_id: 0 },
        { name: '角色', is_user: false, mes: '第二句', send_date: 1700000001000, swipe_id: 0 },
        { name: '角色', is_user: false, mes: '第三句·分支二', send_date: 1700000002000, swipe_id: 1 },
    ];
    const context = makeContext({ messages, generate: async () => '{"save":[]}' });
    const { workspace, review } = makeReview(context);
    await workspace.ready();

    const result = await review.run({ trigger: 'manual' });
    assert.equal(result.archived, 3);

    assert.equal(workspace.fs.read(`${HISTORY_DIR}/1-1.md`).includes('第一句'), true);
    assert.equal(workspace.fs.read(`${HISTORY_DIR}/2-1.md`).includes('第二句'), true);
    assert.equal(workspace.fs.read(`${HISTORY_DIR}/3-2.md`).includes('第三句·分支二'), true);

    const head = workspace.fs.read(`${HISTORY_DIR}/3-2.md`).split('\n').slice(0, 3).join('\n');
    assert.match(head, /# 楼层 3 · 分支 2/);
});

test('归档：工具消息也存成 md，正文是参数和结果', async () => {
    const messages = [
        { name: 'User', is_user: true, mes: '看看文件' },
        {
            name: 'System',
            is_system: true,
            is_user: false,
            mes: '<details>tool</details>',
            extra: { tool_invocations: [{ name: 'read', parameters: '{"path":"/a.md"}', result: '正文A' }] },
        },
        { name: '角色', is_user: false, mes: '看完了' },
    ];
    const context = makeContext({ messages, generate: async () => '{"save":[]}' });
    const { workspace, review } = makeReview(context);
    await workspace.ready();

    await review.run({ trigger: 'manual' });

    const text = workspace.fs.read(`${HISTORY_DIR}/2-1.md`);
    assert.match(text, /- 角色：工具/);
    assert.match(text, /"name": "read"/);
    assert.match(text, /"path": "\/a\.md"/);
    assert.match(text, /正文A/);
});

test('归档：压缩摘要和回顾提示本身不归档，重复跑不重写', async () => {
    const messages = [
        { name: 'User', is_user: true, mes: '第一句' },
        { name: 'System', is_system: true, is_user: false, mes: '[上下文压缩]', extra: { cw_compression: { saved: 3 } } },
        { name: '角色', is_user: false, mes: '第二句' },
    ];
    const context = makeContext({ messages, generate: async () => '{"save":[]}' });
    const { workspace, review } = makeReview(context);
    await workspace.ready();

    const first = await review.run({ trigger: 'manual' });
    assert.equal(first.archived, 2);
    assert.equal(workspace.fs.exists(`${HISTORY_DIR}/2-1.md`), false);

    // 内容没变，第二次不再写
    const second = await review.run({ trigger: 'manual' });
    assert.equal(second.archived, 0);
});

test('联动：删楼时归档跟着删，后面的楼层往前挪', async () => {
    const messages = [
        { name: 'User', is_user: true, mes: '第一句', send_date: 1 },
        { name: '角色', is_user: false, mes: '第二句', send_date: 2 },
        { name: '角色', is_user: false, mes: '第三句', send_date: 3 },
    ];
    const context = makeContext({ messages, generate: async () => '{"save":[]}' });
    const { workspace, review } = makeReview(context);
    await workspace.ready();
    await review.run({ trigger: 'manual' });

    assert.equal(workspace.fs.exists(`${HISTORY_DIR}/2-1.md`), true);
    assert.equal(workspace.fs.exists(`${HISTORY_DIR}/3-1.md`), true);

    context.chat.splice(1, 1); // 删掉第 2 层
    await review.onMessagesDeleted();

    assert.equal(workspace.fs.exists(`${HISTORY_DIR}/3-1.md`), false, '旧的第 3 层文件要挪走');
    assert.match(workspace.fs.read(`${HISTORY_DIR}/2-1.md`), /第三句/);
});

test('联动：改某个楼层后，归档内容跟着刷新', async () => {
    const messages = [
        { name: 'User', is_user: true, mes: '第一句', send_date: 1 },
        { name: '角色', is_user: false, mes: '旧内容', send_date: 2 },
    ];
    const context = makeContext({ messages, generate: async () => '{"save":[]}' });
    const { workspace, review } = makeReview(context);
    await workspace.ready();
    await review.run({ trigger: 'manual' });

    context.chat[1].mes = '新内容';
    await review.refreshArchive(1);

    assert.match(workspace.fs.read(`${HISTORY_DIR}/2-1.md`), /新内容/);
    assert.equal(workspace.fs.read(`${HISTORY_DIR}/2-1.md`).includes('旧内容'), false);
});

test('联动：删工具消息时它的归档也删掉', async () => {
    const messages = [
        { name: 'User', is_user: true, mes: '看看', send_date: 1 },
        { name: 'System', is_system: true, mes: 'tool', extra: { tool_invocations: [{ id: 'c1', name: 'read', parameters: '{}', result: 'x' }] } },
        { name: '角色', is_user: false, mes: '看完了', send_date: 3 },
    ];
    const context = makeContext({ messages, generate: async () => '{"save":[]}' });
    const { workspace, review } = makeReview(context);
    await workspace.ready();
    await review.run({ trigger: 'manual' });

    assert.equal(workspace.fs.exists(`${HISTORY_DIR}/2-1.md`), true);

    context.chat.splice(1, 1);
    await review.onMessagesDeleted();

    assert.equal(workspace.fs.exists(`${HISTORY_DIR}/3-1.md`), false, '工具消息的文件被删掉，后面的挪上来');
    assert.match(workspace.fs.read(`${HISTORY_DIR}/2-1.md`), /看完了/);
});

test('联动：删掉某个分支时只删那一份归档', async () => {
    const messages = [
        { name: 'User', is_user: true, mes: '第一句', send_date: 1 },
        { name: '角色', is_user: false, mes: '第二分支内容', send_date: 2, swipe_id: 1 },
    ];
    const context = makeContext({ messages, generate: async () => '{"save":[]}' });
    const { workspace, review } = makeReview(context);
    await workspace.ready();
    await review.run({ trigger: 'manual' });

    assert.equal(workspace.fs.exists(`${HISTORY_DIR}/2-2.md`), true);

    await review.onSwipeDeleted({ messageId: 1, swipeId: 1 });

    assert.equal(workspace.fs.exists(`${HISTORY_DIR}/2-2.md`), false);
});

test('联动：压缩和回顾共用一份归档，删楼时一起移位', async () => {
    const messages = [
        { name: 'User', is_user: true, mes: '第一句', send_date: 1 },
        { name: '角色', is_user: false, mes: '第二句', send_date: 2 },
        { name: '角色', is_user: false, mes: '第三句', send_date: 3 },
    ];
    const context = makeContext({ messages, generate: async () => '{"save":[]}' });
    const { workspace, review } = makeReview(context);
    await workspace.ready();
    await review.run({ trigger: 'manual' });

    // 压缩器写的是同一个路径（楼层-分支），只是内容一样，不产生第二份
    workspace.fs.write(`${HISTORY_DIR}/3-1.md`, workspace.fs.read(`${HISTORY_DIR}/3-1.md`));
    assert.deepEqual(workspace.fs.list(HISTORY_DIR).map(item => item.name), ['1-1.md', '2-1.md', '3-1.md']);

    context.chat.splice(1, 1);
    await review.onMessagesDeleted();

    assert.equal(workspace.fs.exists(`${HISTORY_DIR}/3-1.md`), false);
    assert.match(workspace.fs.read(`${HISTORY_DIR}/2-1.md`), /第三句/);
});
