/**
 * 自我改进回顾 —— 借 hermes-agent 的 background_review 思路。
 *
 * hermes 的做法：每回合结束后 fork 一个 agent 回放对话快照，问一句
 * "这轮有没有值得沉淀的技能/记忆"，它自己调工具写库，主对话一个字不动。
 *
 * 我们 fork 不了、也不做定时（用户明确不要 cron），所以：
 *
 *   触发：每完成 N 回合（N 默认 6）跑一次 + 面板手动按钮
 *   形式：generateQuietPrompt 静默问一次，要求只返回 JSON
 *   写入：/记忆/*.md —— 先读已有内容、机械去重，再追加
 *
 * 有一条硬约束：**回顾只能写 /记忆，永远不碰 /world_book**。
 * 世界书会自动写回酒馆，让一个猜测性的回顾去改世界书太危险。
 */

import { ARCHIVE_HEADER, archivePath, branchOf, renderArchiveEntry, shouldArchive } from './archive.js';
import { HISTORY_DIR } from './workspace.js';

const SETTINGS_KEY = 'atelier';
const META_KEY = 'atelier_review';

export const MEMORY_DIR = '/记忆';
export const REVIEW_LOG = `${MEMORY_DIR}/回顾记录.md`;

/** 允许写入的记忆文件，key 就是模型返回的 file 字段 */
export const MEMORY_FILES = {
    'user-pref': `${MEMORY_DIR}/用户偏好.md`,
    world: `${MEMORY_DIR}/世界设定.md`,
    style: `${MEMORY_DIR}/文风.md`,
    todo: `${MEMORY_DIR}/待确认.md`,
};

const HEADERS = {
    'user-pref': '# 用户偏好\n\n称呼、语气、写作风格、明确说过的禁忌。\n',
    world: '# 世界设定\n\n对话里已经确立的事实：地名、组织、角色关系、规则。\n',
    style: '# 文风\n\n用户认可过或要求过的写法特征。\n',
    todo: '# 待确认\n\n拿不准、需要用户确认的观察。\n',
};

const MAX_ITEM_CHARS = 160;

/**
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
    return String(text ?? '')
        .toLowerCase()
        .replace(/^[\s\-*•]+/, '')
        .replace(/[\s，。、；：！？,.;:!?"'“”‘’()（）\[\]【】]/g, '');
}

/**
 * 从模型输出里抠出 JSON。容忍 ```json 围栏和前后废话。
 * @param {string} text
 * @returns {{file: string, text: string}[]}
 */
export function parseReviewOutput(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return [];

    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : raw;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) return [];

    let payload;
    try {
        payload = JSON.parse(candidate.slice(start, end + 1));
    } catch {
        return [];
    }

    const list = Array.isArray(payload?.save) ? payload.save : [];
    /** @type {{file: string, text: string, replaces?: string}[]} */
    const items = [];

    for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const file = String(entry.file ?? '').trim();
        if (!Object.hasOwn(MEMORY_FILES, file)) continue;

        const body = String(entry.text ?? '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, MAX_ITEM_CHARS);
        if (body.length < 2) continue;
        if (/^(无|没有|nothing)/i.test(body)) continue;

        const replaces = String(entry.replaces ?? '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, MAX_ITEM_CHARS);

        items.push(replaces ? { file, text: body, replaces } : { file, text: body });
    }

    return items;
}

/**
 * 把一条事实并进已有的 markdown 列表。
 *
 * - 给了 `replaces` 且能在文件里找到那一条 → **原地改写**（对应 hermes 的 "fix in place"）；
 * - 已经存在同一条 → 不写；
 * - 否则追加。
 *
 * @param {string} content
 * @param {string} text
 * @param {string} [replaces]
 * @returns {{content: string, added: boolean}}
 */
