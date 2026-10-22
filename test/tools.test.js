import test from 'node:test';
import assert from 'node:assert/strict';
import { describeToolCalling, TOOL_NAMES } from '../lib/tools.js';

/**
 * @param {Record<string, any>} overrides
 */
function makeContext(overrides = {}) {
    return {
        mainApi: 'openai',
        chatCompletionSettings: { function_calling: true, custom_prompt_post_processing: '' },
        isToolCallingSupported: () => true,
        getChatCompletionModel: () => 'deepseek-chat',
        ...overrides,
    };
}

test('工具名固定为 read / write / edit / grep', () => {
    assert.deepEqual(TOOL_NAMES, ['read', 'write', 'edit', 'grep']);
});

test('describeToolCalling：已启用', () => {
    const status = describeToolCalling(makeContext());
    assert.equal(status.ok, true);
    assert.equal(status.reason, 'ok');
});

test('describeToolCalling：没勾「启用函数调用」', () => {
    const status = describeToolCalling(makeContext({
        isToolCallingSupported: () => false,
        chatCompletionSettings: { function_calling: false, custom_prompt_post_processing: 'strict_tools' },
    }));
    assert.equal(status.ok, false);
    assert.equal(status.reason, 'toggle');
    assert.equal(status.fixable, true);
    assert.match(status.message, /启用函数调用/);
});

test('describeToolCalling：文本补全接口', () => {
    const status = describeToolCalling(makeContext({ mainApi: 'textgenerationwebui', isToolCallingSupported: () => false }));
    assert.equal(status.reason, 'api');
    assert.equal(status.fixable, false);
});

test('describeToolCalling：Post-Processing 会删工具', () => {
    const status = describeToolCalling(makeContext({
        isToolCallingSupported: () => false,
        chatCompletionSettings: { function_calling: true, custom_prompt_post_processing: 'merge' },
    }));
    assert.equal(status.reason, 'post-processing');
    assert.match(status.message, /merge/);
});

test('describeToolCalling：gpt-6-astra 只能走 Responses API', () => {
    const status = describeToolCalling(makeContext({
        isToolCallingSupported: () => false,
        getChatCompletionModel: () => 'gpt-6-astra-mini',
    }));
    assert.equal(status.reason, 'model');
});

test('describeToolCalling：其余情况兜底', () => {
    const status = describeToolCalling(makeContext({ isToolCallingSupported: () => false }));
    assert.equal(status.reason, 'unsupported');
    assert.equal(status.ok, false);
});

test('describeToolCalling：缺字段不崩', () => {
    const status = describeToolCalling({ isToolCallingSupported: () => false });
    assert.equal(status.ok, false);
    assert.equal(typeof status.message, 'string');
});
