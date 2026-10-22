/**
 * 工具调用链的折叠。
 *
 * 场景：一次生成里模型可能连续调好几次工具，聊天里会留下
 *   [assistant 正文] / [系统·工具调用] / [assistant 正文] / [系统·工具调用] …
 * 最后才是真正的回答。这些中间消息在回答出来之后就没必要占屏幕了。
 *
 * 做法（纯前端，不动 chat 数组）：
 *   - 找出"最后一条用户消息"到"最后一个工具调用消息"之间的所有消息；
 *   - 给它们加 `.at-chain-collapsed`（display:none）；
 *   - 在最终回答那条消息里插入一个胶囊按钮，点击展开/收起。
 *
 * 判定条件：最后一条消息必须是普通 assistant（不是工具调用、不是用户/系统），
 * 否则说明链还没走完，先不折叠。
 */

const CHIP_CLASS = 'at-chain-chip';
const COLLAPSED_CLASS = 'at-chain-collapsed';
const DEBOUNCE_MS = 120;

export class ToolChainCollapse {
    /**
     * @param {any} context getContext()（可以是 Proxy）
     */
    constructor(context) {
        this.context = context;
        /** @type {Set<string>} 用户手动展开过的链 */
        this.expanded = new Set();
        /** @type {any} */
        this.timer = null;
        /** @type {MutationObserver|null} */
        this.observer = null;

        this.schedule = this.schedule.bind(this);
        this.apply = this.apply.bind(this);
        this.onChatChanged = this.onChatChanged.bind(this);
    }

    /**
     * @returns {void}
     */
    install() {
        const ctx = this.context;
        const events = ctx?.eventTypes ?? {};
        const source = ctx?.eventSource;

        for (const name of ['GENERATION_ENDED', 'MESSAGE_RECEIVED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_DELETED']) {
            const type = events[name];
            if (type) source?.on?.(type, this.schedule);
        }
        if (events.CHAT_CHANGED) source?.on?.(events.CHAT_CHANGED, this.onChatChanged);

        const chat = document.getElementById('chat');
        if (chat instanceof HTMLElement) {
            this.observer = new MutationObserver(this.schedule);
            this.observer.observe(chat, { childList: true, subtree: true });
        }

        this.schedule();
    }

    /**
     * @returns {void}
     */
    destroy() {
        this.observer?.disconnect();
        this.observer = null;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        const ctx = this.context;
        const events = ctx?.eventTypes ?? {};
        const source = ctx?.eventSource;
        if (typeof source?.removeListener === 'function') {
            for (const name of ['GENERATION_ENDED', 'MESSAGE_RECEIVED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_DELETED']) {
                const type = events[name];
                if (type) source.removeListener(type, this.schedule);
            }
            if (events.CHAT_CHANGED) source.removeListener(events.CHAT_CHANGED, this.onChatChanged);
        }

        this.clearDom();
    }

    /**
     * @returns {void}
     */
    onChatChanged() {
        this.expanded.clear();
        this.clearDom();
        this.schedule();
    }