export function appendUnique(content, text, replaces = '') {
    const existing = String(content ?? '');
    const lines = existing.split('\n');

    if (replaces) {
        const target = normalize(replaces);
        const index = lines.findIndex(line => line.trim().startsWith('- ') && normalize(line) === target);
        if (index !== -1) {
            lines[index] = `- ${text}`;
            return { content: lines.join('\n'), added: true };
        }
    }

    const known = new Set(
        lines
            .filter(line => line.trim().startsWith('- '))
            .map(line => normalize(line)),
    );

    if (known.has(normalize(text))) return { content: existing, added: false };

    const suffix = existing.endsWith('\n') ? '' : '\n';
    return { content: `${existing}${suffix}- ${text}\n`, added: true };
}

/**
 * 回顾提示词。规则大部分直接翻译自 hermes 的 _MEMORY_REVIEW_PROMPT / _DO_NOT_CAPTURE_BLOCK。
 * @param {string} transcript
 * @param {Record<string, string>} memory
 * @returns {string}
 */
export function buildReviewPrompt(transcript, memory) {
    const known = Object.entries(memory)
        .filter(([, content]) => content.trim())
        .map(([file, content]) => `### ${file}\n${content.trim()}`)
        .join('\n\n');

    return [
        '回顾下面这段对话，判断有没有值得长期沉淀的内容。',
        '',
        '可以写进四类：',
        '- user-pref：用户偏好——称呼、语气、写作风格，以及明确说过的禁忌（"别这样写"、"太长"）。',
        '- world：已经确立的设定事实——地名、组织、角色关系、能力、约定。',
        '- style：用户认可过或要求过的写法特征。',
        '- todo：拿不准、需要用户确认的观察。',
        '',
        '规则（重要）：',
        '1. 只写以后还用得上的东西。一次性的剧情推进、寒暄、情绪描写不要写。',
        '2. 一条一件事，用陈述短句，不要写"用户说……"这种转述。',
        '3. 下面「已有记忆」里出现过的，不要再写一遍；如果是修正或推翻某一条，把那条原文放进 replaces 字段，会原地替换。',
        '4. 不要写环境类的临时故障（"某个工具坏了"），也不要写还没验证的猜测。',
        '5. 最多 3 条。实在没有值得写的，返回 {"save": []}。',
        '',
        '只返回 JSON，不要解释，不要代码块以外的文字：',
        '{"save":[{"file":"user-pref","text":"新的写法","replaces":"要替换掉的旧那条（没有就省略）"}]}',
        '',
        known ? `已有记忆：\n\n${known}\n` : '已有记忆：暂无。\n',
        '对话记录：',
        '',
        transcript,
    ].join('\n');
}

export class SelfReview {
    /**
     * @param {any} context getContext()
     * @param {import('./workspace.js').Atelier} workspace
     * @param {{interval?: number, toolInterval?: number, keepMessages?: number, guidance?: boolean}} [options]
     */
    constructor(context, workspace, options = {}) {
        this.context = context;
        this.workspace = workspace;

        const saved = this.settings;
        // 双计数器：用户轮数（memory.nudge_interval 的对应物）和工具调用轮数（skill nudge 的对应物）
        this.interval = options.interval ?? sanitizeCount(saved.reviewTurns, 10);
        this.toolInterval = options.toolInterval ?? sanitizeCount(saved.reviewToolRounds, 10);
        this.keepMessages = options.keepMessages ?? 12;
        this.useGuidance = options.guidance !== false;
        this.busy = false;
        this.unsubscribe = null;
        /** @type {any} */
        this.decorateTimer = null;
        /** 当前聊天每条消息的身份快照，用来在被删楼时定位删的是哪几层 */
        /** @type {string[]} */
        this.keysSnapshot = [];
    }

    /**
     * @returns {Record<string, any>}
     */
    get settings() {
        const store = this.context.extensionSettings;
        if (!store[SETTINGS_KEY] || typeof store[SETTINGS_KEY] !== 'object') store[SETTINGS_KEY] = {};
        return store[SETTINGS_KEY];
    }

