/**
 * `js` 工具：在酒馆页面里执行一小段 JavaScript。
 *
 * 定位：**真实的页面上下文**（不是沙箱）——document / window / jQuery / SillyTavern 都能碰，
 * 同时给一个 `at` 句柄用来读写当前聊天的虚拟工作区。
 *
 *   at.files(prefix?)      列出工作区文件
 *   at.read(path)          读
 *   at.write(path, c)      写
 *   at.move(from, to)      移动 / 重命名
 *   at.remove(path)        删除
 *   at.parseYaml(text)     解析条目配置
 *
 *   st                     SillyTavern.getContext()（chat / characters / eventSource …）
 *   console                输出会被捕获，随工具结果一起回传
 *
 * 执行在主线程（SillyTavern 关闭了 CSP，可以用 AsyncFunction）。
 * 同步死循环无法中断，所以限制代码长度，并对异步代码加超时。
 */

import { parseYaml } from './yaml.js';

const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;

const MAX_CODE_LENGTH = 20_000;
const MAX_OUTPUT_CHARS = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 15_000;

export const JS_TOOL = 'js';
export const JS_TOOL_NAMES = [JS_TOOL];

const JS_DESCRIPTION = 'JavaScript runs in the page (global scope), not a sandbox.';

export const JS_PARAMETERS = {
    type: 'object',
    properties: {
        code: {
            type: 'string',
            description: 'JavaScript source. `at` is the Atelier workspace API.',
        },
        timeout: {
            type: 'integer',
            description: 'Optional timeout in milliseconds for async code (default 5000, max 15000).',
        },
    },
    required: ['code'],
};

/**
 * 在工作区上执行一段 JS。
 *
 * @param {string} code
 * @param {import('./workspace.js').Atelier} workspace
 * @param {{timeout?: number}} [options]
 * @returns {Promise<string>} 给模型看的文本结果
 */
export async function runWorkspaceScript(code, workspace, options = {}) {
    if (typeof code !== 'string' || !code.trim()) {
        throw new Error('code 不能为空');
    }
    if (code.length > MAX_CODE_LENGTH) {
        throw new Error(`code 太长（${code.length} 字符，上限 ${MAX_CODE_LENGTH}）`);
    }

    await workspace.ensure();

    const logs = [];
    const sandboxConsole = createSandboxConsole(logs);
    const api = createAtelierApi(workspace);
    // 页面上下文：SillyTavern.getContext()（Node 测试里没有，就是 null）
    const st = globalThis.SillyTavern?.getContext?.() ?? null;

    const timeout = Math.min(
        Math.max(Number(options.timeout) || DEFAULT_TIMEOUT_MS, 100),
        MAX_TIMEOUT_MS,
    );

    let fn;
    try {
        fn = new AsyncFunction('at', 'console', 'st', `"use strict";\n${code}`);
    } catch (error) {
        throw new Error(`代码语法错误：${error.message}`);
    }

    let value;
    let timer;
    try {
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`执行超时（>${timeout}ms）`)), timeout);
        });

        value = await Promise.race([fn(api, sandboxConsole, st), timeoutPromise]);
    } catch (error) {
        const message = error?.message ?? String(error);
        const prefix = logs.length ? `${logs.join('\n')}\n\n` : '';
        throw new Error(`${prefix}执行失败：${message}`);
    } finally {
        clearTimeout(timer);
    }

    return formatOutput(value, logs);
}

/**
 * 工作区原语：只给"JS 拿不到的东西"。
 * @param {import('./workspace.js').Atelier} workspace
 * @returns {Record<string, Function>}
 */
export function createAtelierApi(workspace) {
    const fs = () => workspace.fs;

    return {
        /**
         * 所有文件路径（可按前缀过滤）。
         * @param {string} [prefix]
         * @returns {string[]}
         */
        files: (prefix = '') => fs().files().filter(path => !prefix || path.startsWith(prefix)),

        /**
         * @param {string} path
         * @returns {string}
         */
        read: path => fs().read(path),

        /**
         * 新建/覆盖文件，写完通知面板并落盘。
         * @param {string} path
         * @param {string} content
         * @returns {{path: string, bytes: number, created: boolean}}
         */
        write: (path, content) => {
            const result = fs().write(path, content);
            workspace.touch('js-write', { path });
            void workspace.flush();
            return result;
        },

        /**
         * 移动 / 重命名文件或目录（目录连子树一起搬）。
         * @param {string} from
         * @param {string} to
         * @returns {{from: string, to: string, nodes: number}}
         */
        move: (from, to) => {
            const result = workspace.movePath(from, to);
            return { from: result.from, to: result.to, nodes: result.count };
        },

        /**
         * 删除文件或目录（递归）。
         * @param {string} path
         * @returns {{path: string, nodes: number}}
         */
        remove: path => {
            const nodes = workspace.removePath(path);
            return { path, nodes };
        },

        /**
         * YAML 子集解析（浏览器没有内置 YAML，这是唯一"库"能力）。
         * @param {string} text
         * @returns {any}
         */
        parseYaml: text => parseYaml(text),
    };
}

/**
 * @param {string[]} logs
 * @returns {Record<string, Function>}
 */
function createSandboxConsole(logs) {
    /**
     * @param {string} level
     * @returns {(...args: any[]) => void}
     */
    const make = level => (...args) => {
        const text = args.map(arg => {
            if (typeof arg === 'string') return arg;
            try {
                return JSON.stringify(arg);
            } catch {
                return String(arg);
            }
        }).join(' ');
        logs.push(level === 'log' ? text : `[${level}] ${text}`);
    };

    return {
        log: make('log'),
        info: make('info'),
        warn: make('warn'),
        error: make('error'),
        debug: make('debug'),
        table: make('table'),
    };
}

/**
 * @param {any} value
 * @param {string[]} logs
 * @returns {string}
 */
function formatOutput(value, logs) {
    /** @type {string[]} */
    const parts = [];

    if (logs.length) parts.push(logs.join('\n'));

    if (value !== undefined) {
        if (typeof value === 'string') {
            parts.push(value);
        } else {
            try {
                parts.push(JSON.stringify(value, null, 2));
            } catch {
                parts.push(String(value));
            }
        }
    }

    if (!parts.length) parts.push('(无返回值、无输出)');

    let text = parts.join('\n');
    if (text.length > MAX_OUTPUT_CHARS) {
        text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[输出已截断：共 ${text.length} 字符，上限 ${MAX_OUTPUT_CHARS}]`;
    }
    return text;
}

/**
 * 注册 `js` 工具。
 * @param {any} context getContext()
 * @param {import('./workspace.js').Atelier} workspace
 * @returns {void}
 */
export function registerJsTool(context, workspace) {
    context.registerFunctionTool({
        name: JS_TOOL,
        displayName: 'Run JavaScript',
        description: JS_DESCRIPTION,
        parameters: JS_PARAMETERS,
        action: async args => runWorkspaceScript(args?.code, workspace, { timeout: args?.timeout }),
        shouldRegister: () => workspace.isBound(),
    });
}

/**
 * @param {any} context
 * @returns {void}
 */
export function unregisterJsTool(context) {
    try {
        context.unregisterFunctionTool(JS_TOOL);
    } catch (error) {
        console.warn('[atelier] 注销 js 工具失败', error);
    }
}