    /**
     * 合并短时间内的多次触发（流式输出时 DOM 变化非常频繁）。
     * @returns {void}
     */
    schedule() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.apply();
        }, DEBOUNCE_MS);
    }

    /**
     * 计算并应用折叠状态（整段聊天里所有"已完成"的工具链都折叠）。
     * @returns {void}
     */
    apply() {
        const ctx = this.context;
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : null;
        if (!chat || chat.length === 0) {
            this.clearDom();
            return;
        }

        // 生成过程中不动：等这一轮结束再折叠
        if (document.body?.dataset?.generating === 'true') return;

        const chains = this.collectChains(chat);
        if (!chains.length) {
            this.clearDom();
            return;
        }

        // 清掉不再属于任何链的胶囊
        const activeKeys = new Set(chains.map(chain => chain.key));
        document.querySelectorAll(`#chat .${CHIP_CLASS}`).forEach(chip => {
            if (chip instanceof HTMLElement && !activeKeys.has(chip.dataset.chain ?? '')) chip.remove();
        });

        // 需要隐藏的消息：未展开的链的中间消息
        /** @type {Set<number>} */
        const shouldHide = new Set();
        for (const chain of chains) {
            if (this.expanded.has(chain.key)) continue;
            for (const id of chain.intermediate) shouldHide.add(id);
        }

        document.querySelectorAll(`#chat .mes.${COLLAPSED_CLASS}`).forEach(element => {
            if (!(element instanceof HTMLElement)) return;
            const id = Number(element.getAttribute('mesid'));
            if (!shouldHide.has(id)) element.classList.remove(COLLAPSED_CLASS);
        });

        for (const id of shouldHide) {
            const element = this.findMessage(id);
            if (element) element.classList.add(COLLAPSED_CLASS);
        }

        for (const chain of chains) {
            const finalElement = this.findMessage(chain.final);
            if (!finalElement) continue;
            this.ensureChip(
                finalElement,
                chain.key,
                this.expanded.has(chain.key),
                chain.intermediate.length,
                chain.toolCount,
            );
        }
    }

    /**
     * 把聊天按"用户消息"切成回合，找出每个回合里已完成的工具链。
     * @param {any[]} chat
     * @returns {{key: string, start: number, final: number, intermediate: number[], toolCount: number}[]}
     */
    collectChains(chat) {
        /** @type {{key: string, start: number, final: number, intermediate: number[], toolCount: number}[]} */
        const chains = [];
        const chatId = String(this.context?.getCurrentChatId?.() ?? '');
        let start = 0;

        for (let i = 0; i <= chat.length; i++) {
            const atEnd = i === chat.length;
            if (!atEnd && !chat[i]?.is_user) continue;

            const chain = this.buildChain(chat, start, i - 1, chatId);
            if (chain) chains.push(chain);
            start = i + 1;
        }

        return chains;
    }

    /**
     * @param {any[]} chat
     * @param {number} start
     * @param {number} end
     * @param {string} chatId
     * @returns {{key: string, start: number, final: number, intermediate: number[], toolCount: number}|null}
     */
    buildChain(chat, start, end, chatId) {
        if (end <= start) return null;

        let lastTool = -1;
        for (let i = end; i >= start; i--) {
            if (hasToolInvocations(chat[i])) {
                lastTool = i;
                break;
            }
        }

        // 没有工具调用，或最后一个消息还是工具调用（链还没走完）
        if (lastTool < 0 || lastTool === end) return null;

        const finalMessage = chat[end];
        if (!finalMessage || finalMessage.is_user || finalMessage.is_system) return null;

        /** @type {number[]} */
        const intermediate = [];
        for (let i = start; i <= lastTool; i++) {
            if (!chat[i]?.is_user) intermediate.push(i);
        }
        if (!intermediate.length) return null;

        return {
            key: `${chatId}:${start}:${lastTool}:${end}`,
            start,
            final: end,
            intermediate,
            toolCount: intermediate.filter(index => hasToolInvocations(chat[index])).length,
        };
    }

    /**
     * @param {number} mesid
     * @returns {HTMLElement|null}
     */
    findMessage(mesid) {
        const element = document.querySelector(`#chat .mes[mesid="${mesid}"]`);
        return element instanceof HTMLElement ? element : null;
    }

    /**
     * @param {HTMLElement} messageElement
     * @param {string} chainKey
     * @param {boolean} isExpanded
     * @param {number} count
     * @param {number} toolCount
     * @returns {void}
     */
    ensureChip(messageElement, chainKey, isExpanded, count, toolCount) {
        const block = messageElement.querySelector('.mes_block');
        if (!(block instanceof HTMLElement)) return;

        let chip = block.querySelector(`.${CHIP_CLASS}`);
        if (chip instanceof HTMLElement && chip.dataset.chain !== chainKey) {
            chip.remove();
            chip = null;
        }

        if (!(chip instanceof HTMLElement)) {
            chip = document.createElement('div');
            chip.className = CHIP_CLASS;
            chip.setAttribute('role', 'button');
            chip.tabIndex = 0;
            chip.dataset.chain = chainKey;
            chip.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                this.toggle(chainKey);
            });
            chip.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    this.toggle(chainKey);
                }
            });

            const anchor = block.querySelector('.mes_text');
            if (anchor) block.insertBefore(chip, anchor);
            else block.append(chip);
        }

        chip.classList.toggle('is-expanded', isExpanded);
        chip.title = isExpanded ? '点击收起中间步骤' : '点击展开中间步骤';

        const icon = document.createElement('span');
        icon.className = 'at-chain-icon';
        icon.textContent = isExpanded ? '▾' : '▸';

        const text = document.createElement('span');
        text.className = 'at-chain-text';
        text.textContent = `${isExpanded ? '收起' : '已折叠'} ${count} 条中间消息 · ${toolCount} 次工具调用`;

        chip.replaceChildren(icon, text);
    }

    /**
     * @param {string} chainKey
     * @returns {void}
     */
    toggle(chainKey) {
        if (this.expanded.has(chainKey)) this.expanded.delete(chainKey);
        else this.expanded.add(chainKey);
        this.apply();
    }

    /**
     * @returns {void}
     */
    clearDom() {
        document.querySelectorAll(`#chat .mes.${COLLAPSED_CLASS}`).forEach(element => {
            element.classList.remove(COLLAPSED_CLASS);
            if (element instanceof HTMLElement) delete element.dataset.cwChain;
        });
        document.querySelectorAll(`#chat .${CHIP_CLASS}`).forEach(chip => chip.remove());
    }
}

/**
 * @param {any} message
 * @returns {boolean}
 */
function hasToolInvocations(message) {
    return Array.isArray(message?.extra?.tool_invocations) && message.extra.tool_invocations.length > 0;
}
