/**
 * Atelier —— 与聊天记录绑定的前端工作区 + read/write/edit 函数工具。
 *
 * 入口约定：
 *   manifest.json 的 hooks.activate -> init()
 *   hooks.enable -> onEnable()，hooks.disable -> onDisable()
 *
 * 关键点：不要在模块级缓存 getContext() 的返回值。
 * SillyTavern 切换聊天时会重新赋值 chat_metadata，缓存下来的对象会指向旧聊天。
 * 这里用一个 Proxy，每次取属性都重新 getContext()。
 */

import { getContext } from '../../../extensions.js';
import { yaml } from '../../../../lib.js';
import { setYamlImplementation } from './lib/yaml.js';
import { Atelier } from './lib/workspace.js';
import { WorkspaceUI } from './lib/ui.js';
import { registerWorkspaceTools, unregisterWorkspaceTools, describeToolCalling } from './lib/tools.js';
import { registerJsTool, unregisterJsTool } from './lib/js-tool.js';
import { ToolMessageActions } from './lib/message-actions.js';
import { installReasoningBackfill, needsReasoningBackfill } from './lib/reasoning-backfill.js';
import { ToolChainCollapse } from './lib/chain-collapse.js';
import { AutoSync } from './lib/auto-sync.js';
import { ChatCompression } from './lib/compression.js';
import { SelfReview } from './lib/review.js';
import { McpPanel } from './lib/mcp-panel.js';

const SETTINGS_KEY = 'atelier';
const WAND_ID = 'at_wand_button';
const MCP_WAND_ID = 'at_mcp_wand_button';

// 用酒馆自带的 yaml（/lib.js 里的命名导出），别自己造解析器
setYamlImplementation(yaml);

/** @type {ReturnType<typeof getContext>|null} */
let liveContext = null;
/** @type {Atelier|null} */
let workspace = null;
/** @type {WorkspaceUI|null} */
let ui = null;
/** @type {ToolMessageActions|null} */
let messageActions = null;
/** @type {ToolChainCollapse|null} */
let chainCollapse = null;
/** @type {AutoSync|null} */
let autoSync = null;
/** @type {ChatCompression|null} */
let compression = null;
/** @type {SelfReview|null} */
let review = null;
/** @type {McpPanel|null} */
let mcp = null;
/** @type {(() => void)|null} */
let uninstallReasoningBackfill = null;
let hooksBound = false;

/**
 * 每次属性访问都重新取上下文，避免聊天切换后指向旧的 chat_metadata。
 * @returns {ReturnType<typeof getContext>}
 */
function context() {
    if (!liveContext) {
        liveContext = new Proxy(/** @type {any} */ ({}), {
            get(_target, property) {
                return getContext()[property];
            },
            set(_target, property, value) {
                getContext()[property] = value;
                return true;
            },
            has(_target, property) {
                return property in getContext();
            },
            ownKeys() {
                return Reflect.ownKeys(getContext());
            },
            getOwnPropertyDescriptor(_target, property) {
                return {
                    value: getContext()[property],
                    writable: true,
                    enumerable: true,
                    configurable: true,
                };
            },
        });
    }
    return /** @type {ReturnType<typeof getContext>} */ (liveContext);
}

/**
 * manifest hooks.activate
 * @returns {Promise<void>}
 */