    /**
     * 默认关闭：面板上勾了才自动回顾。手动按钮不受这个开关影响。
     * @returns {boolean}
     */
    get enabled() {
        return this.settings.review === true;
    }

    /**
     * @param {boolean} value
     * @returns {void}
     */
    setEnabled(value) {
        this.settings.review = Boolean(value);
        this.context.saveSettingsDebounced?.();
        this.refreshGuidance();
    }

    /**
     * @param {number} value
     * @returns {number} 实际生效的值
     */
    setInterval(value) {
        this.interval = sanitizeCount(value, 10);
        this.settings.reviewTurns = this.interval;
        this.context.saveSettingsDebounced?.();
        return this.interval;
    }

    /**
     * @param {number} value
     * @returns {number} 实际生效的值
     */
    setToolInterval(value) {
        this.toolInterval = sanitizeCount(value, 10);
        this.settings.reviewToolRounds = this.toolInterval;
        this.context.saveSettingsDebounced?.();
        return this.toolInterval;
    }

    /**
     * @returns {{turns: number, iters: number, lastRunAt: number}}
     */
    get state() {
        const meta = this.context.chatMetadata;
        if (!meta) return { turns: 0, iters: 0, lastRunAt: 0 };

        if (!meta[META_KEY] || typeof meta[META_KEY] !== 'object') {
            meta[META_KEY] = { turns: 0, iters: 0, lastRunAt: 0 };
        }
        const state = meta[META_KEY];
        if (typeof state.iters !== 'number') state.iters = 0;
        if (typeof state.turns !== 'number') state.turns = 0;
        return state;
    }

    /**
     * @returns {void}
     */
    install() {
        const events = this.context.eventTypes;
        const source = this.context.eventSource;

        // 用户轮：GENERATION_ENDED 在工具重入时会重复触发，靠 onTurn 里的用户消息计数去重
        if (events?.GENERATION_ENDED) {
            source?.on?.(events.GENERATION_ENDED, () => void this.onTurn());
        }

        // 工具轮：TOOL_CALLS_PERFORMED 一轮只发一次，invocations 里是这轮的全部调用
        this.countsRounds = Boolean(events?.TOOL_CALLS_PERFORMED);
        if (this.countsRounds) {
            source?.on?.(events.TOOL_CALLS_PERFORMED, invocations => this.onToolRound(invocations));
        }

        // 切聊天：重新对齐用户消息基线，避免把新聊天的历史当成新回合
        if (events?.CHAT_CHANGED) {
            source?.on?.(events.CHAT_CHANGED, () => {
                this.scheduleDecorate();
                this.snapshotKeys();
                if (!this.context.chatMetadata) return;
                this.state.lastUserCount = this.userMessageCount();
                this.context.saveMetadataDebounced?.();
            });
        }

        // 重新渲染后把总结块的样式和删除按钮补回去
        if (events?.MESSAGE_RECEIVED) {
            source?.on?.(events.MESSAGE_RECEIVED, () => {
                this.scheduleDecorate();
                this.snapshotKeys();
            });
        }

        // 和聊天操作联动：删楼 / 改楼 / 切分支 / 删分支，都要同步 /chat_history 里的归档
        if (events?.MESSAGE_DELETED) {
            source?.on?.(events.MESSAGE_DELETED, () => void this.onMessagesDeleted());
        }
        if (events?.MESSAGE_EDITED) {
            source?.on?.(events.MESSAGE_EDITED, id => void this.refreshArchive(id));
        }
        if (events?.MESSAGE_SWIPED) {
            source?.on?.(events.MESSAGE_SWIPED, id => void this.refreshArchive(id));
        }
        if (events?.MESSAGE_SWIPE_DELETED) {
            source?.on?.(events.MESSAGE_SWIPE_DELETED, payload => void this.onSwipeDeleted(payload));
        }

        // 主会话自己动手写 /记忆 时清零（对应 hermes tool_executor 里调过 skill_manage 就重置计数器）
        this.unsubscribe = this.workspace.onChange((reason, detail) => this.onWorkspaceChange(reason, detail));

        if (!this.context.chatMetadata) return;
        if (typeof this.state.lastUserCount !== 'number') {
            this.state.lastUserCount = this.userMessageCount();
        }

        this.snapshotKeys();
        this.refreshGuidance();
    }

