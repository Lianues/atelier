/**
 * 暴露给模型的三个文件工具：read / write / edit。
 *
 * 说明：
 *  - 工具描述用英文写好（模型对英文工具描述的遵循度更稳），行为与工作区 UI 完全一致；
 *  - 所有路径都是工作区内的绝对路径（`/world_book/...`），与真实磁盘无关；
 *  - 直接调用 handlers 可以在没有 SillyTavern 的环境里做单测。
 */

import { normalizePath } from './vfs.js';

export const READ_TOOL = 'read';
export const WRITE_TOOL = 'write';
export const EDIT_TOOL = 'edit';
export const TOOL_NAMES = [READ_TOOL, WRITE_TOOL, EDIT_TOOL];

const MAX_READ_CHARS = 60_000;

const READ_DESCRIPTION = [
    'Read a file from the Atelier workspace (a virtual, chat-scoped filesystem).',
    'Layout: /world_book/<book name>/entries/<uid>_<title>.yaml (entry config) and .md (entry body), plus /chat_history/ (reserved).',
    'Text is read as UTF-8. startLine/endLine are 1-based and inclusive; omit both to read the whole file.',
    'Passing a directory path returns a directory listing instead of file content.',
].join(' ');

const WRITE_DESCRIPTION = [
    'Write a UTF-8 text file in the Atelier workspace.',
    'Creates parent directories automatically when the file does not exist.',
    'Returns "Unchanged ..." without touching the file when the content is identical to what is already there.',
    'Use edit for targeted replacements; use write when you intentionally provide the complete file content.',
].join(' ');

const EDIT_DESCRIPTION = [
    'Modify one UTF-8 text file in the Atelier workspace using hunk-style search/replace.',
    'Arguments: { path, hunks }. hunks is an ordered array; each hunk is { oldContent, newContent, replaceAll? }.',
    'Each oldContent must match byte-for-byte and must be unique in the file unless replaceAll is true; hunks are applied in order.',
    'Include a few surrounding lines in oldContent to make it unique.',
].join(' ');

const READ_PARAMETERS = {
    type: 'object',
    properties: {
        path: {
            type: 'string',
            description: 'Absolute workspace path, e.g. /world_book/MyBook/entries/0_intro.md',
        },
        startLine: {
            type: 'integer',
            description: 'Optional 1-based first line to return (inclusive). Omit to start from the beginning.',
        },
        endLine: {
            type: 'integer',
            description: 'Optional 1-based last line to return (inclusive). Omit to read to the end.',
        },
    },
    required: ['path'],
};

const WRITE_PARAMETERS = {
    type: 'object',
    properties: {
        path: {
            type: 'string',
            description: 'Absolute workspace path to create or overwrite.',
        },
        content: {
            type: 'string',
            description: 'Complete UTF-8 file content.',
        },
    },
    required: ['path', 'content'],
};

const EDIT_PARAMETERS = {
    type: 'object',
    properties: {
        path: {
            type: 'string',
            description: 'Absolute workspace path of the file to edit.',
        },
        hunks: {
            type: 'array',
            description: 'Ordered list of hunk edits. Use one hunk for a single replacement.',
            items: {
                type: 'object',
                properties: {
                    oldContent: {
                        type: 'string',
                        description: 'Exact existing text. Must match byte-for-byte and be unique unless replaceAll is true.',
                    },
                    newContent: {
                        type: 'string',
                        description: 'Replacement text (may be empty to delete the matched text).',
                    },
                    replaceAll: {
                        type: 'boolean',
                        description: 'Replace every occurrence of oldContent instead of requiring uniqueness.',
                    },
                },
                required: ['oldContent', 'newContent'],
            },
        },
    },
    required: ['path', 'hunks'],
};

/**
 * @param {import('./workspace.js').Atelier} workspace
 * @returns {{read: Function, write: Function, edit: Function}}
 */
