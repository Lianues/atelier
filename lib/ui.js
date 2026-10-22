/**
 * 工作区面板 UI。
 *
 * 一个可拖拽 / 可缩放的浮动面板：
 *   左侧目录树，右侧编辑器，顶部工具栏（世界书同步 / 写回 / 文件操作）。
 * 所有内容都来自 Atelier，面板本身不持有业务状态。
 */

import { formatBytes, normalizePath } from './vfs.js';
import { BOOK_ROOT, HISTORY_DIR } from './workspace.js';
import { describeToolCalling } from './tools.js';
import { buildZip, collectExportPaths, downloadBlob, normalizeZipPath, readZipEntries, readZipMeta, safeFileName } from './zip.js';

/**
 * 选本地文件（可多选）。
 * @param {string} accept
 * @param {boolean} multiple
 * @returns {Promise<File[]>}
 */
function pickFiles(accept, multiple = true) {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.multiple = multiple;
        input.style.display = 'none';
        document.body.append(input);
        input.addEventListener('change', () => {
            const files = [...(input.files ?? [])];
            input.remove();
            resolve(files);
        }, { once: true });
        input.click();
    });
}

const SETTINGS_KEY = 'atelier';

const DEFAULT_GEOMETRY = { x: null, y: null, w: 620, h: 460 };

export class WorkspaceUI {
    /**
     * @param {any} context getContext()
     * @param {import('./workspace.js').Atelier} workspace
     * @param {{autoSync?: import('./auto-sync.js').AutoSync|null}} [options]
     */
    constructor(context, workspace, options = {}) {
        this.context = context;
        this.workspace = workspace;
        this.autoSync = options.autoSync ?? null;
        this.compression = options.compression ?? null;
        this.review = options.review ?? null;
        this.panel = /** @type {HTMLElement|null} */ (null);
        this.tree = /** @type {HTMLElement|null} */ (null);
        this.editor = /** @type {HTMLTextAreaElement|null} */ (null);
        this.currentPath = '';
        this.selectedPath = '';
        this.dirty = false;
        this.expanded = new Set(['/', BOOK_ROOT]);
        this.busy = false;
        this.lostWarned = false;
        this.unsubscribe = null;
        this.resizeObserver = null;
        this.drag = null;
    }

    /**
     * @returns {Record<string, any>}
     */
    get settings() {
        const settings = this.context.extensionSettings;
        if (!settings[SETTINGS_KEY] || typeof settings[SETTINGS_KEY] !== 'object') {
            settings[SETTINGS_KEY] = { ...DEFAULT_GEOMETRY };
        }
        return settings[SETTINGS_KEY];
    }

