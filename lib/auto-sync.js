/**
 * 自动同步（双向）：
 *
 *   酒馆 → 工作区：打开聊天 / 启用列表变化 / 世界书内容变化时，把启用的书补进工作区。
 *                  只做 fill —— 缺什么补什么，绝不覆盖已有的文件。
 *                  停用的书，连目录一起移除。
 *
 *   工作区 → 酒馆：工作区里的世界书文件被改（工具 / js / 面板保存）后，
 *                  防抖 800ms 自动 applyBook 写回酒馆，不用再点「写回世界书」。
 *
 * 开关存在 extension_settings['atelier'].autoSync，默认开；关掉就两头都不动。
 */

const SETTINGS_KEY = 'atelier';
const DEBOUNCE_MS = 300;
const WRITE_BACK_DELAY = 800;

export class AutoSync {
    /**
     * @param {any} context getContext()（可以是 Proxy）
     * @param {import('./workspace.js').Atelier} workspace
     */
    constructor(context, workspace) {
        this.context = context;
        this.workspace = workspace;
        /** @type {any} */
        this.timer = null;
        /** 世界书被改动时递增，用来绕过"同一批书不重复导入"的去重 */
        this.revision = 0;
        this.signature = '';
        this.running = false;
        this.pending = false;

        /** @type {Set<string>} 工作区里被改过、等着写回的世界书目录 */
        this.dirtyDirs = new Set();
        /** @type {any} */
        this.writeBackTimer = null;
        this.applying = false;
        /** @type {(() => void)|null} */
        this.unsubscribe = null;
    }

    /**
     * @returns {Record<string, any>}
     */
    get settings() {
        const store = this.context.extensionSettings;
        if (!store[SETTINGS_KEY] || typeof store[SETTINGS_KEY] !== 'object') {
            store[SETTINGS_KEY] = {};
        }
        return store[SETTINGS_KEY];
    }

    /**
     * @returns {boolean} 默认开启
     */
    get enabled() {
        return this.settings.autoSync !== false;
    }

    /**
     * @param {boolean} value
     * @returns {void}
     */
    setEnabled(value) {
        this.settings.autoSync = Boolean(value);
        this.context.saveSettingsDebounced?.();
        if (this.enabled) this.schedule('enabled');
    }

    /**
     * @returns {void}
     */
    install() {
        const events = this.context?.eventTypes ?? {};
        const source = this.context?.eventSource;

        // 世界书本身改了（新增/删除条目、改内容）→ 补上新条目
        if (events.WORLDINFO_UPDATED) {
            source?.on?.(events.WORLDINFO_UPDATED, () => {
                // 自己写回触发的更新就不用再导一遍了
                if (this.applying) return;
                this.revision += 1;
                this.schedule('worldinfo-updated');
            });
        }
        // 启用的世界书换了 → 重新判断
        if (events.WORLDINFO_SETTINGS_UPDATED) {
            source?.on?.(events.WORLDINFO_SETTINGS_UPDATED, () => this.schedule('worldinfo-settings'));
        }

        // 工作区里的文件被改（工具 / js / 面板保存）→ 攒着自动写回世界书
        this.unsubscribe = this.workspace.onChange((reason, detail) => this.onWorkspaceChange(reason, detail));
    }