export async function init() {
    const ctx = context();

    ui?.destroy();
    unregisterWorkspaceTools(ctx);

    workspace = new Atelier(ctx);

    // 自动同步：打开聊天 / 世界书变动时，把启用的世界书补进工作区
    autoSync = new AutoSync(ctx, workspace);
    autoSync.install();

    // 上下文压缩：生成后自动压，请求前把压缩段换成摘要（不改聊天文件）
    compression = new ChatCompression(ctx, workspace);
    compression.install();

    // 自我改进回顾：每 N 回合静默沉淀一次（只写 /记忆）
    review = new SelfReview(ctx, workspace);
    review.install();

    // MCP 服务：网络传输（Streamable HTTP / SSE），连上后把对方的工具注册成酒馆工具
    mcp = new McpPanel(ctx);

    ui = new WorkspaceUI(ctx, workspace, { autoSync, compression, review });

    registerWorkspaceTools(ctx, workspace);
    registerJsTool(ctx, workspace);
    ensureWandButton();
    bindHooks();

    messageActions = new ToolMessageActions(ctx);
    messageActions.install();

    // 工具链跑完后，把中间的工具调用/旁白消息折叠起来
    chainCollapse = new ToolChainCollapse(ctx);
    chainCollapse.install();

    // DeepSeek 思考模式：把工具调用那一轮的真实推理回填进 reasoning_content
    uninstallReasoningBackfill?.();
    uninstallReasoningBackfill = installReasoningBackfill(ctx);

    registerSlashCommand();
    exposeApi();

    // 插件启用后，把「函数调用」和 Interleaved Thinking 的 Active Tool Chain 一起打开
    applyToolingDefaults();

    // 已经打开着聊天的话，首次进来也补一次
    autoSync.schedule('init');

    const status = describeToolCalling(ctx);
    console.log(`[atelier] 工具 read/write/edit/js 已注册；函数调用: ${status.ok ? '已启用' : `未启用 —— ${status.message}`}`);
    console.log('[atelier] 排查工具问题可在控制台执行 Atelier.diagnose()');
}

/**
 * manifest hooks.enable
 * @returns {void}
 */
export function onEnable() {
    ensureWandButton();
    if (workspace) {
        registerWorkspaceTools(context(), workspace);
        registerJsTool(context(), workspace);
    }
    applyToolingDefaults();
}

/**
 * manifest hooks.disable
 * @returns {void}
 */
