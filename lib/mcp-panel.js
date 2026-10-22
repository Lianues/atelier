/**
 * 「MCP 服务」面板。
 *
 * 主面板只管列表和开关（连接 / 断开 / 编辑 / 删除 / 添加）；
 * 具体配置——名称、地址、传输方式、自定义请求头——在独立的小弹窗里改。
 *
 * 只做网络传输（Streamable HTTP / 旧版 SSE），不做 stdio：浏览器起不了本地进程。
 * 服务器列表存在 extension_settings['atelier'].mcpServers 里。
 *
 * 浏览器直连需要对方放行 CORS，报 Failed to fetch 基本都是这个原因。
 */

import { McpClient, isTransportMismatch, normalizeServer } from './mcp-client.js';
import { McpToolRegistry } from './mcp-tools.js';

const SETTINGS_KEY = 'atelier';

export class McpPanel {
    /**
     * @param {any} context getContext()
     */
    constructor(context) {
        this.context = context;
        this.registry = new McpToolRegistry(context);
        this.panel = /** @type {HTMLElement|null} */ (null);
        this.editor = /** @type {HTMLElement|null} */ (null);
        /** @type {Map<string, McpClient>} */
        this.clients = new Map();
        /** @type {Map<string, {state: string, message?: string, tools?: number}>} */
        this.status = new Map();
        /** 正在编辑的服务器 id（null = 新建） */
        this.editing = /** @type {string|null} */ (null);
        /** 拖拽中的偏移量 */
        this.drag = /** @type {{dx: number, dy: number}|null} */ (null);
    }

    /**
     * @returns {Record<string, any>}
     */
    get settings() {
        const store = this.context.extensionSettings;
        if (!store[SETTINGS_KEY] || typeof store[SETTINGS_KEY] !== 'object') store[SETTINGS_KEY] = {};
        if (!Array.isArray(store[SETTINGS_KEY].mcpServers)) store[SETTINGS_KEY].mcpServers = [];
        return store[SETTINGS_KEY];
    }

    /**
     * @returns {ReturnType<typeof normalizeServer>[]}
     */
    get servers() {
        return this.settings.mcpServers.map(entry => normalizeServer(entry)).filter(Boolean);
    }

    /**
     * @returns {void}
     */
    save() {
        this.context.saveSettingsDebounced?.();
    }