export function createToolHandlers(workspace) {
    /**
     * @param {{path: string, startLine?: number, endLine?: number}} args
     * @returns {Promise<string>}
     */
    async function read(args) {
        await workspace.ensure();
        const fs = workspace.fs;
        const target = normalizePath(args?.path);

        if (fs.isDir(target)) {
            return fs.listText(target);
        }

        const text = fs.read(target);
        const lines = text.split('\n');

        const start = positiveInt(args?.startLine);
        const end = positiveInt(args?.endLine);

        if (start === undefined && end === undefined) {
            return clip(text);
        }

        const from = start ?? 1;
        const to = Math.min(end ?? lines.length, lines.length);
        const slice = from > to ? [] : lines.slice(from - 1, to);

        const last = slice.length ? from + slice.length - 1 : from - 1;
        const header = `# ${target} lines ${from}-${last} of ${lines.length}`;
        return `${header}\n${clip(slice.join('\n'))}`;
    }

    /**
     * @param {{path: string, content: string}} args
     * @returns {Promise<string>}
     */
    async function write(args) {
        await workspace.ensure();
        const target = normalizePath(args?.path);
        const fs = workspace.fs;

        if (fs.isDir(target)) {
            throw new Error(`${target} 是目录，不能写入`);
        }
        if (typeof args?.content !== 'string') {
            throw new Error('content 必须是字符串');
        }

        const lines = args.content === '' ? 0 : args.content.split('\n').length;

        // 内容一模一样就不动文件：省一次落盘，也让「自动写回世界书」少跑一趟
        if (fs.exists(target) && !fs.isDir(target) && fs.read(target) === args.content) {
            return `Unchanged ${target} (${fs.stat(target).size} bytes, ${lines} lines)`;
        }

        const result = fs.write(target, args.content);
        workspace.touch('tool-write', { path: target });
        await workspace.flush();

        return `${result.created ? 'Created' : 'Updated'} ${target} (${result.bytes} bytes, ${lines} lines)`;
    }

    /**
     * hunks: [{ oldContent, newContent, replaceAll? }]，按顺序应用。
     *
     * @param {{path: string, hunks: any[]}} args
     * @returns {Promise<string>}
     */
    async function edit(args) {
        await workspace.ensure();
        const target = normalizePath(args?.path);
        const fs = workspace.fs;

        const hunks = normalizeHunks(args);
        if (!hunks.length) {
            throw new Error('没有要改的内容：hunks 不能为空。');
        }
        if (hunks.length === 1 && hunks[0].oldContent === hunks[0].newContent) {
            throw new Error('oldContent 与 newContent 相同，没有改动');
        }

        let text = fs.read(target);
        let replaced = 0;

        for (const [index, hunk] of hunks.entries()) {
            const label = hunks.length > 1 ? `第 ${index + 1} 个 hunk：` : '';
            const occurrences = countOccurrences(text, hunk.oldContent);

            if (occurrences === 0) {
                throw new Error(`${label}在 ${target} 中找不到 oldContent。请先 read 确认原文（注意空格与换行）。`);
            }
            if (occurrences > 1 && !hunk.replaceAll) {
                throw new Error(`${label}oldContent 在 ${target} 中出现 ${occurrences} 次。请补充上下文使其唯一，或设置 replaceAll: true。`);
            }

            const useAll = hunk.replaceAll || occurrences === 1;
            text = useAll
                ? text.split(hunk.oldContent).join(hunk.newContent)
                : text.slice(0, text.indexOf(hunk.oldContent)) + hunk.newContent + text.slice(text.indexOf(hunk.oldContent) + hunk.oldContent.length);
            replaced += useAll ? occurrences : 1;
        }

        const result = fs.write(target, text);
        workspace.touch('tool-edit', { path: target });
        await workspace.flush();

        const scope = hunks.length > 1 ? `${hunks.length} hunk(s), ` : '';
        return `Edited ${target}: ${scope}replaced ${replaced} occurrence(s), now ${result.bytes} bytes`;
    }

    return { read, write, edit };
}

/**
 * @param {any} args
 * @returns {{oldContent: string, newContent: string, replaceAll: boolean}[]}
 */
function normalizeHunks(args) {
    if (!Array.isArray(args?.hunks) || !args.hunks.length) {
        return [];
    }

    return args.hunks.map((hunk, index) => {
        const oldContent = hunk?.oldContent;
        const newContent = hunk?.newContent;
        if (typeof oldContent !== 'string' || oldContent === '') {
            throw new Error(`第 ${index + 1} 个 hunk 的 oldContent 必须是非空字符串`);
        }
        if (typeof newContent !== 'string') {
            throw new Error(`第 ${index + 1} 个 hunk 的 newContent 必须是字符串`);
        }
        return { oldContent, newContent, replaceAll: hunk?.replaceAll === true };
    });
}

/**
 * @param {any} value
 * @returns {number|undefined}
 */
function positiveInt(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return undefined;
    const int = Math.trunc(number);
    return int > 0 ? int : undefined;
}

