/**
 * 上下文压缩（参考 hermes-agent 的四阶段，适配酒馆）。
 *
 * 核心差别：**不改聊天文件**。
 *   生成结束后：算摘要 → 原文归档到 /chat_history/ → 摘要存进 chat_metadata
 *   请求发出前：CHAT_COMPLETION_PROMPT_READY 里把被压缩的那几条换成一条摘要消息
 *
 * 匹配用内容指纹：只要那几条消息被编辑/删改过，指纹对不上就**跳过本次压缩**，
 * 宁可多花 token，也不能把对不上的东西换掉。
 *
 * 四阶段对应关系：
 *   Phase 1 剪枝   → 我们不剪工具消息（酒馆里它们本来就少），直接进 Phase 2
 *   Phase 2 边界   → 首条 + 尾部按 token 预算保留，中间段压缩
 *   Phase 3 摘要   → generateQuietPrompt，七段模板（改写成 RP 用的六段）
 *   Phase 4 拼装   → 请求数组里原地替换，system 消息一条都不动
 */

const SETTINGS_KEY = 'atelier';
const META_KEY = 'atelier_compression';
import { archivePath, branchOf, renderArchiveEntry, shouldArchive } from './archive.js';
import { HISTORY_DIR } from './workspace.js';

const ARCHIVE_DIR = HISTORY_DIR;

/** 摘要模板：比 hermes 的工程模板更适合角色扮演 */
const SUMMARY_PROMPT = `你是对话压缩器。把下面这段对话压缩成结构化摘要，供之后继续对话时使用。

要求：
- 只写事实，不评价、不寒暄、不脑补没发生的事；
- 保留具体信息：人名/称呼、地点、时间、数字、约定、承诺、道具、能力、未解开的线索；
- 按时间顺序写，后面覆盖前面的状态变化；
- 用户明确表达过的偏好（写作风格、禁忌、称呼方式）单独列出来；
- 用中文，总长控制在 400–800 字。

严格按这个格式输出：

## 当前情境
（谁在哪、正在做什么、什么状态）

## 已发生事件
（按时间顺序，每条一句话，尽量具体）

## 角色状态
（每个出场角色：称呼、关系、已知信息、当前情绪/目标）

## 设定与伏笔
（世界观规则、地名、约定、未解开的线索）

## 用户偏好
（如果没有就写"无"）

## 接续点
（压缩段结束那一刻正在发生什么，下一句该从哪儿接）`;

/**
 * 文本指纹（djb2）。用来判断"要压缩的这几条消息有没有变过"。
 * @param {string} text
 * @returns {string}
 */
export function hashText(text) {
    const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
    let hash = 5381;
    for (let i = 0; i < normalized.length; i += 1) {
        hash = ((hash << 5) + hash + normalized.charCodeAt(i)) | 0;
    }
    return `${normalized.length}:${(hash >>> 0).toString(36)}`;
}

/**
 * 把聊天数组里的一段拼成转录文本，给摘要模型看。
 * @param {any[]} messages
 * @returns {string}
 */
export function buildTranscript(messages) {
    return messages
        .map((message, index) => {
            const who = message?.is_user ? '用户' : (message?.name || '角色');
            const text = String(message?.mes ?? '').trim();
            return `### ${index + 1}. ${who}\n${text}`;
        })
        .join('\n\n');
}

/**
 * 计算要压缩的区间：保护第一条 + 尾部，剩下中间那段。
 * @param {number} length
 * @param {number} keepLast
 * @returns {{start: number, end: number}}
 */
export function planRange(length, keepLast) {
    const start = 1;
    const end = Math.max(start, length - keepLast);
    return { start, end };
}

/**
 * 把摘要按行渲染：`## 标题` 变成加粗小标题，其余原样换行。
 * 全程 textContent，不拼 HTML。
 *
 * @param {HTMLElement} container
 * @param {string} text
 * @returns {void}
 */