    /**
     * 构建并挂载面板。
     * @returns {void}
     */
    mount() {
        if (this.panel) return;

        const panel = document.createElement('div');
        panel.id = 'at-panel';
        panel.className = 'at-panel';
        panel.innerHTML = `
            <div class="at-header" data-role="drag">
                <span class="at-title">Atelier</span>
                <span class="at-scope" data-role="scope"></span>
                <button type="button" class="at-icon-btn" data-action="close" title="关闭">✕</button>
            </div>
            <div class="at-toolbar">
                <button type="button" class="menu_button at-btn" data-action="sync" title="把当前聊天启用的世界书导入为文件（只补缺失）">同步世界书</button>
                <button type="button" class="menu_button at-btn" data-action="rebuild" title="删除并重建世界书目录（会覆盖手改内容）">重建</button>
                <button type="button" class="menu_button at-btn" data-action="apply" title="把工作区文件写回 SillyTavern 世界书">写回世界书</button>
                <label class="at-auto-sync" title="打开聊天 / 世界书变动时，自动把启用的世界书补进工作区（只补缺失，不覆盖已有文件）">
                    <input type="checkbox" data-role="auto-sync" />
                    <span>自动同步</span>
                </label>
                <button type="button" class="menu_button at-btn" data-action="features" title="上下文压缩 / 自我总结的开关和参数">功能</button>
                <span class="at-spacer"></span>
                <button type="button" class="menu_button at-btn" data-action="export" title="导出选中项为 ZIP（不选则导出整个工作区）">导出</button>
                <button type="button" class="menu_button at-btn" data-action="import" title="导入 ZIP 或文件（散装文件放进当前选中的目录）">导入</button>
            </div>
            <div class="at-features" data-role="features">
                <div class="at-feature">
                    <label class="at-check" title="生成结束后自动把较早的对话压成摘要，原文归档到 /chat_history/">
                        <input type="checkbox" data-role="set-compression" />
                        上下文压缩
                    </label>
                    <label class="at-mini" title="占上下文窗口的比例，超过就压">阈值
                        <input type="number" class="text_pole" step="0.05" min="0.1" max="0.95" data-role="set-threshold" />
                    </label>
                    <label class="at-mini" title="最近多少条消息原样保留">保留尾部
                        <input type="number" class="text_pole" min="2" max="40" data-role="set-keeplast" />
                    </label>
                    <button type="button" class="menu_button at-btn" data-action="compress" title="立刻压一次（不受开关影响）">立即压缩</button>
                </div>
                <div class="at-feature">
                    <label class="at-check" title="攒够一定回合或工具调用后，静默回顾对话并把值得沉淀的内容写进 /记忆">
                        <input type="checkbox" data-role="set-review" />
                        自我总结
                    </label>
                    <label class="at-mini" title="用户发言多少轮触发一次">回合
                        <input type="number" class="text_pole" min="2" max="200" data-role="set-turns" />
                    </label>
                    <label class="at-mini" title="工具调用多少轮触发一次">工具轮
                        <input type="number" class="text_pole" min="2" max="200" data-role="set-toolrounds" />
                    </label>
                    <button type="button" class="menu_button at-btn" data-action="review" title="立刻回顾一次（不受开关影响）">立即回顾</button>
                </div>
                <div class="at-feature at-feature-helpbar">
                    <span class="at-help-hint">两个功能默认关闭，勾选后才会自动运行</span>
                    <span class="at-spacer"></span>
                    <button type="button" class="menu_button at-btn" data-action="features-help" title="这两个功能在做什么，参数怎么调">说明</button>
                </div>
                <div class="at-help" data-role="features-help" hidden>
                    <p class="at-help-title">上下文压缩</p>
                    <p>把较早的对话压成一条摘要，<b>只改发给模型的内容</b>，不动聊天记录。</p>
                    <ul>
                        <li><b>阈值 0.5</b>：聊天 token 超过上下文窗口的 50% 才自动压。调大 = 压得更晚（省事但更容易爆窗）；调小 = 更早压（摘要更勤，细节更早变二手）。</li>
                        <li><b>保留尾部 6</b>：最近 6 条消息原样保留，永不参与压缩。调大 = 保留更多原文，能压的范围更小。</li>
                        <li>被压的原文按楼层写进 <code>/chat_history/&lt;楼层&gt;-&lt;分支&gt;.md</code>，摘要里带首尾路径；模型需要细节时会自己 <code>read</code> 回来。</li>
                        <li>聊天里会留一个虚线折叠块，点「展开摘要」能看全文。</li>
                        <li>若那几条消息被你编辑过（指纹对不上），这一次直接跳过，宁可不压也不换错。</li>
                        <li><b>立即压缩</b>不受开关影响，任何时候都能手动压一次。</li>
                    </ul>

                    <p class="at-help-title">自我总结</p>
                    <p>攒够轮次后静默回看最近的对话，把值得长期保留的内容写进 <code>/记忆/</code>。</p>
                    <ul>
                        <li><b>回合 10</b>：你每发 10 条消息触发一次。调小 = 总结更勤。</li>
                        <li><b>工具轮 10</b>：工具调用满 10 轮触发一次（同一轮里几个并行调用算 1 轮）。</li>
                        <li>写进 <code>用户偏好.md</code>／<code>世界设定.md</code>／<code>文风.md</code>／<code>待确认.md</code>，重复条目自动跳过。</li>
    <li>被总结的消息原文会按 <code>/chat_history/&lt;楼层&gt;-&lt;分支&gt;.md</code> 存一份（工具调用也存）。</li>
                        <li><b>只写 <code>/记忆</code></b>，永远不碰 <code>/world_book</code> —— 世界书会自动写回酒馆，不能让猜测性的总结去改。</li>
                        <li><b>立即回顾</b>同样不受开关影响。</li>
                    </ul>
                </div>
            </div>
            <div class="at-alert" data-role="alert" hidden>
                <span class="at-alert-text" data-role="alert-text"></span>
                <button type="button" class="menu_button at-btn" data-action="enable-tools">启用函数调用</button>
            </div>
            <div class="at-body">
                <div class="at-tree" data-role="tree"></div>
                <div class="at-main">
                    <div class="at-filebar">
                        <span class="at-path" data-role="path">未选择文件</span>
                        <span class="at-dirty" data-role="dirty"></span>
                        <button type="button" class="menu_button at-btn" data-action="new-file" title="新建文件">新建</button>
                        <button type="button" class="menu_button at-btn" data-action="rename" title="重命名（输入新路径，也可以换目录）">重命名</button>
                        <button type="button" class="menu_button at-btn" data-action="move" title="移动到另一个目录（文件名不变）">移动</button>
                        <button type="button" class="menu_button at-btn" data-action="delete" title="删除选中的文件或目录">删除</button>
                        <button type="button" class="menu_button at-btn at-save" data-action="save" disabled>保存</button>
                    </div>
                    <textarea class="at-editor" data-role="editor" spellcheck="false" placeholder="从左侧选择一个文件，或点「新建」"></textarea>
                </div>
            </div>
            <div class="at-footer">
                <span data-role="stats"></span>
                <span data-role="tool-state" class="at-chip"></span>
            </div>
        `;

        document.body.append(panel);
        this.panel = panel;
        this.tree = panel.querySelector('[data-role="tree"]');
        this.editor = panel.querySelector('[data-role="editor"]');

        this.applyGeometry();
        this.bindEvents();
        this.syncFeatureControls();

        // 手机旋转 / 软键盘弹起 / 窗口缩放：把面板重新收回可视区
        this.onWindowResize = () => this.applyGeometry();
        window.addEventListener('resize', this.onWindowResize);
        window.visualViewport?.addEventListener('resize', this.onWindowResize);

        if (this.settings.showFeatures) {
            panel.querySelector('[data-role="features"]')?.classList.add('open');
        }

        this.unsubscribe = this.workspace.onChange(() => {
            void this.refresh({ keepEditor: true });
        });

        this.resizeObserver = new ResizeObserver(() => this.persistGeometry());
        this.resizeObserver.observe(panel);
    }

    /**
     * @returns {void}
     */
    destroy() {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        if (this.onWindowResize) {
            window.removeEventListener('resize', this.onWindowResize);
            window.visualViewport?.removeEventListener('resize', this.onWindowResize);
            this.onWindowResize = null;
        }
        this.panel?.remove();
        this.panel = null;
        this.tree = null;
        this.editor = null;
    }