    /**
     * @returns {void}
     */
    scheduleDecorate() {
        if (this.decorateTimer) clearTimeout(this.decorateTimer);
        this.decorateTimer = setTimeout(() => {
            this.decorateTimer = null;
            this.decorateAll();
        }, 300);
    }

    /**
     * @returns {void}
     */
    destroy() {
        this.unsubscribe?.();
        this.unsubscribe = null;
        if (this.decorateTimer) clearTimeout(this.decorateTimer);
        this.decorateTimer = null;
        this.refreshGuidance(true);
    }

    /**
     * 在主模型的提示词里常驻一句"可以自己写记忆"——对应 hermes 的 SKILLS_GUIDANCE。
     * @param {boolean} [clear]
     * @returns {void}
     */
    refreshGuidance(clear = false) {
        const setPrompt = this.context.setExtensionPrompt;
        if (typeof setPrompt !== 'function') return;

        const active = !clear && this.useGuidance && this.enabled;
        const text = active
            ? '工作区有 /记忆/ 目录。当你了解到值得长期保留的用户偏好、设定事实或写法要求时，'
                + '直接用 write/edit 写进 /记忆/用户偏好.md、/记忆/世界设定.md、/记忆/文风.md。'
                + '已有条目请原地改写，不要重复追加。'
            : '';

        // position 0 = IN_PROMPT（追加进主提示词），role 0 = SYSTEM
        setPrompt('atelier-memory-guidance', text, 0, 0, false, 0);
    }

    /**
     * @param {string} reason
     * @param {{path?: string}} [detail]
     * @returns {void}
     */
    onWorkspaceChange(reason, detail) {
        const path = detail?.path ?? '';

        // 模型自己写的 → 它已经在维护记忆了，两个计数器一起清零
        // （对应 hermes tool_executor: 调过 memory / skill_manage 就重置对应计数器）
        if (path.startsWith(`${MEMORY_DIR}/`)) {
            this.state.turns = 0;
            this.state.iters = 0;
            this.context.saveMetadataDebounced?.();
            return;
        }

        // 老版本酒馆没有 TOOL_CALLS_PERFORMED 事件时，退化成"每次工具调用算一轮"
        if (this.countsRounds) return;
        if (/^(tool|js)-/.test(reason)) this.onToolRound();
    }

    /**
     * 一轮工具调用结束（对应 hermes 的 `_iters_since_skill += 1`）。
     * 同一轮里有几个并行调用都只算一轮。
     * @param {any[]} [invocations]
     * @returns {void}
     */
    onToolRound(invocations) {
        if (!this.enabled) return;
        if (!this.context.chatMetadata) return;

        const state = this.state;
        state.iters += 1;
        this.context.saveMetadataDebounced?.();

        if (state.iters < this.toolInterval) return;
        void this.run({ trigger: 'tool-count' });
    }

    /**
     * 一回合结束（对应 hermes 的 `_turns_since_memory += 1`）。
     *
     * 注意：ST 遇到 tool_calls 会递归重入 Generate，`GENERATION_ENDED` 每轮工具都会触发一次，
     * 所以不能按事件计数 —— 只能用"用户消息条数"判断真的多了一轮对话。
     *
     * @returns {Promise<void>}
     */
    async onTurn() {
        if (!this.enabled) return;
        if (!this.context.chatMetadata) return;

        const count = this.userMessageCount();
        const state = this.state;

        // 第一次观察 / 删过消息：只重新对齐基线，不计数
        if (typeof state.lastUserCount !== 'number' || count < state.lastUserCount) {
            state.lastUserCount = count;
            this.context.saveMetadataDebounced?.();
            return;
        }
        // 工具重入：用户消息没变，不算新回合
        if (count === state.lastUserCount) return;

        state.turns += count - state.lastUserCount;
        state.lastUserCount = count;
        this.context.saveMetadataDebounced?.();

        if (state.turns < this.interval) return;
        await this.run({ trigger: 'auto' });
    }