    /**
     * @returns {void}
     */
    destroy() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (this.writeBackTimer) clearTimeout(this.writeBackTimer);
        this.writeBackTimer = null;
        this.unsubscribe?.();
        this.unsubscribe = null;
    }

    /**
     * 工作区有改动：只有落在某本世界书目录里的才需要写回。
     * @param {string} reason
     * @param {{path?: string}} [detail]
     * @returns {void}
     */
    onWorkspaceChange(reason, detail) {
        if (!this.enabled) return;
        if (this.applying) return;

        const path = detail?.path;
        if (!path) return;

        const dir = this.findBookDir(path);
        if (!dir) return;

        this.dirtyDirs.add(dir);
        this.scheduleWriteBack();
    }

    /**
     * @param {string} path
     * @returns {string|null}
     */
    findBookDir(path) {
        if (!this.workspace.isReady()) return null;
        for (const item of this.workspace.bookDirs()) {
            if (path === item.dir || path.startsWith(`${item.dir}/`)) return item.dir;
        }
        return null;
    }

    /**
     * @returns {void}
     */
    scheduleWriteBack() {
        if (this.writeBackTimer) clearTimeout(this.writeBackTimer);
        this.writeBackTimer = setTimeout(() => {
            this.writeBackTimer = null;
            void this.writeBack();
        }, WRITE_BACK_DELAY);
    }

    /**
     * 把攒下来的改动写回酒馆世界书。
     * @returns {Promise<void>}
     */
    async writeBack() {
        if (!this.enabled || this.applying) return;
        if (!this.workspace.isBound() || !this.workspace.isReady()) return;
        if (!this.dirtyDirs.size) return;

        const dirs = [...this.dirtyDirs];
        this.dirtyDirs.clear();

        this.applying = true;
        let written = 0;
        try {
            for (const dir of dirs) {
                // 目录可能在等待期间被删掉了
                if (!this.workspace.fs.isDir(dir)) continue;
                const result = await this.workspace.applyBook(dir, { deleteMissing: false });
                written += 1;
                console.debug(`[atelier] 工作区改动已写回世界书：${result.book}（${result.written} 条）`);
            }
            if (written > 0) {
                globalThis.toastr?.success?.(`已自动写回 ${written} 本世界书`, '工作区');
            }
        } catch (error) {
            console.warn('[atelier] 自动写回失败', error);
            globalThis.toastr?.error?.(`自动写回失败：${error?.message ?? error}`, '工作区');
        } finally {
            this.applying = false;
        }
    }

    /**
     * 切换聊天：旧的签名作废，重新同步。
     * @returns {void}
     */
    onChatChanged() {
        this.signature = '';
        this.revision = 0;
        this.dirtyDirs.clear();
        if (this.writeBackTimer) {
            clearTimeout(this.writeBackTimer);
            this.writeBackTimer = null;
        }
        this.schedule('chat-changed');
    }

    /**
     * @param {string} reason
     * @returns {void}
     */
    schedule(reason) {
        if (!this.enabled) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.run(reason);
        }, DEBOUNCE_MS);
    }

    /**
     * @param {string} reason
     * @returns {Promise<void>}
     */
    async run(reason) {
        if (!this.enabled) return;
        if (!this.workspace.isBound()) return;

        if (this.running) {
            this.pending = true;
            return;
        }

        this.running = true;
        try {
            await this.workspace.ready();

            const books = await this.workspace.activeBooks();

            // 世界书列表还没加载出来、当前也没启用任何书：这时候别动工作区，避免误删
            const knownNames = this.context.getWorldInfoNames?.();
            const knowsBooks = Array.isArray(knownNames) && knownNames.length > 0;
            if (!books.length && !knowsBooks) return;

            const chatId = String(this.context.getCurrentChatId?.() ?? '');
            const signature = `${chatId}|${[...books].sort().join(',')}|${this.revision}`;
            if (signature === this.signature) return;
            this.signature = signature;

            const results = await this.workspace.importAll('fill');
            const created = results.reduce((sum, item) => sum + item.created, 0);
            console.debug(`[atelier] 自动同步 ${results.length} 本世界书，新增 ${created} 个条目文件（${reason}）`);

            // 停用的书：连目录一起从工作区移除
            const removed = await this.workspace.removeInactiveBooks(books);
            if (removed.length) {
                const names = removed.map(item => item.book).join('、');
                console.debug(`[atelier] 已移除 ${removed.length} 本停用世界书的目录：${names}`);
                globalThis.toastr?.info?.(`已从工作区移除停用世界书：${names}`, '工作区');
            }
        } catch (error) {
            console.warn('[atelier] 自动同步失败', error);
        } finally {
            this.running = false;
            if (this.pending) {
                this.pending = false;
                this.schedule('pending');
            }
        }
    }
}