    /**
     * @returns {Promise<void>}
     */
    async open() {
        this.mount();
        if (!this.panel) return;

        // 面板不记住"上次开着"：每次都从关闭状态开始，和 MCP 面板一致
        this.panel.classList.add('open');

        try {
            await this.workspace.ensure();
        } catch (error) {
            console.warn('[atelier] 初始化工作区失败', error);
        }

        if (this.workspace.lost && !this.lostWarned) {
            this.lostWarned = true;
            toastr.warning('找不到这个聊天之前的工作区数据（可能清过浏览器数据），已新建一份空工作区，旧记录没有被覆盖。', '工作区', { timeOut: 10000 });
        }

        await this.refresh();

        // 勾着「自动同步」的话，打开面板时也补一次（run 内部有去重）
        void this.autoSync?.run('panel-open');
    }

    /**
     * @returns {void}
     */
    close() {
        if (!this.panel) return;
        this.panel.classList.remove('open');
    }

    /**
     * @returns {void}
     */
    toggle() {
        if (this.panel?.classList.contains('open')) this.close();
        else void this.open();
    }

    // -----------------------------------------------------------------------
    // 渲染
    // -----------------------------------------------------------------------

    /**
     * @param {{keepEditor?: boolean}} [options]
     * @returns {Promise<void>}
     */
    async refresh(options = {}) {
        if (!this.panel) return;

        // 功能抽屉跟聊天无关，没打开聊天时也要显示当前设置
        this.syncFeatureControls();

        const scope = this.panel.querySelector('[data-role="scope"]');
        const stats = this.panel.querySelector('[data-role="stats"]');
        const toolState = this.panel.querySelector('[data-role="tool-state"]');

        if (!this.workspace.isBound()) {
            if (scope) scope.textContent = '（未打开聊天）';
            if (stats) stats.textContent = '';
            if (this.tree) this.tree.innerHTML = '<div class="at-empty">请先打开一个聊天。</div>';
            this.setEditorState(false);
            return;
        }

        try {
            await this.workspace.ready();
        } catch (error) {
            if (scope) scope.textContent = '（工作区加载失败）';
            if (stats) stats.textContent = String(error?.message ?? error);
            this.setEditorState(false);
            return;
        }

        const chatId = this.context.getCurrentChatId?.() || this.context.chatId || '';
        if (scope) scope.textContent = chatId ? `聊天: ${chatId}` : '';

        const summary = this.workspace.stats();
        if (stats) {
            const books = this.workspace.bookDirs().length;
            const backend = this.workspace.storage ? 'IndexedDB' : '聊天元数据';
            const compressed = this.compression?.state?.messages ?? 0;
            const compressionNote = compressed ? ` · 已压缩 ${compressed} 条` : '';
            stats.textContent = `${summary.text} · 世界书 ${books} 本 · ${backend}${compressionNote}`;
        }

        const status = describeToolCalling(this.context);

        const autoSyncBox = this.panel.querySelector('[data-role="auto-sync"]');
        if (autoSyncBox instanceof HTMLInputElement) {
            autoSyncBox.checked = this.autoSync?.enabled ?? true;
        }

        this.syncFeatureControls();

        if (toolState) {
            toolState.textContent = status.ok ? '函数调用: 已启用' : '函数调用: 未启用';
            toolState.title = status.message;
            toolState.classList.toggle('at-chip-warn', !status.ok);
        }

        const alert = this.panel.querySelector('[data-role="alert"]');
        const alertText = this.panel.querySelector('[data-role="alert-text"]');
        if (alert instanceof HTMLElement && alertText) {
            alert.hidden = status.ok;
            alertText.textContent = status.ok ? '' : status.message;
            const fixButton = alert.querySelector('[data-action="enable-tools"]');
            if (fixButton instanceof HTMLElement) fixButton.hidden = !status.fixable;
        }

        this.renderTree();

        if (!options.keepEditor) {
            this.setEditorState(false);
        } else if (this.currentPath && !this.dirty) {
            this.loadFile(this.currentPath, { silent: true });
        }
    }

    /**
     * @returns {void}
     */
    renderTree() {
        if (!this.tree) return;
        const fs = this.workspace.fs;

        if (!fs.isDir('/')) {
            this.tree.innerHTML = '<div class="at-empty">工作区为空</div>';
            return;
        }

        const build = (path, depth) => {
            const fragment = document.createDocumentFragment();
            for (const item of fs.list(path)) {
                const row = document.createElement('div');
                row.className = `at-row${item.dir ? ' at-dir' : ''}`;
                row.dataset.path = item.path;
                row.title = item.path;
                row.style.paddingLeft = `${6 + depth * 12}px`;
                if ((this.selectedPath || this.currentPath) === item.path) row.classList.add('active');

                const caret = document.createElement('span');
                caret.className = 'at-caret';
                caret.textContent = item.dir ? (this.expanded.has(item.path) ? '▾' : '▸') : '';

                const icon = document.createElement('span');
                icon.className = 'at-icon';
                icon.textContent = item.dir ? '📁' : '📄';

                const name = document.createElement('span');
                name.className = 'at-name';
                name.textContent = item.name;

                const meta = document.createElement('span');
                meta.className = 'at-meta';
                meta.textContent = item.dir ? '' : formatBytes(item.size);

                row.append(caret, icon, name, meta);
                fragment.append(row);

                if (item.dir && this.expanded.has(item.path) && depth < 8) {
                    fragment.append(build(item.path, depth + 1));
                }
            }
            return fragment;
        };

        this.tree.replaceChildren(build('/', 0));
    }