    /**
     * @returns {number}
     */
    userMessageCount() {
        const chat = this.context.chat ?? [];
        return chat.filter(message => message && !message.is_system && message.is_user).length;
    }

    /**
     * 跑一次回顾。
     * @param {{trigger?: string}} [options]
     * @returns {Promise<{saved: number, archived: number, items: {file: string, text: string}[], skipped?: string}>}
     */
    async run(options = {}) {
        if (this.busy) return { saved: 0, archived: 0, items: [], skipped: 'busy' };
        if (!this.enabled && options.trigger !== 'manual') return { saved: 0, archived: 0, items: [], skipped: 'disabled' };

        const entries = this.recentEntries();
        if (entries.length < 2) return { saved: 0, archived: 0, items: [], skipped: 'too-short' };

        this.busy = true;
        try {
            await this.workspace.ready();

            const transcript = entries
                .map(({ message }) => `[${message.is_user ? '用户' : (message.name || '角色')}] ${String(message.mes ?? '').trim()}`)
                .join('\n\n');

            const memory = this.readMemory();
            const prompt = buildReviewPrompt(transcript, memory);

            const generate = this.context.generateQuietPrompt;
            if (typeof generate !== 'function') throw new Error('酒馆没有提供 generateQuietPrompt');

            const raw = await generate({ quietPrompt: prompt, removeReasoning: true });
            const items = parseReviewOutput(raw);
            const saved = this.applyItems(items);

            // 被总结的消息原文：按「楼层-分支.md」存进 /chat_history，压缩或删楼之后还能翻回来
            const archived = await this.archiveEntries(entries);

            this.state.turns = 0;
            this.state.iters = 0;
            this.state.lastRunAt = Date.now();
            this.context.saveMetadataDebounced?.();

            if (saved > 0) {
                this.workspace.touch('review');
                await this.insertMarker(saved, items);
            }

            return { saved, archived, items };
        } finally {
            this.busy = false;
        }
    }

    /**
     * 把回顾窗口里的原文逐条归档成 md。
     *
     * 文件名：`<楼层>-<分支>.md`，楼层从 1 开始（chat 数组下标 + 1），
     * 分支是 swipe_id + 1，没切过分支就是 1。
     *
     * 工具消息（extra.tool_invocations）也存，正文是调用参数 + 返回结果。
     *
     * @param {{message: any, index: number}[]} entries
     * @returns {Promise<number>}
     */
    async archiveEntries(entries) {
        if (!entries.length) return 0;

        const chat = this.context.chat ?? [];
        const fs = this.workspace.fs;

        const from = entries[0].index;
        const to = entries[entries.length - 1].index;

        let written = 0;
        for (let index = from; index <= to; index += 1) {
            const message = chat[index];
            if (!shouldArchive(message)) continue;

            const floor = index + 1;
            const branch = branchOf(message);
            const path = archivePath(floor, branch);
            const text = renderArchiveEntry(message, floor, branch);

            // 同样的内容不重复写（回顾窗口会互相重叠）
            if (fs.exists(path) && !fs.isDir(path) && fs.read(path) === text) continue;

            fs.write(path, text);
            written += 1;
        }

        if (written > 0) {
            this.workspace.touch('review-archive');
            await this.workspace.flush();
        }

        this.snapshotKeys();
        return written;
    }