    /**
     * @returns {void}
     */
    mount() {
        if (this.panel) return;

        const panel = document.createElement('div');
        panel.className = 'mcp-panel';
        panel.id = 'mcp-panel';
        panel.innerHTML = `
            <div class="mcp-header">
                <span class="mcp-title">MCP 服务</span>
                <span class="mcp-spacer"></span>
                <button type="button" class="menu_button" data-action="new">添加</button>
                <button type="button" class="mcp-icon-btn" data-action="close" title="关闭">✕</button>
            </div>
            <div class="mcp-list" data-role="list"></div>
            <div class="mcp-footer">
                <span class="mcp-hint" data-role="hint">Streamable HTTP 或旧版 HTTP+SSE；需要服务端放行 CORS</span>
                <span class="mcp-spacer"></span>
                <button type="button" class="menu_button" data-action="connect-all">全部连接</button>
                <button type="button" class="menu_button" data-action="disconnect-all">全部断开</button>
            </div>
        `;
        document.body.append(panel);
        this.panel = panel;

        // 拖拽：按住标题栏移动，位置记到设置里
        panel.querySelector('.mcp-header')?.addEventListener('pointerdown', event => this.startDrag(event));
        this.applyGeometry();

        // 手机旋转 / 软键盘弹起：重新收进可视区，别被顶栏吃掉
        this.onWindowResize = () => this.applyGeometry();
        window.addEventListener('resize', this.onWindowResize);
        window.visualViewport?.addEventListener('resize', this.onWindowResize);

        panel.addEventListener('click', event => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;

            const action = target.closest('[data-action]');
            if (!(action instanceof HTMLElement)) return;

            const serverId = action.closest('[data-server]')?.getAttribute('data-server') ?? '';
            void this.handleAction(action.dataset.action ?? '', serverId);
        });
    }

    /**
     * @returns {void}
     */
    toggle() {
        if (!this.panel || !this.panel.classList.contains('open')) this.open();
        else this.close();
    }

    /**
     * 把面板放回可视区。
     *
     * 手机竖屏时顶部要给酒馆顶栏让位，否则标题栏会被挡住；
     * 面板宽度也按视口收窄，避免右侧跑到屏幕外。
     *
     * @returns {void}
     */
    applyGeometry() {
        if (!this.panel) return;

        const margin = 8;
        const bar = document.getElementById('top-bar');
        const barBottom = bar ? Math.round(bar.getBoundingClientRect().bottom) : 0;
        const minY = Math.max(margin, barBottom + 4);

        const width = this.panel.offsetWidth || 600;
        const maxW = Math.max(240, window.innerWidth - margin * 2);
        if (width > maxW) {
            this.panel.style.width = `${maxW}px`;
            this.panel.style.maxWidth = `${maxW}px`;
        }

        const geometry = this.settings.mcpGeometry;
        const wantX = geometry && typeof geometry.x === 'number' ? geometry.x : window.innerWidth - width - margin;
        const wantY = geometry && typeof geometry.y === 'number' ? geometry.y : minY;

        const x = Math.min(Math.max(wantX, margin), Math.max(margin, window.innerWidth - width - margin));
        const vh = Math.min(window.innerHeight, Math.round(window.visualViewport?.height ?? window.innerHeight));
        const y = Math.min(Math.max(wantY, minY), Math.max(minY, vh - 120));

        this.panel.style.left = `${Math.round(x)}px`;
        this.panel.style.top = `${Math.round(y)}px`;
        this.panel.style.right = 'auto';
    }

    /**
     * @param {PointerEvent} event
     * @returns {void}
     */
    startDrag(event) {
        const panel = this.panel;
        if (!panel) return;

        // 标题栏上的按钮不触发拖拽
        if (event.target instanceof Element && event.target.closest('button, input, select')) return;
        if (event.button !== 0) return;

        const rect = panel.getBoundingClientRect();
        this.drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };

        panel.style.left = `${rect.left}px`;
        panel.style.top = `${rect.top}px`;
        panel.style.right = 'auto';

        // 触屏：标题栏捕获指针 + CSS touch-action:none，否则滑动手势会被当成页面滚动打断拖拽
        const header = event.currentTarget;
        if (header instanceof HTMLElement && typeof header.setPointerCapture === 'function') {
            try {
                header.setPointerCapture(event.pointerId);
            } catch {
                // 忽略不支持捕获的情况
            }
        }

        document.addEventListener('pointermove', this.onDragMove);
        document.addEventListener('pointerup', this.onDragEnd, { once: true });
        document.addEventListener('pointercancel', this.onDragEnd, { once: true });
        event.preventDefault();
    }

    /**
     * @param {PointerEvent} event
     * @returns {void}
     */
    onDragMove = (event) => {
        const panel = this.panel;
        if (!this.drag || !panel) return;

        const margin = 8;
        const bar = document.getElementById('top-bar');
        const minY = Math.max(margin, (bar ? bar.getBoundingClientRect().bottom : 0) + 4);
        const maxX = Math.max(margin, window.innerWidth - panel.offsetWidth - margin);
        const maxY = Math.max(minY, window.innerHeight - panel.offsetHeight - margin);
        const x = Math.min(Math.max(margin, event.clientX - this.drag.dx), maxX);
        const y = Math.min(Math.max(minY, event.clientY - this.drag.dy), maxY);

        panel.style.left = `${Math.round(x)}px`;
        panel.style.top = `${Math.round(y)}px`;
    };

    /**
     * @returns {void}
     */
    onDragEnd = () => {
        document.removeEventListener('pointermove', this.onDragMove);
        document.removeEventListener('pointercancel', this.onDragEnd);
        if (!this.panel) return;

        this.settings.mcpGeometry = {
            x: Math.round(parseFloat(this.panel.style.left) || 0),
            y: Math.round(parseFloat(this.panel.style.top) || 0),
        };
        this.save();
        this.drag = null;
    };

    /**
     * @returns {void}
     */
    open() {
        this.mount();
        this.panel?.classList.add('open');
        this.render();
    }

    /**
     * @returns {void}
     */
    close() {
        this.panel?.classList.remove('open');
    }

    /**
     * @param {string} action
     * @param {string} serverId
     * @returns {Promise<void>}
     */
    async handleAction(action, serverId) {
        switch (action) {
            case 'close':
                this.close();
                break;
            case 'new':
                this.openEditor(null);
                break;
            case 'edit':
                this.openEditor(serverId);
                break;
            case 'connect':
                await this.connect(serverId);
                break;
            case 'disconnect':
                this.disconnect(serverId);
                this.render();
                break;
            case 'remove':
                await this.removeServer(serverId);
                break;
            case 'connect-all':
                await this.connectAll();
                break;
            case 'disconnect-all':
                for (const server of this.servers) this.disconnect(server.id);
                this.render();
                break;
            default:
                break;
        }
    }

    /**
     * @param {string} serverId
     * @returns {Promise<void>}
     */
    async removeServer(serverId) {
        const server = this.servers.find(entry => entry.id === serverId);
        if (!server) return;
        if (typeof this.context.Popup?.show?.confirm === 'function') {
            const ok = await this.context.Popup.show.confirm('删除 MCP 服务器', `确定删除「${server.name}」？`);
            if (ok !== this.context.POPUP_RESULT?.AFFIRMATIVE) return;
        }

        this.disconnect(serverId);
        this.settings.mcpServers = this.settings.mcpServers
            .filter(entry => normalizeServer(entry)?.id !== serverId);
        this.save();
        this.render();
    }

    // -----------------------------------------------------------------------
    // 配置弹窗
    // -----------------------------------------------------------------------

    /**
     * @param {string|null} serverId
     * @returns {void}
     */
    openEditor(serverId) {
        this.mountEditor();
        const editor = this.editor;
        if (!editor) return;

        this.editing = serverId;
        const server = serverId ? this.servers.find(entry => entry.id === serverId) : null;

        setInput(editor, 'edit-name', server?.name ?? '');
        setInput(editor, 'edit-url', server?.url ?? '');
        setSelect(editor, 'edit-transport', server?.transport ?? 'http');
        setError(editor, '');

        const list = editor.querySelector('[data-role="headers"]');
        if (list instanceof HTMLElement) {
            list.innerHTML = '';
            const headers = server?.headers ?? {};
            for (const [key, value] of Object.entries(headers)) this.addHeaderRow(key, value);
        }

        editor.classList.add('open');
        /** @type {HTMLInputElement|null} */ (editor.querySelector('[data-role="edit-url"]'))?.focus();
    }

    /**
     * @returns {void}
     */
    mountEditor() {
        if (this.editor) return;

        const modal = document.createElement('div');
        modal.className = 'mcp-modal';
        modal.id = 'mcp-editor';
        modal.innerHTML = `
            <div class="mcp-modal-box">
                <div class="mcp-modal-head">
                    <span class="mcp-modal-title" data-role="edit-title">服务器配置</span>
                    <span class="mcp-spacer"></span>
                    <button type="button" class="mcp-icon-btn" data-action="editor-close" title="关闭">✕</button>
                </div>
                <div class="mcp-form">
                    <label class="mcp-field">
                        <span>名称</span>
                        <input type="text" class="text_pole" data-role="edit-name" placeholder="留空就用域名" />
                    </label>
                    <label class="mcp-field">
                        <span>地址</span>
                        <input type="text" class="text_pole" data-role="edit-url" placeholder="https://example.com/mcp" />
                    </label>
                    <label class="mcp-field">
                        <span>传输</span>
                        <select class="text_pole" data-role="edit-transport">
                            <option value="http">Streamable HTTP</option>
                            <option value="sse">HTTP + SSE（旧版）</option>
                        </select>
                    </label>
                    <div class="mcp-headers">
                        <div class="mcp-headers-head">
                            <span>自定义请求头</span>
                            <span class="mcp-spacer"></span>
                            <button type="button" class="menu_button" data-action="add-header">加一行</button>
                        </div>
                        <div class="mcp-headers-list" data-role="headers"></div>
                    </div>
                </div>
                <div class="mcp-modal-foot">
                    <span class="mcp-error" data-role="edit-error"></span>
                    <span class="mcp-spacer"></span>
                    <button type="button" class="menu_button" data-action="editor-close">取消</button>
                    <button type="button" class="menu_button" data-action="editor-save">保存</button>
                </div>
            </div>
        `;
        document.body.append(modal);
        this.editor = modal;

        modal.addEventListener('click', event => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;

            // 点遮罩关闭
            if (target === modal) {
                modal.classList.remove('open');
                return;
            }

            const action = target.closest('[data-action]');
            if (!(action instanceof HTMLElement)) return;

            switch (action.dataset.action) {
                case 'editor-close':
                    modal.classList.remove('open');
                    break;
                case 'add-header':
                    this.addHeaderRow('', '');
                    break;
                case 'remove-header':
                    action.closest('.mcp-header-row')?.remove();
                    break;
                case 'editor-save':
                    this.saveEditor();
                    break;
                default:
                    break;
            }
        });
    }

    /**
     * @param {string} key
     * @param {string} value
     * @returns {void}
     */
    addHeaderRow(key, value) {
        const list = this.editor?.querySelector('[data-role="headers"]');
        if (!(list instanceof HTMLElement)) return;

        const row = document.createElement('div');
        row.className = 'mcp-header-row';

        const keyInput = document.createElement('input');
        keyInput.type = 'text';
        keyInput.className = 'text_pole mcp-header-key';
        keyInput.placeholder = 'Header 名，比如 Authorization';
        keyInput.value = key;

        const valueInput = document.createElement('input');
        valueInput.type = 'text';
        valueInput.className = 'text_pole mcp-header-value';
        valueInput.placeholder = '值，比如 Bearer xxx';
        valueInput.value = value;

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'mcp-icon-btn';
        remove.dataset.action = 'remove-header';
        remove.textContent = '✕';
        remove.title = '删掉这一行';

        row.append(keyInput, valueInput, remove);
        list.append(row);
    }

    /**
     * @returns {void}
     */
    saveEditor() {
        const editor = this.editor;
        if (!editor) return;

        const headers = {};
        for (const row of editor.querySelectorAll('.mcp-header-row')) {
            const key = /** @type {HTMLInputElement|null} */ (row.querySelector('.mcp-header-key'))?.value.trim() ?? '';
            const value = /** @type {HTMLInputElement|null} */ (row.querySelector('.mcp-header-value'))?.value.trim() ?? '';
            if (key) headers[key] = value;
        }

        const server = normalizeServer({
            name: getInput(editor, 'edit-name'),
            url: getInput(editor, 'edit-url'),
            transport: getSelect(editor, 'edit-transport'),
            headers,
        });

        if (!server) {
            setError(editor, '地址必须是 http(s) 开头');
            return;
        }

        const others = this.servers.filter(entry => entry.id !== this.editing);
        if (others.some(entry => entry.id === server.id)) {
            setError(editor, '这个地址 + 传输方式已经加过了');
            return;
        }

        if (this.editing) this.disconnect(this.editing);

        const next = this.settings.mcpServers
            .map(entry => normalizeServer(entry))
            .filter(entry => entry && entry.id !== this.editing);
        next.push(server);
        this.settings.mcpServers = next;
        this.save();

        editor.classList.remove('open');
        this.editing = null;
        this.render();
        void this.connect(server.id);
    }

    // -----------------------------------------------------------------------
    // 连接管理
    // -----------------------------------------------------------------------

    /**
     * @param {string} serverId
     * @returns {Promise<void>}
     */
    async connect(serverId) {
        const server = this.servers.find(entry => entry.id === serverId);
        if (!server) return;

        this.disconnect(serverId);
        this.status.set(serverId, { state: 'connecting' });
        this.render();

        const client = new McpClient({
            url: server.url,
            transport: server.transport,
            name: server.name,
            headers: server.headers,
        });
        this.clients.set(serverId, client);

        try {
            const { tools } = await client.connect();
            const names = this.registry.registerServer(server, client, tools);
            this.status.set(serverId, { state: 'connected', tools: names.length });
            toastr.success(`${server.name}：${names.length} 个工具`, 'MCP');
        } catch (error) {
            client.close();
            this.clients.delete(serverId);
            this.status.set(serverId, { state: 'error', message: String(error?.message ?? error) });

            const hint = server.transport === 'http' && isTransportMismatch(error)
                ? '（这个服务端可能只支持旧版 HTTP + SSE，把传输改成 SSE 再试）'
                : '';
            toastr.error(`${server.name} 连接失败：${error?.message ?? error}${hint}`, 'MCP');
        }

        this.render();
    }

    /**
     * @param {string} serverId
     * @returns {void}
     */
    disconnect(serverId) {
        const client = this.clients.get(serverId);
        if (client) {
            client.close();
            this.clients.delete(serverId);
        }
        this.registry.unregisterServer(serverId);
        this.status.delete(serverId);
    }

    /**
     * @returns {Promise<void>}
     */
    async connectAll() {
        for (const server of this.servers) {
            if (this.clients.get(server.id)?.connected) continue;
            await this.connect(server.id);
        }
    }

    /**
     * @returns {void}
     */
    destroy() {
        for (const serverId of [...this.clients.keys()]) this.disconnect(serverId);
        if (this.onWindowResize) {
            window.removeEventListener('resize', this.onWindowResize);
            window.visualViewport?.removeEventListener('resize', this.onWindowResize);
            this.onWindowResize = null;
        }
        this.panel?.remove();
        this.panel = null;
        this.editor?.remove();
        this.editor = null;
    }

    // -----------------------------------------------------------------------
    // 渲染
    // -----------------------------------------------------------------------

    /**
     * @returns {void}
     */
    render() {
        const list = this.panel?.querySelector('[data-role="list"]');
        if (!(list instanceof HTMLElement)) return;

        const servers = this.servers;
        if (!servers.length) {
            list.innerHTML = '<div class="mcp-empty">还没有服务器。点右上角「添加」，填一个 MCP 端点地址。</div>';
            return;
        }

        list.innerHTML = '';
        for (const server of servers) {
            const status = this.status.get(server.id) ?? { state: 'idle' };
            const row = document.createElement('div');
            row.className = 'mcp-row';
            row.dataset.server = server.id;
            row.dataset.state = status.state;

            const main = document.createElement('div');
            main.className = 'mcp-row-main';

            const name = document.createElement('div');
            name.className = 'mcp-row-name';
            name.textContent = server.name;

            const url = document.createElement('div');
            url.className = 'mcp-row-url';
            const headerCount = Object.keys(server.headers ?? {}).length;
            url.textContent = `${server.transport === 'sse' ? 'SSE（旧版）' : 'Streamable HTTP'} · ${server.url}`
                + (headerCount ? ` · ${headerCount} 个请求头` : '');
            url.title = server.url;

            main.append(name, url);

            const state = document.createElement('span');
            state.className = 'mcp-state';
            state.textContent = describeState(status);
            if (status.message) state.title = status.message;

            const actions = document.createElement('div');
            actions.className = 'mcp-row-actions';

            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'menu_button';
            toggle.dataset.action = status.state === 'connected' ? 'disconnect' : 'connect';
            toggle.textContent = status.state === 'connected' ? '断开' : (status.state === 'connecting' ? '连接中…' : '连接');

            const edit = document.createElement('button');
            edit.type = 'button';
            edit.className = 'menu_button';
            edit.dataset.action = 'edit';
            edit.textContent = '编辑';

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'menu_button';
            remove.dataset.action = 'remove';
            remove.textContent = '删除';

            actions.append(toggle, edit, remove);
            row.append(main, state, actions);
            list.append(row);
        }
    }

    /**
     * @returns {{servers: number, connected: number, tools: number}}
     */
    stats() {
        const connected = [...this.clients.values()].filter(client => client.connected).length;
        return { servers: this.servers.length, connected, tools: this.registry.count() };
    }
}