    /**
     * @param {string} path
     * @param {{silent?: boolean}} [options]
     * @returns {void}
     */
    loadFile(path, options = {}) {
        const fs = this.workspace.fs;
        if (!fs.exists(path) || fs.isDir(path)) return;

        this.currentPath = path;
        this.selectedPath = path;
        this.dirty = false;

        // 展开路径上的所有父目录，保证当前文件在树里可见
        const parts = path.split('/').filter(Boolean);
        for (let i = 1; i < parts.length; i++) {
            this.expanded.add(`/${parts.slice(0, i).join('/')}`);
        }

        if (this.editor) {
            this.editor.value = fs.read(path);
            this.editor.scrollTop = 0;
        }

        const label = this.panel?.querySelector('[data-role="path"]');
        if (label) {
            const stat = fs.stat(path);
            const origin = stat?.origin;
            const suffix = origin?.kind === 'book-entry' && origin.book
                ? `  ·  世界书 ${origin.book} / uid ${origin.uid} / ${origin.part}`
                : '';
            const short = parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
            label.textContent = `${short}${suffix}`;
            label.title = path;
        }

        this.setEditorState(true);
        this.highlightActive();
        if (!options.silent) this.renderTree();
    }

    // -----------------------------------------------------------------------
    // 事件
    // -----------------------------------------------------------------------

    /**
     * @returns {void}
     */
    bindEvents() {
        const panel = this.panel;
        if (!panel) return;

        panel.addEventListener('click', async (event) => {
            const target = /** @type {HTMLElement} */ (event.target);
            const button = target.closest('[data-action]');
            if (button instanceof HTMLElement) {
                await this.handleAction(button.dataset.action ?? '');
                return;
            }

            const row = target.closest('.at-row');
            if (!(row instanceof HTMLElement)) return;

            const path = row.dataset.path ?? '';
            if (!path) return;

            if (row.classList.contains('at-dir')) {
                // 目录也能选中（删除按钮用得上），点一下同时展开/收起
                this.selectPath(path);
                if (this.expanded.has(path)) this.expanded.delete(path);
                else this.expanded.add(path);
                this.renderTree();
                return;
            }

            if (this.dirty) this.save({ quiet: true });
            this.loadFile(path);
        });

        panel.addEventListener('input', (event) => {
            if (event.target !== this.editor) return;
            this.dirty = true;
            this.setEditorState(true);
        });

        panel.addEventListener('keydown', (event) => {
            if (event.target !== this.editor) return;
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                event.preventDefault();
                this.save();
            }
        });

        const header = panel.querySelector('[data-role="drag"]');
        if (header instanceof HTMLElement) {
            header.addEventListener('pointerdown', (event) => this.startDrag(event));
        }

        const autoSyncBox = panel.querySelector('[data-role="auto-sync"]');
        if (autoSyncBox instanceof HTMLInputElement) {
            autoSyncBox.checked = this.autoSync?.enabled ?? true;
            autoSyncBox.addEventListener('change', () => {
                this.autoSync?.setEnabled(autoSyncBox.checked);
            });
        }