    /**
     * 消息被删（可能一次删多条）。
     *
     * MESSAGE_DELETED 只带「删除后的 chat.length」，不知道删的是哪层，
     * 所以靠自己维护的身份快照做前缀比对：找到第一个对不上的下标，就删了那几层。
     *
     * @returns {Promise<void>}
     */
    async onMessagesDeleted() {
        const previous = this.keysSnapshot;
        const current = this.currentKeys();

        let index = 0;
        while (index < previous.length && index < current.length && previous[index] === current[index]) {
            index += 1;
        }

        const removed = previous.length - current.length;
        this.keysSnapshot = current;

        if (removed <= 0 || !this.workspace.isBound()) return;

        try {
            await this.workspace.ready();
            await this.shiftArchives(index + 1, removed);
        } catch (error) {
            console.warn('[atelier] 删除归档失败', error);
        }
    }

    /**
     * 删掉第 firstFloor 层起的 count 层归档，并把后面的楼层往前挪。
     *
     * @param {number} firstFloor
     * @param {number} count
     * @returns {Promise<void>}
     */
    async shiftArchives(firstFloor, count) {
        const fs = this.workspace.fs;
        const files = listArchiveFiles(fs);
        if (!files.length) return;

        const lastRemoved = firstFloor + count - 1;
        let touched = false;

        for (const file of files) {
            if (file.floor < firstFloor || file.floor > lastRemoved) continue;
            fs.remove(file.path);
            touched = true;
        }

        // 从前往后搬，目标位置刚好空出来
        const shifting = files
            .filter(file => file.floor > lastRemoved)
            .sort((a, b) => a.floor - b.floor);

        for (const file of shifting) {
            fs.move(file.path, archivePath(file.floor - count, file.branch));
            touched = true;
        }

        if (touched) {
            this.workspace.touch('review-archive');
            await this.workspace.flush();
        }
    }

    /**
     * 第 id 层被改了内容或切了分支：已归档的那份跟着刷新。
     * @param {number} id
     * @returns {Promise<void>}
     */
    async refreshArchive(id) {
        const message = this.context.chat?.[Number(id)];
        if (!message || !this.workspace.isBound()) return;

        try {
            await this.workspace.ready();
            const fs = this.workspace.fs;
            const floor = Number(id) + 1;
            const branch = branchOf(message);
            const path = archivePath(floor, branch);

            if (!fs.exists(path)) return;

            if (!shouldArchive(message)) {
                fs.remove(path);
            } else {
                const text = renderArchiveEntry(message, floor, branch);
                if (fs.read(path) === text) return;
                fs.write(path, text);
            }

            this.workspace.touch('review-archive');
            await this.workspace.flush();
        } catch (error) {
            console.warn('[atelier] 刷新归档失败', error);
        }
    }

    /**
     * 删了某个分支：只删那一份归档。
     * @param {{messageId?: number, swipeId?: number}} payload
     * @returns {Promise<void>}
     */
    async onSwipeDeleted(payload) {
        const messageId = Number(payload?.messageId);
        const swipeId = Number(payload?.swipeId);
        if (!Number.isFinite(messageId) || !Number.isFinite(swipeId)) return;
        if (!this.workspace.isBound()) return;

        try {
            await this.workspace.ready();
            const fs = this.workspace.fs;
            const path = archivePath(messageId + 1, swipeId + 1);
            if (!fs.exists(path)) return;

            fs.remove(path);
            this.workspace.touch('review-archive');
            await this.workspace.flush();
        } catch (error) {
            console.warn('[atelier] 删除分支归档失败', error);
        }
    }

    /**
     * 记下当前聊天的消息身份，供下次删除时比对。
     * @returns {void}
     */
    snapshotKeys() {
        this.keysSnapshot = this.currentKeys();
    }

    /**
     * @returns {string[]}
     */
    currentKeys() {
        return (this.context.chat ?? []).map(message => messageKey(message));
    }