export function onDisable() {
    unregisterWorkspaceTools(context());
    unregisterJsTool(context());
    ui?.destroy();
    messageActions?.destroy();
    messageActions = null;
    chainCollapse?.destroy();
    chainCollapse = null;
    autoSync?.destroy();
    autoSync = null;
    compression?.destroy();
    compression = null;
    review = null;
    mcp?.destroy();
    mcp = null;
    uninstallReasoningBackfill?.();
    uninstallReasoningBackfill = null;
    delete globalThis.Atelier;
    document.getElementById(WAND_ID)?.closest('.extension_container')?.remove();
    document.getElementById(WAND_ID)?.remove();
    document.getElementById(MCP_WAND_ID)?.closest('.extension_container')?.remove();
    document.getElementById(MCP_WAND_ID)?.remove();
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

/**
 * 给「后续的前端 JS 执行工具」留的进程内 API。
 * 在浏览器控制台或任意前端脚本里可以直接用：
 *   await Atelier.ready();
 *   Atelier.read('/world_book/xxx/entries/0_yyy.md');
 *
 * @returns {void}
 */
function exposeApi() {
    if (!workspace) return;

    const api = {
        /** @returns {import('./lib/workspace.js').Atelier|null} */
        get instance() {
            return workspace;
        },
        /**
         * 等当前聊天的工作区加载完。
         * @returns {Promise<any>}
         */
        ready: async () => {
            await workspace.ensure();
            return api;
        },
        /**
         * @param {string} path
         * @returns {string}
         */
        read: (path) => workspace.fs.read(path),
        /**
         * @param {string} path
         * @returns {any[]}
         */
        list: (path) => workspace.fs.list(path),
        /**
         * @param {string} path
         * @param {string} content
         * @returns {{path: string, bytes: number, created: boolean}}
         */
        write: (path, content) => {
            const result = workspace.fs.write(path, content);
            workspace.touch('api-write');
            return result;
        },
        /**
         * @param {string} path
         * @param {string} oldString
         * @param {string} newString
         * @param {boolean} [replaceAll]
         * @returns {number} 替换次数
         */
        edit: (path, oldString, newString, replaceAll = false) => {
            const text = workspace.fs.read(path);
            const occurrences = text.split(oldString).length - 1;
            if (!occurrences) throw new Error(`找不到: ${oldString}`);
            if (occurrences > 1 && !replaceAll) throw new Error(`命中 ${occurrences} 次，需要更精确的 oldString 或 replaceAll`);
            workspace.fs.write(path, text.split(oldString).join(newString));
            workspace.touch('api-edit');
            return occurrences;
        },
        /** @returns {string[]} */
        files: () => workspace.fs.files(),
        /**
         * 排查「为什么模型看不到工具」。
         * @returns {Record<string, any>}
         */
        diagnose: () => {
            const ctx = context();
            const status = describeToolCalling(ctx);
            const ready = Boolean(workspace?.isReady());
            const report = {
                chat: ctx.getCurrentChatId?.() || ctx.chatId || '(无)',
                workspaceBound: Boolean(workspace?.isBound()),
                workspaceReady: ready,
                storage: workspace?.storage ? 'IndexedDB' : 'chat_metadata',
                sid: workspace?.sid ?? '',
                files: ready ? workspace.fs.files().length : 0,
                books: ready ? workspace.bookDirs() : [],
                toolCalling: status,
                registeredTools: ['read', 'write', 'edit', 'js'],
                toolManagerToolCount: ctx.ToolManager?.tools?.length ?? '?',
                reasoningBackfill: {
                    installed: Boolean(uninstallReasoningBackfill),
                    active: needsReasoningBackfill(
                        {
                            chat_completion_source: ctx.chatCompletionSettings?.chat_completion_source,
                            model: ctx.getChatCompletionModel?.(ctx.chatCompletionSettings),
                        },
                        ctx.chatCompletionSettings,
                    ),
                },
            };
            console.log('[atelier] diagnose', report);
            return report;
        },
    };

    /** @type {any} */ (globalThis).Atelier = api;
}

/**
 * @returns {void}
 */
function bindHooks() {
    if (hooksBound) return;
    hooksBound = true;

    const ctx = context();
    ctx.eventSource?.on?.(ctx.eventTypes?.APP_READY, () => ensureWandButton());
    ctx.eventSource?.on?.(ctx.eventTypes?.CHAT_CHANGED, () => {
        // 聊天切换后工作区整体换了一套（sid 不同），丢弃内存状态再重画
        workspace?.reset();
        void ui?.refresh();
        // 新聊天的世界书自动补进工作区
        autoSync?.onChatChanged();
        // 消息列表是重建的，等一帧再补一次删除按钮
        window.setTimeout(() => messageActions?.decorateAll(), 200);
    });
    ctx.eventSource?.on?.(ctx.eventTypes?.SETTINGS_LOADED, () => {
        void ui?.refresh();
    });
}

/**
 * 在魔杖菜单里加一行入口。
 * @returns {void}
 */
function ensureWandButton() {
    addMenuItem({
        id: WAND_ID,
        icon: 'fa-folder-tree',
        label: 'Atelier',
        onClick: () => ui?.toggle(),
    });
    addMenuItem({
        id: MCP_WAND_ID,
        icon: 'fa-plug',
        label: 'MCP 服务',
        onClick: () => mcp?.toggle(),
    });
}

/**
 * @param {{id: string, icon: string, label: string, onClick: () => void}} item
 * @returns {void}
 */
function addMenuItem(item) {
    if (document.getElementById(item.id)) return;

    const container = document.getElementById('extensionsMenu');
    if (!(container instanceof HTMLElement)) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'extension_container';

    const button = document.createElement('div');
    button.id = item.id;
    button.className = 'list-group-item flex-container flexGap5';

    const icon = document.createElement('div');
    icon.className = `fa-solid ${item.icon} extensionsMenuExtensionButton`;

    const label = document.createElement('span');
    label.textContent = item.label;

    button.append(icon, label);
    button.addEventListener('click', item.onClick);
    wrapper.append(button);
    container.append(wrapper);
}

/**
 * 提供一个 /atelier 斜杠命令（失败不影响主流程）。
 * @returns {void}
 */
function registerSlashCommand() {
    try {
        const ctx = context();
        const { SlashCommandParser, SlashCommand } = ctx;
        if (!SlashCommandParser || !SlashCommand) return;

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'atelier',
            returns: 'void',
            helpString: '打开 / 关闭 Atelier 面板。',
            callback: () => {
                ui?.toggle();
                return '';
            },
        }));
    } catch (error) {
        console.debug('[atelier] 注册 /atelier 失败（忽略）', error);
    }
}