        this.bindFeatureControls();
    }

    /**
     * 「功能」抽屉：压缩 / 自我总结的开关和参数。
     * @returns {void}
     */
    toggleFeatures() {
        const drawer = this.panel?.querySelector('[data-role="features"]');
        if (!(drawer instanceof HTMLElement)) return;

        const open = drawer.classList.toggle('open');
        this.settings.showFeatures = open;
        this.context.saveSettingsDebounced?.();
        this.syncFeatureControls();
    }

    /**
     * 展开 / 收起「说明」。
     * @returns {void}
     */
    toggleFeaturesHelp() {
        const help = this.panel?.querySelector('[data-role="features-help"]');
        if (!(help instanceof HTMLElement)) return;
        help.hidden = !help.hidden;
    }

    /**
     * @returns {void}
     */
    bindFeatureControls() {
        const panel = this.panel;
        if (!panel) return;

        const on = (role, event, handler) => {
            const element = panel.querySelector(`[data-role="${role}"]`);
            element?.addEventListener(event, () => handler(element));
        };

        on('set-compression', 'change', element => {
            this.compression?.setEnabled(/** @type {HTMLInputElement} */ (element).checked);
            this.syncFeatureControls();
        });
        on('set-threshold', 'change', element => {
            const value = this.compression?.setThreshold(Number(/** @type {HTMLInputElement} */ (element).value));
            if (typeof value === 'number') /** @type {HTMLInputElement} */ (element).value = String(value);
        });
        on('set-keeplast', 'change', element => {
            const value = this.compression?.setKeepLast(Number(/** @type {HTMLInputElement} */ (element).value));
            if (typeof value === 'number') /** @type {HTMLInputElement} */ (element).value = String(value);
        });
        on('set-review', 'change', element => {
            this.review?.setEnabled(/** @type {HTMLInputElement} */ (element).checked);
            this.syncFeatureControls();
        });
        on('set-turns', 'change', element => {
            const value = this.review?.setInterval(Number(/** @type {HTMLInputElement} */ (element).value));
            if (typeof value === 'number') /** @type {HTMLInputElement} */ (element).value = String(value);
        });
        on('set-toolrounds', 'change', element => {
            const value = this.review?.setToolInterval(Number(/** @type {HTMLInputElement} */ (element).value));
            if (typeof value === 'number') /** @type {HTMLInputElement} */ (element).value = String(value);
        });
    }

    /**
     * 把当前设置写回抽屉里的控件。
     * @returns {void}
     */
    syncFeatureControls() {
        const panel = this.panel;
        if (!panel) return;

        const check = (role, value) => {
            const element = /** @type {HTMLInputElement|null} */ (panel.querySelector(`[data-role="${role}"]`));
            if (element) element.checked = Boolean(value);
        };
        const number = (role, value) => {
            const element = /** @type {HTMLInputElement|null} */ (panel.querySelector(`[data-role="${role}"]`));
            if (element && document.activeElement !== element) element.value = String(value);
        };

        check('set-compression', this.compression?.enabled);
        number('set-threshold', this.compression?.threshold ?? 0.5);
        number('set-keeplast', this.compression?.keepLast ?? 6);

        check('set-review', this.review?.enabled);
        number('set-turns', this.review?.interval ?? 10);
        number('set-toolrounds', this.review?.toolInterval ?? 10);
    }

    /**
     * @param {string} action
     * @returns {Promise<void>}
     */
    async handleAction(action) {
        try {
            switch (action) {
                case 'close':
                    this.close();
                    break;
                case 'save':
                    await this.save();
                    break;
                case 'sync':
                    await this.withBusy(() => this.importBooks('fill'));
                    break;
                case 'rebuild':
                    await this.withBusy(() => this.importBooks('reset'));
                    break;
                case 'apply':
                    await this.withBusy(() => this.applyBooks());
                    break;
                case 'new-file':
                    await this.createFile();
                    break;
                case 'rename':
                    await this.renameSelected();
                    break;
                case 'move':
                    await this.moveSelected();
                    break;
                case 'compress':
                    await this.compressNow();
                    break;
                case 'review':
                    await this.reviewNow();
                    break;
                case 'features':
                    this.toggleFeatures();
                    break;
                case 'features-help':
                    this.toggleFeaturesHelp();
                    break;
                case 'delete':
                    await this.deleteCurrent();
                    break;
                case 'export':
                    await this.exportSelection();
                    break;
                case 'import':
                    await this.importSelection();
                    break;
                case 'enable-tools':
                    this.enableToolCalling();
                    break;
                default:
                    break;
            }
        } catch (error) {
            console.error('[atelier]', error);
            toastr.error(error?.message ?? String(error), '工作区');
        }
    }

    /**
     * @param {'fill'|'reset'} mode
     * @returns {Promise<void>}
     */
    async importBooks(mode) {
        if (!this.workspace.isBound()) throw new Error('请先打开一个聊天');
        await this.workspace.ready();

        if (mode === 'reset') {
            const confirmed = await this.confirm('重建世界书目录', '会删除现有的 world_book 目录并重新从酒馆读取，手改内容将丢失。继续？');
            if (!confirmed) return;
        }

        const books = await this.workspace.activeBooks();
        if (!books.length) {
            toastr.warning('当前聊天没有启用任何世界书', '工作区');
            return;
        }

        const results = await this.workspace.importAll(mode);
        const created = results.reduce((sum, item) => sum + item.created, 0);

        await this.refresh();
        toastr.success(`已导入 ${results.length} 本世界书，新增 ${created} 个条目文件`, '工作区');
    }

    /**
     * @returns {Promise<void>}
     */
    async applyBooks() {
        if (!this.workspace.isBound()) throw new Error('请先打开一个聊天');

        const dirs = this.workspace.bookDirs();
        if (!dirs.length) {
            toastr.warning('工作区里还没有世界书目录，先点「同步世界书」', '工作区');
            return;
        }

        const confirmed = await this.confirm(
            '写回世界书',
            `将把 ${dirs.length} 本世界书的文件写回 SillyTavern（按 uid 覆盖已有条目，不会删除未在文件里出现的条目）。继续？`,
        );
        if (!confirmed) return;

        const results = await this.workspace.applyAll({ deleteMissing: false });
        const written = results.reduce((sum, item) => sum + item.written, 0);
        const warnings = results.flatMap(item => item.warnings);

        await this.refresh();
        if (warnings.length) {
            toastr.warning(`已写回 ${written} 个条目，有 ${warnings.length} 条警告（详见控制台）`, '工作区');
            console.warn('[atelier] 写回警告', warnings);
        } else {
            toastr.success(`已写回 ${written} 个条目到 ${results.length} 本世界书`, '工作区');
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async createFile() {
        const input = await this.context.Popup?.show?.input?.(
            '新建文件',
            `输入工作区内的绝对路径，例如 ${HISTORY_DIR}/2024-01-01.md`,
            `${HISTORY_DIR}/`,
        );
        if (!input) return;

        const path = String(input).trim();
        if (!path) return;

        const result = this.workspace.fs.write(path, '');
        this.workspace.touch('ui-create', { path: result.path });
        this.expanded.add(path.slice(0, path.lastIndexOf('/')) || '/');
        this.loadFile(result.path);
        this.renderTree();
    }

    /**
     * @returns {Promise<void>}
     */
    async deleteCurrent() {
        const target = this.selectedPath || this.currentPath;
        if (!target) {
            toastr.info('先在左侧点一个文件或目录（文件夹也能选）', '工作区');
            return;
        }

        const isDir = this.workspace.fs.isDir(target);
        const what = isDir ? `${target}（整个目录，含里面的文件）` : target;
        const confirmed = await this.confirm('删除', `确定删除 ${what}？此操作不可撤销（不会影响酒馆里的世界书）。`);
        if (!confirmed) return;

        const removed = this.workspace.fs.remove(target);
        this.workspace.touch('ui-delete');
        this.expanded.delete(target);

        // 删的是正在编辑的文件、或它的父目录 → 清空编辑器
        if (this.currentPath === target || this.currentPath.startsWith(`${target}/`)) {
            this.currentPath = '';
            this.dirty = false;
            if (this.editor) this.editor.value = '';
            const label = this.panel?.querySelector('[data-role="path"]');
            if (label) label.textContent = '未选择文件';
            this.setEditorState(false);
        }

        this.selectedPath = '';
        await this.refresh();
        toastr.success(`已删除 ${removed} 个节点`, '工作区');
    }

    /**
     * 导出：选中的文件 / 文件夹打成一个 zip；什么都没选就导出整个工作区。
     * @returns {Promise<void>}
     */
    async exportSelection() {
        if (!this.workspace.isReady()) {
            toastr.warning('工作区尚未加载', '工作区');
            return;
        }

        const fs = this.workspace.fs;
        const target = this.selectedPath || this.currentPath || '';
        const paths = collectExportPaths(fs, target);

        if (!paths.length) {
            toastr.info('没有可导出的文件', '工作区');
            return;
        }

        const chatId = String(this.context.getCurrentChatId?.() ?? this.context.chatId ?? 'workspace');
        const isWholeWorkspace = !target;
        const name = isWholeWorkspace ? `${chatId}-workspace` : target.split('/').filter(Boolean).pop();

        /** 导出里带了世界书目录时，把"目录名 → 书名"的映射一起存下来 */
        const books = this.workspace.store?.books ?? {};
        const relevantBooks = Object.fromEntries(Object.entries(books).filter(([dir]) => {
            if (isWholeWorkspace) return true;
            const prefix = target.endsWith('/') ? target : `${target}/`;
            return dir === target || dir.startsWith(prefix);
        }));

        const meta = Object.keys(relevantBooks).length || isWholeWorkspace
            ? {
                format: 'atelier',
                version: 2,
                exportedAt: new Date().toISOString(),
                chatId,
                books: relevantBooks,
            }
            : undefined;

        try {
            const blob = await buildZip(fs, paths, { meta });
            downloadBlob(blob, `${safeFileName(name)}.zip`);
            toastr.success(`已导出 ${paths.length} 个文件`, '工作区');
        } catch (error) {
            console.error('[atelier] 导出失败', error);
            toastr.error(error?.message ?? String(error), '工作区');
        }
    }

    /**
     * 导入：zip 按原路径还原，散装文件放进当前选中的目录。
     * @returns {Promise<void>}
     */
    async importSelection() {
        if (!this.workspace.isReady()) {
            toastr.warning('工作区尚未加载', '工作区');
            return;
        }

        const files = await pickFiles('.zip,application/zip', true);
        if (!files.length) return;

        const fs = this.workspace.fs;
        const targetDir = this.selectedDir();

        /** @type {{path: string, getText: () => Promise<string>}[]} */
        const entries = [];
        /** @type {Record<string, any>} */
        let booksMeta = {};

        for (const file of files) {
            if (file.name.toLowerCase().endsWith('.zip')) {
                const meta = await readZipMeta(file);
                if (meta?.books && typeof meta.books === 'object') {
                    Object.assign(booksMeta, meta.books);
                }
                entries.push(...await readZipEntries(file));
            } else {
                entries.push({
                    path: `${targetDir === '/' ? '' : targetDir}/${file.name}`,
                    getText: () => file.text(),
                });
            }
        }

        if (!entries.length) {
            toastr.info('压缩包里没有文件', '工作区');
            return;
        }

        // 规范化路径 + 统计冲突
        /** @type {{path: string, getText: () => Promise<string>}[]} */
        const planned = [];
        for (const entry of entries) {
            const normalized = normalizeZipPath(entry.path);
            if (!normalized) continue;
            planned.push({ ...entry, path: normalized });
        }

        const conflicts = planned.filter(item => fs.exists(item.path));
        const message = conflicts.length
            ? `将导入 ${planned.length} 个文件，其中 ${conflicts.length} 个会覆盖已有文件。继续？`
            : `将导入 ${planned.length} 个文件。继续？`;

        const confirmed = await this.confirm('导入', message);
        if (!confirmed) return;

        let written = 0;
        let skipped = 0;
        for (const item of planned) {
            let text;
            try {
                text = await item.getText();
            } catch {
                skipped += 1;
                continue;
            }
            if (text.includes('\u0000')) {
                skipped += 1; // 二进制文件跳过（工作区只存文本）
                continue;
            }
            try {
                fs.write(item.path, text);
                written += 1;
                this.workspace.touch('import', { path: item.path });
            } catch (error) {
                console.warn('[atelier] 导入单个文件失败', item.path, error);
                skipped += 1;
            }
        }

        if (Object.keys(booksMeta).length) {
            this.workspace.store.books = { ...this.workspace.store.books, ...booksMeta };
            this.workspace.touch('import');
        }

        await this.workspace.flush();
        this.expanded.add(targetDir);
        await this.refresh();
        toastr.success(`已导入 ${written} 个文件${skipped ? `，跳过 ${skipped} 个` : ''}`, '工作区');
    }

    /**
     * 当前选中项所在的目录（选中文件取父目录）。
     * @returns {string}
     */
    selectedDir() {
        const selected = this.selectedPath || this.currentPath;
        if (!selected) return '/';
        try {
            if (this.workspace.fs.isDir(selected)) return selected;
        } catch {
            // 忽略：可能已经被删了
        }
        const index = selected.lastIndexOf('/');
        return index <= 0 ? '/' : selected.slice(0, index);
    }

    /**
     * 一键勾上「启用函数调用」。
     * 直接操作酒馆自己的开关，让它走原有的 input 处理器（会写 oai_settings 并保存）。
     * @returns {void}
     */
    enableToolCalling() {
        const checkbox = document.getElementById('openai_function_calling');
        if (!(checkbox instanceof HTMLInputElement)) {
            toastr.warning('没找到「启用函数调用」开关，请到 AI Response Configuration 面板手动打开。', '工作区');
            return;
        }

        if (!checkbox.checked) {
            checkbox.checked = true;
            checkbox.dispatchEvent(new Event('input', { bubbles: true }));
        }

        const status = describeToolCalling(this.context);
        if (status.ok) {
            toastr.success('已启用函数调用（记得保持当前预设，切预设可能会把它关掉）', '工作区');
        } else {
            toastr.warning(status.message, '工作区');
        }
        void this.refresh();
    }

    /**
     * @param {{quiet?: boolean}} [options]
     * @returns {void}
     */
    save(options = {}) {
        if (!this.currentPath || !this.editor) return;
        try {
            this.workspace.fs.write(this.currentPath, this.editor.value);
            this.workspace.touch('ui-save', { path: this.currentPath });
            void this.workspace.flush();
            this.dirty = false;
            this.setEditorState(true);
            this.renderTree();
            if (!options.quiet) toastr.success(`已保存 ${this.currentPath}`, '工作区');
        } catch (error) {
            toastr.error(error?.message ?? String(error), '工作区');
        }
    }

    // -----------------------------------------------------------------------
    // 小工具
    // -----------------------------------------------------------------------

    /**
     * @param {boolean} enabled
     * @returns {void}
     */
    setEditorState(enabled) {
        const save = this.panel?.querySelector('[data-action="save"]');
        if (save instanceof HTMLButtonElement) save.disabled = !enabled;
        if (this.editor) this.editor.disabled = !enabled;

        const dirty = this.panel?.querySelector('[data-role="dirty"]');
        if (dirty) dirty.textContent = this.dirty ? '● 未保存' : '';
    }

    /**
     * 选中树里的一项（文件或目录），只高亮、不动编辑器。
     * @param {string} path
     * @returns {void}
     */
    selectPath(path) {
        this.selectedPath = path;
        this.highlightActive();
    }

    /**
     * @returns {void}
     */
    highlightActive() {
        this.tree?.querySelectorAll('.at-row').forEach(row => {
            row.classList.toggle('active', row instanceof HTMLElement && row.dataset.path === (this.selectedPath || this.currentPath));
        });
    }

    /**
     * @param {() => Promise<any>} task
     * @returns {Promise<void>}
     */
    async withBusy(task) {
        if (this.busy) return;
        this.busy = true;
        this.panel?.classList.add('at-busy');
        try {
            await task();
        } finally {
            this.busy = false;
            this.panel?.classList.remove('at-busy');
            await this.refresh({ keepEditor: true });
        }
    }

    /**
     * @param {string} header
     * @param {string} text
     * @returns {Promise<boolean>}
     */
    async confirm(header, text) {
        const Popup = this.context.Popup;
        const result = await Popup?.show?.confirm?.(header, text);
        return result === this.context.POPUP_RESULT?.AFFIRMATIVE;
    }

    /**
     * 手动跑一次自我回顾。
     * @returns {Promise<void>}
     */
    async reviewNow() {
        if (!this.review) {
            toastr.warning('回顾器还没初始化', '工作区');
            return;
        }

        try {
            const result = await this.review.run({ trigger: 'manual' });
            const archived = result.archived > 0 ? `，归档 ${result.archived} 条原文到 ${HISTORY_DIR}` : '';
            if (result.skipped) {
                toastr.info(`没有回顾：${result.skipped}`, '工作区');
            } else if (result.saved > 0) {
                toastr.success(`回顾完成：新增 ${result.saved} 条记忆${archived}`, '工作区');
            } else {
                toastr.info(`回顾完成：没有值得沉淀的新内容${archived}`, '工作区');
            }
            await this.refresh();
        } catch (error) {
            console.error('[atelier] 回顾失败', error);
            toastr.error(error?.message ?? String(error), '工作区');
        }
    }

    /**
     * 手动压缩一次。
     * @returns {Promise<void>}
     */
    async compressNow() {
        if (!this.compression) {
            toastr.warning('压缩器还没初始化', '工作区');
            return;
        }

        try {
            const result = await this.compression.compress({ trigger: 'manual' });
            if (result.skipped) {
                toastr.info(`没有压缩：${result.skipped}`, '工作区');
            } else {
                toastr.success(result.message ?? '已压缩', '工作区');
            }
            await this.refresh();
        } catch (error) {
            console.error('[atelier] 压缩失败', error);
            toastr.error(error?.message ?? String(error), '工作区');
        }
    }

    /**
     * 重命名选中的文件或目录（直接改路径，也可以顺手换目录）。
     * @returns {Promise<void>}
     */
    async renameSelected() {
        const target = this.selectedPath || this.currentPath;
        if (!target) {
            toastr.info('先在左侧选中一个文件或目录', '工作区');
            return;
        }

        const next = await this.promptPath('重命名', '新路径（比如 /world_book/甲/entries/0_新标题.md）', target);
        if (!next || next === target) return;

        await this.applyMove(target, next);
    }

    /**
     * 把选中的文件 / 目录移动到另一个目录（名字不变）。
     * @returns {Promise<void>}
     */
    async moveSelected() {
        const target = this.selectedPath || this.currentPath;
        if (!target) {
            toastr.info('先在左侧选中一个文件或目录', '工作区');
            return;
        }

        const name = target.split('/').filter(Boolean).pop() ?? '';
        const currentDir = target.slice(0, target.lastIndexOf('/')) || '/';
        const asked = await this.promptPath('移动', '移动到哪个目录？（文件名不变）', currentDir);
        if (!asked) return;

        const dir = normalizePath(asked);
        const next = dir === '/' ? `/${name}` : `${dir}/${name}`;
        if (next === target) return;

        await this.applyMove(target, next);
    }

    /**
     * @param {string} header
     * @param {string} text
     * @param {string} value
     * @returns {Promise<string|null>}
     */
    async promptPath(header, text, value) {
        const Popup = this.context.Popup;
        const answer = Popup?.show?.input
            ? await Popup.show.input(header, text, value)
            : globalThis.prompt(text, value);
        if (typeof answer !== 'string' || !answer.trim()) return null;
        return answer.trim();
    }

    /**
     * @param {string} target
     * @param {string} next
     * @returns {Promise<void>}
     */
    async applyMove(target, next) {
        let result;
        try {
            result = this.workspace.movePath(target, next);
        } catch (error) {
            toastr.error(error?.message ?? String(error), '工作区');
            return;
        }

        // 正在编辑的文件跟着换路径
        if (this.currentPath === result.from || this.currentPath.startsWith(`${result.from}/`)) {
            this.currentPath = result.to + this.currentPath.slice(result.from.length);
            const label = this.panel?.querySelector('[data-role="path"]');
            if (label) label.textContent = this.currentPath;
        }

        this.selectedPath = result.to;
        const parent = result.to.slice(0, result.to.lastIndexOf('/')) || '/';
        this.expanded.add(parent);

        await this.refresh();
        toastr.success(`已移动到 ${result.to}`, '工作区');
    }

    // -----------------------------------------------------------------------
    // 几何（拖拽 / 缩放持久化）
    // -----------------------------------------------------------------------

    /**
     * 把面板放回可视区。
     *
     * 桌面端用记住的几何；手机竖屏（或窗口变小）时按视口收窄、下移，
     * 避免被酒馆顶栏遮住、或者一半跑到屏幕外面去。
     *
     * @returns {void}
     */
    applyGeometry() {
        if (!this.panel) return;

        const margin = 8;
        const bar = document.getElementById('top-bar');
        const barBottom = bar ? Math.round(bar.getBoundingClientRect().bottom) : 0;
        const minY = Math.max(margin, barBottom + 4);

        // visualViewport 才是软键盘弹起后的真实可视高度
        const vh = Math.min(window.innerHeight, Math.round(window.visualViewport?.height ?? window.innerHeight));
        const maxW = Math.max(240, window.innerWidth - margin * 2);
        const maxH = Math.max(200, vh - minY - margin);

        const rect = this.panel.getBoundingClientRect();
        const wantW = Number.isFinite(this.settings.w) ? this.settings.w : (rect.width || 620);
        const wantH = Number.isFinite(this.settings.h) ? this.settings.h : (rect.height || 460);
        const w = Math.min(Math.max(wantW, 280), maxW);
        const h = Math.min(Math.max(wantH, 220), maxH);

        const wantX = Number.isFinite(this.settings.x) ? this.settings.x : window.innerWidth - w - margin;
        const wantY = Number.isFinite(this.settings.y) ? this.settings.y : minY;

        const x = Math.min(Math.max(wantX, margin), Math.max(margin, window.innerWidth - w - margin));
        const y = Math.min(Math.max(wantY, minY), Math.max(minY, vh - h - margin));

        this.panel.style.left = `${Math.round(x)}px`;
        this.panel.style.top = `${Math.round(y)}px`;
        this.panel.style.right = 'auto';
        this.panel.style.bottom = 'auto';
        this.panel.style.width = `${Math.round(w)}px`;
        this.panel.style.height = `${Math.round(h)}px`;
    }

    /**
     * @returns {void}
     */
    persistGeometry() {
        if (!this.panel) return;
        const rect = this.panel.getBoundingClientRect();
        Object.assign(this.settings, {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
        });
        this.context.saveSettingsDebounced?.();
    }

    /**
     * @param {PointerEvent} event
     * @returns {void}
     */
    startDrag(event) {
        if (!this.panel || event.button !== 0) return;
        if (event.target instanceof HTMLElement && event.target.closest('button')) return;

        const rect = this.panel.getBoundingClientRect();
        this.drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
        this.panel.classList.add('at-dragging');

        // 触屏：把指针捕获到标题栏，手指移出面板范围也继续收到 pointermove；
        // 配合 CSS 的 touch-action:none，否则浏览器会把手势当成滚动/缩放，拖动直接断掉
        const header = event.currentTarget;
        if (header instanceof HTMLElement && typeof header.setPointerCapture === 'function') {
            try {
                header.setPointerCapture(event.pointerId);
            } catch {
                // 某些浏览器 / 合成事件不支持捕获，忽略
            }
        }
        event.preventDefault();

        const move = (moveEvent) => {
            if (!this.panel || !this.drag) return;
            const margin = 8;
            const bar = document.getElementById('top-bar');
            const minY = Math.max(margin, (bar ? bar.getBoundingClientRect().bottom : 0) + 4);
            const width = this.panel.offsetWidth;
            const height = this.panel.offsetHeight;

            const x = Math.max(margin, Math.min(window.innerWidth - width - margin, moveEvent.clientX - this.drag.dx));
            const y = Math.max(minY, Math.min(window.innerHeight - height - margin, moveEvent.clientY - this.drag.dy));
            this.panel.style.left = `${Math.round(x)}px`;
            this.panel.style.top = `${Math.round(y)}px`;
            this.panel.style.right = 'auto';
            this.panel.style.bottom = 'auto';
        };

        const up = () => {
            this.panel?.classList.remove('at-dragging');
            this.drag = null;
            this.persistGeometry();
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
        };

        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
    }
}