    /**
     * 在聊天末尾插一条提示，说明这次总结了什么。
     * 只是提示：删掉它不会动 /记忆 里的文件。
     *
     * @param {number} saved
     * @param {{file: string, text: string}[]} items
     * @returns {Promise<void>}
     */
    async insertMarker(saved, items) {
        const chat = this.context.chat;
        if (!Array.isArray(chat)) return;

        const marker = {
            name: 'System',
            is_user: false,
            is_system: true,
            send_date: Date.now(),
            mes: `[自我总结] 新增 ${saved} 条记忆`,
            extra: {
                at_review: {
                    saved,
                    items: items.map(item => ({ file: item.file, text: item.text })),
                    createdAt: Date.now(),
                },
            },
        };

        chat.push(marker);

        try {
            await this.context.saveChat?.();
        } catch (error) {
            console.warn('[atelier] 保存聊天失败（总结提示）', error);
        }
        this.context.printMessages?.();
        this.decorateAll();
    }

    /**
     * 删除总结提示：只删消息，不碰 /记忆 里的文件。
     * @param {number} id
     * @returns {Promise<void>}
     */
    async removeMarker(id) {
        const chat = this.context.chat;
        if (!Array.isArray(chat) || !chat[id]?.extra?.at_review) return;

        try {
            if (typeof this.context.deleteMessage === 'function') {
                await this.context.deleteMessage(id);
            } else {
                chat.splice(id, 1);
                this.context.printMessages?.();
            }
            globalThis.toastr?.info?.('已删除总结提示，/记忆 里的文件没动', '工作区');
        } catch (error) {
            console.warn('[atelier] 删除总结提示失败', error);
            globalThis.toastr?.error?.(`删除失败：${error?.message ?? error}`, '工作区');
        }
    }

    /**
     * 把带 at_review 的消息渲染成折叠块。
     * @returns {void}
     */
    decorateAll() {
        if (typeof document === 'undefined') return;

        const chat = this.context.chat ?? [];
        document.querySelectorAll('.mes[mesid]').forEach(element => {
            const id = Number(element.getAttribute('mesid'));
            const meta = chat[id]?.extra?.at_review;
            if (!meta || element.classList.contains('at-review')) return;

            element.classList.add('at-review', 'smallSysMes');

            const target = element.querySelector('.mes_text');
            if (!(target instanceof HTMLElement)) return;
            target.textContent = '';

            const note = document.createElement('div');
            note.className = 'at-review-note';
            note.textContent = `🧠 自我总结：新增 ${meta.saved} 条记忆 · 文件在 /记忆/`;

            const details = document.createElement('details');
            details.className = 'at-review-details';

            const summaryEl = document.createElement('summary');
            summaryEl.textContent = '展开看写了什么';

            const body = document.createElement('div');
            body.className = 'at-review-body';
            const items = Array.isArray(meta.items) ? meta.items : [];
            if (!items.length) {
                body.textContent = '（没有记录条目）';
            } else {
                for (const item of items) {
                    const line = document.createElement('div');
                    line.className = 'at-review-item';
                    line.textContent = `${item.file}：${item.text}`;
                    body.append(line);
                }
            }

            details.append(summaryEl, body);
            target.append(note, details);

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'at-review-remove';
            remove.title = '删除这条提示（只删消息，/记忆 里的文件不动）';
            remove.textContent = '🗑';
            remove.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                void this.removeMarker(id);
            });
            element.append(remove);
        });
    }

    /**
     * 最近 N 条正常消息（跳过 system 和工具调用），连同它在 chat 里的下标。
     * 下标用来算楼层号，也用来确定归档窗口的范围。
     *
     * @returns {{message: any, index: number}[]}
     */
    recentEntries() {
        const chat = this.context.chat ?? [];
        /** @type {{message: any, index: number}[]} */
        const entries = [];

        chat.forEach((message, index) => {
            if (!message || message.is_system) return;
            entries.push({ message, index });
        });

        return entries.slice(-this.keepMessages);
    }

    /**
     * @returns {Record<string, string>}
     */
    readMemory() {
        const fs = this.workspace.fs;
        /** @type {Record<string, string>} */
        const memory = {};
        for (const [key, path] of Object.entries(MEMORY_FILES)) {
            memory[key] = fs.exists(path) ? fs.read(path).slice(0, 2000) : '';
        }
        return memory;
    }

    /**
     * 写文件，重复的跳过。
     * @param {{file: string, text: string}[]} items
     * @returns {number}
     */
    applyItems(items) {
        const fs = this.workspace.fs;
        const touched = new Map();

        for (const item of items) {
            const path = MEMORY_FILES[item.file];
            if (!path) continue;

            const current = fs.exists(path) ? fs.read(path) : HEADERS[item.file];
            const { content, added } = appendUnique(current, item.text, item.replaces);
            if (!added) continue;

            fs.write(path, content, { kind: 'memory', source: 'review' });
            touched.set(item.file, (touched.get(item.file) ?? 0) + 1);
        }

        if (touched.size) this.appendLog(touched);
        return [...touched.values()].reduce((sum, count) => sum + count, 0);
    }

    /**
     * @param {Map<string, number>} touched
     * @returns {void}
     */
    appendLog(touched) {
        const fs = this.workspace.fs;
        const stamp = new Date().toLocaleString();
        const detail = [...touched.entries()].map(([file, count]) => `${file}×${count}`).join('、');
        const line = `- ${stamp} 新增 ${[...touched.values()].reduce((a, b) => a + b, 0)} 条（${detail}）\n`;

        const current = fs.exists(REVIEW_LOG) ? fs.read(REVIEW_LOG) : '# 回顾记录\n\n';
        fs.write(REVIEW_LOG, current + line, { kind: 'memory', source: 'review-log' });
    }
}