/**
 * @param {HTMLElement} root
 * @param {string} role
 * @returns {string}
 */
function getInput(root, role) {
    const input = /** @type {HTMLInputElement|null} */ (root.querySelector(`[data-role="${role}"]`));
    return input?.value ?? '';
}

/**
 * @param {HTMLElement} root
 * @param {string} role
 * @param {string} value
 * @returns {void}
 */
function setInput(root, role, value) {
    const input = /** @type {HTMLInputElement|null} */ (root.querySelector(`[data-role="${role}"]`));
    if (input) input.value = value;
}

/**
 * @param {HTMLElement} root
 * @param {string} role
 * @returns {string}
 */
function getSelect(root, role) {
    const select = /** @type {HTMLSelectElement|null} */ (root.querySelector(`[data-role="${role}"]`));
    return select?.value ?? 'http';
}

/**
 * @param {HTMLElement} root
 * @param {string} role
 * @param {string} value
 * @returns {void}
 */
function setSelect(root, role, value) {
    const select = /** @type {HTMLSelectElement|null} */ (root.querySelector(`[data-role="${role}"]`));
    if (select) select.value = value;
}

/**
 * @param {HTMLElement} root
 * @param {string} text
 * @returns {void}
 */
function setError(root, text) {
    const element = root.querySelector('[data-role="edit-error"]');
    if (element instanceof HTMLElement) element.textContent = text;
}

/**
 * @param {{state: string, tools?: number, message?: string}} status
 * @returns {string}
 */
function describeState(status) {
    switch (status.state) {
        case 'connected':
            return `已连接 · ${status.tools ?? 0} 个工具`;
        case 'connecting':
            return '连接中…';
        case 'error':
            return `失败：${(status.message ?? '').slice(0, 40)}`;
        default:
            return '未连接';
    }
}