export function renderSummary(container, text) {
    for (const raw of String(text ?? '').split('\n')) {
        const line = raw.trimEnd();
        const heading = line.match(/^#{1,6}\s+(.*)$/);

        const element = document.createElement(heading ? 'div' : 'div');
        element.className = heading ? 'at-compress-h' : 'at-compress-line';
        element.textContent = heading ? heading[1] : (line || '\u00a0');
        container.append(element);
    }
}

export class ChatCompression {
    /**
     * @param {any} context getContext()
     * @param {import('./workspace.js').Atelier} workspace
     * @param {{threshold?: number, keepLast?: number, minMessages?: number}} [options]
     */
    constructor(context, workspace, options = {}) {
        this.context = context;
        this.workspace = workspace;

        const saved = this.settings;
        this.threshold = options.threshold ?? sanitizeThreshold(saved.compressionThreshold);
        this.keepLast = options.keepLast ?? sanitizeKeepLast(saved.compressionKeepLast);
        this.minMessages = options.minMessages ?? 4;
        this.busy = false;
        this.lastCheckedLength = -1;
        this.timer = null;
    }

    /**
     * 默认关闭：面板上勾了才自动压。手动按钮不受这个开关影响。
     * @returns {boolean}
     */
    get enabled() {
        return this.settings.compression === true;
    }

    /**
     * @param {boolean} value
     * @returns {void}
     */
    setEnabled(value) {
        this.settings.compression = Boolean(value);
        this.context.saveSettingsDebounced?.();
    }

    /**
     * @param {number} value
     * @returns {number} 实际生效的值
     */
    setThreshold(value) {
        this.threshold = sanitizeThreshold(value);
        this.settings.compressionThreshold = this.threshold;
        this.context.saveSettingsDebounced?.();
        return this.threshold;
    }

    /**
     * @param {number} value
     * @returns {number} 实际生效的值
     */
    setKeepLast(value) {
        this.keepLast = sanitizeKeepLast(value);
        this.settings.compressionKeepLast = this.keepLast;
        this.context.saveSettingsDebounced?.();
        return this.keepLast;
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
     * 当前聊天的压缩状态（存在 chat_metadata 里）。
     * @returns {Record<string, any>|null}
     */
    get state() {
        const meta = this.context.chatMetadata;
        if (!meta) return null;

        const value = meta[META_KEY];
        return value && typeof value === 'object' ? value : null;
    }

    /**
     * @param {Record<string, any>|null} value
     * @returns {void}
     */
    setState(value) {
        const meta = this.context.chatMetadata;
        if (!meta) return;
        if (value) meta[META_KEY] = value;
        else delete meta[META_KEY];
        this.context.saveMetadataDebounced?.();
    }

    /**
     * @returns {void}
     */
    install() {
        const events = this.context.eventTypes;
        const source = this.context.eventSource;
        if (events?.CHAT_COMPLETION_PROMPT_READY) {
            source?.on?.(events.CHAT_COMPLETION_PROMPT_READY, data => this.applyToPrompt(data));
        }
        if (events?.GENERATION_ENDED) {
            source?.on?.(events.GENERATION_ENDED, () => {
                this.scheduleAuto();
                this.scheduleDecorate();
            });
        }
        if (events?.CHAT_CHANGED) {
            source?.on?.(events.CHAT_CHANGED, () => {
                this.lastCheckedLength = -1;
                this.scheduleDecorate();
            });
        }
        if (events?.MESSAGE_RECEIVED) {
            source?.on?.(events.MESSAGE_RECEIVED, () => this.scheduleDecorate());
        }
    }

    /**
     * 消息重渲染后重新套折叠块（ST 会整块重画，标记会丢）。
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
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (this.decorateTimer) clearTimeout(this.decorateTimer);
        this.decorateTimer = null;
    }

    /**
     * 生成结束后延迟检查一次（不打断回复）。
     * @returns {void}
     */
    scheduleAuto() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.maybeCompress();
        }, 1200);
    }

    /**
     * @returns {number}
     */
    windowTokens() {
        const max = Number(this.context.maxContext);
        return Number.isFinite(max) && max > 0 ? max : 8192;
    }

    /**
     * 估算聊天 token（有酒馆的 tokenizer 就用，没有就按字符估）。
     * @param {string} text
     * @returns {Promise<number>}
     */
    async countTokens(text) {
        const counter = this.context.getTokenCountAsync;
        if (typeof counter === 'function') {
            try {
                const value = await counter(text);
                if (Number.isFinite(value) && value > 0) return value;
            } catch {
                // 退化成字符估算
            }
        }
        return Math.ceil(String(text ?? '').length * 0.6);
    }

    /**
     * 整段聊天的 token 估算。
     * @returns {Promise<number>}
     */
    async estimateChatTokens() {
        const chat = this.context.chat ?? [];
        const text = chat.map(message => message?.mes ?? '').join('\n');
        return this.countTokens(text);
    }

    /**
     * 超过阈值就自动压。
     * @returns {Promise<{skipped?: string, compressed?: boolean}>}
     */
    async maybeCompress() {
        if (!this.enabled) return { skipped: 'disabled' };
        if (this.busy) return { skipped: 'busy' };

        const chat = this.context.chat ?? [];
        if (chat.length <= this.minMessages) return { skipped: 'too-short' };

        const { start, end } = planRange(chat.length, this.keepLast);
        const state = this.state;
        if (state && state.range && state.range.end === end) {
            // 这一段的尾巴没动过，不用重复压
            return { skipped: 'up-to-date' };
        }

        const tokens = await this.estimateChatTokens();
        const thresholdTokens = Math.floor(this.windowTokens() * this.threshold);
        if (tokens < thresholdTokens) return { skipped: 'below-threshold', tokens, thresholdTokens };

        return this.compress({ trigger: 'threshold' });
    }

    /**
     * 执行压缩：归档原文 + 生成摘要 + 存状态。
     * @param {{trigger?: string}} [options]
     * @returns {Promise<{skipped?: string, compressed?: boolean, message?: string}>}
     */
    async compress(options = {}) {
        if (this.busy) return { skipped: 'busy' };

        const chat = this.context.chat ?? [];
        const { start, end } = planRange(chat.length, this.keepLast);

        // 系统消息（包括我们自己的压缩标记）不参与压缩，也不进入指纹
        /** @type {{message: any, index: number}[]} */
        const entries = [];
        for (let index = start; index < end; index += 1) {
            const message = chat[index];
            if (!message || message.is_system) continue;
            entries.push({ message, index });
        }

        const middle = entries.map(entry => entry.message);
        if (middle.length < 2) return { skipped: 'range-too-small' };

        const previous = this.state?.summary ?? '';

        this.busy = true;
        try {
            await this.workspace.ready();

            const archiveRef = this.archiveOriginals(entries);

            const transcript = buildTranscript(middle);
            const summary = await this.generateSummary(transcript, previous);

            const state = {
                v: 1,
                range: { start, end },
                hashes: middle.map(message => hashText(message?.mes ?? '')),
                summary,
                archive: archiveRef,
                messages: middle.length,
                createdAt: Date.now(),
            };
            this.setState(state);
            this.workspace.touch('compress');

            // 在聊天里留一个折叠块，方便看出这里被压过（不改动已有消息）
            await this.insertMarker(end, middle.length, summary, archiveRef);

            return { compressed: true, message: `已压缩 ${middle.length} 条消息` };
        } finally {
            this.busy = false;
        }
    }

    /**
     * 在聊天列表里插入一条系统消息，渲染成可折叠的压缩摘要块。
     * @param {number} index
     * @param {number} count
     * @param {string} summary
     * @param {string} archiveRef
     * @returns {Promise<void>}
     */
    async insertMarker(index, count, summary, archiveRef) {
        const chat = this.context.chat;
        if (!Array.isArray(chat)) return;

        const marker = {
            name: 'System',
            is_user: false,
            is_system: true,
            send_date: Date.now(),
            mes: `[上下文压缩] ${count} 条对话已压缩为摘要 · 原文 ${archiveRef}`,
            extra: {
                at_compression: {
                    messages: count,
                    archive: archiveRef,
                    summary,
                    createdAt: Date.now(),
                },
            },
        };

        chat.splice(Math.min(index, chat.length), 0, marker);

        try {
            await this.context.saveChat?.();
        } catch (error) {
            console.warn('[atelier] 保存聊天失败（压缩标记）', error);
        }
        this.context.printMessages?.();
        this.decorateAll();
    }

    /**
     * 把所有带压缩标记的消息渲染成折叠块。
     * @returns {void}
     */
    decorateAll() {
        if (typeof document === 'undefined') return;

        const chat = this.context.chat ?? [];
        document.querySelectorAll('.mes[mesid]').forEach(element => {
            const id = Number(element.getAttribute('mesid'));
            const meta = chat[id]?.extra?.at_compression;
            if (!meta || element.classList.contains('at-compress')) return;

            // 让 ST 的通用样式别再插手这块
            element.classList.add('at-compress', 'smallSysMes');

            const target = element.querySelector('.mes_text');
            if (!(target instanceof HTMLElement)) return;
            target.textContent = '';

            const note = document.createElement('div');
            note.className = 'at-compress-note';
            note.textContent = `🗜️ 上下文压缩：${meta.messages} 条已摘要 · 原文 ${meta.archive}`;

            const details = document.createElement('details');
            details.className = 'at-compress-details';

            const summaryEl = document.createElement('summary');
            summaryEl.textContent = '展开摘要';

            const body = document.createElement('div');
            body.className = 'at-compress-body';
            renderSummary(body, String(meta.summary ?? ''));

            details.append(summaryEl, body);
            target.append(note, details);

            // 右上角删除按钮：删掉这条摘要消息，同时取消这次压缩
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'at-compress-remove';
            remove.title = '删除这条压缩摘要（下次请求不再用摘要替换）';
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
     * 删除一条压缩标记：消息删掉，压缩状态也清掉。
     * @param {number} id
     * @returns {Promise<void>}
     */
    async removeMarker(id) {
        const chat = this.context.chat;
        if (!Array.isArray(chat) || !chat[id]?.extra?.at_compression) return;

        const message = chat[id];
        this.setState(null);

        try {
            if (typeof this.context.deleteMessage === 'function') {
                await this.context.deleteMessage(id);
            } else {
                chat.splice(id, 1);
                this.context.printMessages?.();
            }
            globalThis.toastr?.info?.(
                `已删除压缩摘要（${message.extra.at_compression.messages ?? '?'} 条），原文仍在 ${message.extra.at_compression.archive ?? `${HISTORY_DIR}/`}`,
                '工作区',
            );
        } catch (error) {
            console.warn('[atelier] 删除压缩标记失败', error);
            globalThis.toastr?.error?.(`删除失败：${error?.message ?? error}`, '工作区');
        }
    }

    /**
     * 把原文按「楼层-分支.md」写进 /chat_history/。
     *
     * 和回顾共用一套命名：同一条消息被两边都归档时写的是同一个文件，
     * 不会出现两份重复的副本。
     *
     * @param {{message: any, index: number}[]} entries
     * @returns {string} 摘要里引用的路径（单条就是它，多条是首尾范围）
     */
    archiveOriginals(entries) {
        const fs = this.workspace.fs;
        fs.mkdirp(ARCHIVE_DIR);

        let first = '';
        let last = '';

        for (const { message, index } of entries) {
            if (!shouldArchive(message)) continue;

            const floor = index + 1;
            const path = archivePath(floor, branchOf(message));
            const text = renderArchiveEntry(message, floor, branchOf(message));

            if (!(fs.exists(path) && !fs.isDir(path) && fs.read(path) === text)) {
                fs.write(path, text, { kind: 'archive', source: 'compression' });
            }

            if (!first) first = path;
            last = path;
        }

        if (!first) return `${ARCHIVE_DIR}/`;
        return first === last ? first : `${first} ~ ${last}`;
    }

    /**
     * 让当前模型写摘要（静默生成，不进入聊天）。
     * @param {string} transcript
     * @param {string} [previous]
     * @returns {Promise<string>}
     */
    async generateSummary(transcript, previous = '') {
        const generate = this.context.generateQuietPrompt;
        if (typeof generate !== 'function') throw new Error('酒馆没有提供 generateQuietPrompt');

        const prompt = [
            previous ? `这是上一次的摘要，请在此基础上**更新**（补充新进展，把已经过时的条目改掉）：\n\n${previous}\n\n---\n` : '',
            SUMMARY_PROMPT,
            '',
            '对话记录：',
            '',
            transcript,
        ].join('\n');

        const result = await generate({ quietPrompt: prompt, removeReasoning: true });
        const text = String(result ?? '').trim();
        if (!text) throw new Error('摘要模型返回了空内容');
        return text;
    }

    /**
     * 在请求发出前替换消息。
     *
     * 只在 dryRun=false 时动手；指纹对不上就一条都不动。
     * @param {{chat?: any[], dryRun?: boolean}} data
     * @returns {void}
     */
    applyToPrompt(data) {
        if (!data || data.dryRun) return;
        if (!Array.isArray(data.chat)) return;

        const state = this.state;
        if (!state?.summary || !Array.isArray(state.hashes) || !state.hashes.length) return;

        const indices = matchIndices(data.chat, state.hashes);
        if (!indices) return;

        const note = `[上下文压缩] 更早的 ${state.messages ?? state.hashes.length} 条对话已压缩为下面的摘要。`
            + (state.archive ? ` 完整原文在 \`${state.archive}\`，需要细节就用 read 工具读它。` : '')
            + `\n\n${state.summary}`;

        const remove = new Set(indices);
        const anchor = indices[0];
        const role = data.chat[anchor - 1]?.role === 'assistant' ? 'user' : 'assistant';

        /** @type {any[]} */
        const output = [];
        let inserted = false;
        data.chat.forEach((message, index) => {
            if (remove.has(index)) {
                if (!inserted) {
                    output.push({ role, content: note });
                    inserted = true;
                }
                return;
            }
            output.push(message);
        });

        data.chat.length = 0;
        data.chat.push(...output);
    }
}

/**
 * 在请求数组里找出与指纹序列对应的连续消息。
 *
 * 跳过 system（世界书/作者注释都在里面，一条都不能动），
 * 只匹配 user / assistant / tool。任何一次对不上就返回 null。
 *
 * @param {any[]} messages
 * @param {string[]} hashes
 * @returns {number[]|null}
 */
export function matchIndices(messages, hashes) {
    /** @type {number[]} */
    const candidates = [];
    messages.forEach((message, index) => {
        if (!message) return;
        if (message.role === 'system') return;
        if (!['user', 'assistant', 'tool'].includes(message.role)) return;
        candidates.push(index);
    });

    if (candidates.length < hashes.length) return null;

    /** @type {number[]} */
    const matched = [];
    let cursor = 0;

    for (const index of candidates) {
        if (cursor >= hashes.length) break;
        const expected = hashes[cursor];
        const actual = hashText(messages[index]?.content ?? '');
        if (actual === expected) {
            matched.push(index);
            cursor += 1;
        } else if (matched.length) {
            return null; // 已经开始匹配却又断了 → 这段被动过，放弃
        }
    }

    return cursor === hashes.length ? matched : null;
}

/**
 * 阈值夹在 0.1–0.95 之间，默认 0.5。
 * @param {any} value
 * @returns {number}
 */
function sanitizeThreshold(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0.5;
    return Math.min(0.95, Math.max(0.1, number));
}

/**
 * 尾部保留条数夹在 2–40，默认 6。
 * @param {any} value
 * @returns {number}
 */
function sanitizeKeepLast(value) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) return 6;
    return Math.min(40, Math.max(2, number));
}