/**
 * 计数器阈值：2–200，默认 10。
 * @param {any} value
 * @param {number} fallback
 * @returns {number}
 */
function sanitizeCount(value, fallback) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number) || number < 2) return fallback;
    return Math.min(200, number);
}

/**
 * 消息的身份标记。
 *
 * 普通消息用 send_date（改内容不会变），工具消息没有 send_date，用调用的 id。
 * @param {any} message
 * @returns {string}
 */
function messageKey(message) {
    if (!message) return '';

    if (message.send_date !== undefined && message.send_date !== null && message.send_date !== '') {
        return `t:${message.send_date}`;
    }

    const invocations = message.extra?.tool_invocations;
    if (Array.isArray(invocations) && invocations.length) {
        return `tool:${invocations.map(item => item?.id ?? item?.name ?? '').join('|')}`;
    }

    return `m:${message.is_user ? 'u' : 'c'}:${message.name ?? ''}`;
}

/**
 * 列出 /chat_history 里由回顾产生的归档文件。
 *
 * 同一目录还有压缩归档（`001-20261022.md`），光看文件名会和「楼层-分支」撞车，
 * 所以再用文件头 `# 楼层 ` 区分。
 *
 * @param {any} fs
 * @returns {{path: string, floor: number, branch: number}[]}
 */
function listArchiveFiles(fs) {
    if (!fs.exists(HISTORY_DIR) || !fs.isDir(HISTORY_DIR)) return [];

    /** @type {{path: string, floor: number, branch: number}[]} */
    const files = [];

    for (const entry of fs.list(HISTORY_DIR)) {
        if (entry?.dir) continue;
        const name = String(entry?.name ?? '');
        const match = /(\d+)-(\d+)\.md$/.exec(name);
        if (!match) continue;

        const path = entry.path ?? `${HISTORY_DIR}/${name}`;
        if (!fs.read(path).startsWith(ARCHIVE_HEADER)) continue;

        files.push({
            path,
            floor: Number(match[1]),
            branch: Number(match[2]),
        });
    }

    return files;
}