/**
 * 诊断「为什么模型看不到工具」。
 *
 * 对应 SillyTavern 的 ToolManager.isToolCallingSupported() 的几道关卡，
 * 但把原因翻译成人话，UI 和 /workspace diagnose 都用它。
 *
 * @param {any} context getContext()
 * @returns {{ok: boolean, reason: string, fixable: boolean, message: string}}
 */
export function describeToolCalling(context) {
    const settings = context?.chatCompletionSettings ?? {};
    const supported = Boolean(context?.isToolCallingSupported?.());

    if (supported) {
        return { ok: true, reason: 'ok', fixable: false, message: '函数调用已启用，工具会随请求一起发送。' };
    }

    const mainApi = String(context?.mainApi ?? 'openai');
    if (mainApi !== 'openai') {
        return {
            ok: false,
            reason: 'api',
            fixable: false,
            message: '当前用的是「文本补全」接口。read/write/edit 是函数工具，只有 Chat Completion 才能带上。',
        };
    }

    if (!settings.function_calling) {
        return {
            ok: false,
            reason: 'toggle',
            fixable: true,
            message: '没有勾选「启用函数调用」。它是独立开关（AI Response Configuration → 启用函数调用），跟本插件是否启用无关；而且它跟着 Chat Completion 预设走，切预设会把它关掉。',
        };
    }

    const postProcessing = String(settings.custom_prompt_post_processing ?? '');
    const allowed = ['', 'none', 'merge_tools', 'semi_tools', 'strict_tools'];
    if (!allowed.includes(postProcessing)) {
        return {
            ok: false,
            reason: 'post-processing',
            fixable: false,
            message: `Prompt Post-Processing 是 "${postProcessing}"，这个模式会删掉历史里的工具调用。改成 none / merge_tools / semi_tools / strict_tools 之一。`,
        };
    }

    const model = String(context?.getChatCompletionModel?.(settings) ?? '');
    if (/^gpt-6-astra/.test(model)) {
        return {
            ok: false,
            reason: 'model',
            fixable: false,
            message: '该模型只通过 Responses API 支持工具调用，Chat Completion 下不可用。',
        };
    }

    return {
        ok: false,
        reason: 'unsupported',
        fixable: false,
        message: '当前接口 / 模型不支持函数调用（例如 Gemini 的 Gemma 3、图像模型）。',
    };
}

/**
 * 注册到 SillyTavern 的 ToolManager。
 * @param {any} context getContext() 的返回值
 * @param {import('./workspace.js').Atelier} workspace
 * @returns {void}
 */
export function registerWorkspaceTools(context, workspace) {
    const handlers = createToolHandlers(workspace);
    const shouldRegister = () => workspace.isBound();

    context.registerFunctionTool({
        name: READ_TOOL,
        displayName: 'Read workspace file',
        description: READ_DESCRIPTION,
        parameters: READ_PARAMETERS,
        action: handlers.read,
        shouldRegister,
    });

    context.registerFunctionTool({
        name: WRITE_TOOL,
        displayName: 'Write workspace file',
        description: WRITE_DESCRIPTION,
        parameters: WRITE_PARAMETERS,
        action: handlers.write,
        shouldRegister,
    });

    context.registerFunctionTool({
        name: EDIT_TOOL,
        displayName: 'Edit workspace file',
        description: EDIT_DESCRIPTION,
        parameters: EDIT_PARAMETERS,
        action: handlers.edit,
        shouldRegister,
    });
}

/**
 * @param {any} context
 * @returns {void}
 */
export function unregisterWorkspaceTools(context) {
    for (const name of TOOL_NAMES) {
        try {
            context.unregisterFunctionTool(name);
        } catch (error) {
            console.warn(`[atelier] 注销工具 ${name} 失败`, error);
        }
    }
}

/**
 * @param {string} text
 * @param {string} needle
 * @returns {number}
 */
export function countOccurrences(text, needle) {
    if (!needle) return 0;
    let count = 0;
    let index = text.indexOf(needle);
    while (index !== -1) {
        count += 1;
        index = text.indexOf(needle, index + needle.length);
    }
    return count;
}

/**
 * @param {string} text
 * @returns {string}
 */
function clip(text) {
    if (text.length <= MAX_READ_CHARS) return text;
    return `${text.slice(0, MAX_READ_CHARS)}\n\n[已截断：文件共 ${text.length} 字符，超过单次读取上限 ${MAX_READ_CHARS}。请用 offset/limit 分段读取。]`;
}
