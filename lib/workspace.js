/**
 * 与聊天记录绑定的工作区。
 *
 * 存储分两层：
 *   chat_metadata.atelier = { v, sid, owner, books }   ← 指针（几十字节）
 *   IndexedDB  "vfs:<sid>"        = { version, nodes, books }  ← 文件正文
 *
 *  - 指针跟着 chat 文件走，切聊天 / 导出聊天都不会丢关联；
 *  - 正文在 IndexedDB 里，不拖慢 chat 保存；
 *  - `owner` 记录创建它的 chatId：分支或改名后 owner 不匹配就克隆一份，
 *    既继承内容，又不会两个聊天互相覆盖；
 *  - IndexedDB 打不开时自动退化为「正文也写进 chat_metadata」。
 *
 * 目录骨架：
 *   /chat_history/              归档：压缩原文 + 回顾原文
 *   /world_book/<世界书名>/
 *       _metadata.yaml
 *       entries/<uid>_<标题>.yaml
 *       entries/<uid>_<标题>.md
 *   /README.md
 */

import { WorkspaceFS, baseName, normalizePath } from './vfs.js';
import { dumpYaml, parseYaml } from './yaml.js';
import { docToEntry, entryBaseName, entryToDoc, safeSegment, uidFromBaseName } from './wb-map.js';
import { WorkspaceStorage } from './storage.js';

export const META_KEY = 'atelier';
export const SCHEMA_VERSION = 2;

export const HISTORY_DIR = '/chat_history';
export const BOOK_ROOT = '/world_book';
export const README_PATH = '/README.md';

const FLUSH_DELAY = 400;

const README_TEXT = `# 工作区

这个工作区与**当前聊天**绑定。文件正文存在浏览器 IndexedDB 里，聊天文件里只留一个指针，
所以复制聊天分支时会继承一份副本，但不会相互覆盖。

## 目录

- \`/chat_history/\` —— 归档：压缩前的原文（\`NNN-时间.md\`）和被回顾的楼层原文（\`楼层-分支.md\`）。
- \`/world_book/<世界书名>/_metadata.yaml\` —— 世界书元信息（name / entries 路径）。
- \`/world_book/<世界书名>/entries/<uid>_<标题>.yaml\` —— 单个条目的配置。
- \`/world_book/<世界书名>/entries/<uid>_<标题>.md\` —— 单个条目的正文（对应酒馆里的 content）。

## 条目 yaml 约定

| 字段 | 含义 |
|---|---|
| \`index\` | 酒馆条目的 uid，整数，**新增条目请挑一个没被占用的数字** |
| \`name\` | 条目标题（comment） |
| \`enabled\` | 是否启用（disable 取反） |
| \`activationMode\` | \`keyword\` 关键词 / \`always\` 常驻 / \`vector\` 向量 |
| \`key\` / \`secondaryKey\` | 主 / 副关键词数组 |
| \`selectiveLogic\` | \`andAny\` / \`notAll\` / \`notAny\` / \`andAll\` |
| \`position\` | \`beforeChar\` \`afterChar\` \`beforeAn\` \`afterAn\` \`fixed\` \`beforeEm\` \`afterEm\` \`outlet\` |
| \`role\` | 仅 \`position: fixed\` 时有效：\`system\` / \`user\` / \`model\`，其余写 \`null\` |
| \`order\` / \`depth\` / \`probability\` | 排序、深度、触发概率 |
| \`other\` | 其余酒馆原生字段，**原样保留**即可 |

## 规则

1. 条目正文只写在 \`.md\` 里，不要塞进 yaml 的 \`content\`。
2. 改完文件后，开着「自动同步」会自动写回酒馆；关掉就点面板上的「写回世界书」。
3. \`.yaml\` 与 \`.md\` 必须同名成对；缺 \`.md\` 会按空正文处理。
4. 文件名里的数字前缀就是 uid，改前缀等于换 uid。

## 可用工具

- \`read\`：读文件（路径如 \`/world_book/xxx/entries/0_yyy.md\`）；传目录则返回目录列表；\`startLine\`/\`endLine\` 按行切。
- \`write\`：新建或覆盖整个文件（内容没变会返回 Unchanged）。
- \`edit\`：用 \`hunks\` 做精确字符串替换，一次可改多处（\`oldContent\` 必须在文件里唯一，除非 \`replaceAll\`）。
- \`js\`：在页面里执行 JavaScript，**不是沙箱**——\`document\` / \`window\` / \`SillyTavern\` 都能用，
  所以能操作界面；\`at\` 是工作区 API：\`files\` / \`read\` / \`write\` / \`move\` / \`remove\` / \`parseYaml\`。
`;

/**
 * @returns {string}
 */
function randomId() {
    const cryptoObject = /** @type {any} */ (globalThis).crypto;
    if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
    return `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @param {Record<string, any>} data
 * @returns {Record<string, any>}
 */
function blankWorkspace() {
    return { version: SCHEMA_VERSION, nodes: { '/': { t: 'd' } }, books: {} };
}

export class Atelier {
    /**
     * @param {any} context getContext() 的返回值（可以是 Proxy，每次取值都拿最新聊天）
     * @param {{storage?: WorkspaceStorage|null, idFactory?: () => string}} [options]
     *        storage 显式传 null 可强制走 chat_metadata 回退（便于测试）
     */
    constructor(context, options = {}) {
        this.context = context;
        this.storage = Object.hasOwn(options, 'storage') ? (options.storage ?? null) : undefined;
        this.idFactory = options.idFactory ?? randomId;

        /** @type {Record<string, any>|null} */
        this.store = null;
        this.sid = '';
        this.owner = '';
        this.cloned = false;
        /** IndexedDB 里的记录丢失、已改用新 sid（避免覆盖旧数据） */
        this.lost = false;
        /** @type {Promise<any>|null} */
        this.loading = null;
        /** @type {any} */
        this.flushTimer = null;
        /** @type {Set<(reason: string) => void>} */
        this.listeners = new Set();
    }

    /**
     * 当前是否有可用的聊天作用域。
     * @returns {boolean}
     */
    isBound() {
        try {
            return Boolean(this.context?.getCurrentChatId?.() || this.context?.chatId);
        } catch {
            return false;
        }
    }

    /**
     * 工作区是否已加载完成。
     * @returns {boolean}
     */
    isReady() {
        return Boolean(this.store);
    }

    /**
     * 加载（或创建）当前聊天的工作区。
     * @returns {Promise<Record<string, any>>}
     */
    async ready() {
        if (this.store) return this.store;
        if (!this.loading) {
            this.loading = this.#load().catch(error => {
                this.loading = null;
                throw error;
            });
        }
        return this.loading;
    }

    /**
     * 切换到别的聊天时丢弃内存状态。
     * @returns {void}
     */
    reset() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.store = null;
        this.sid = '';
        this.owner = '';
        this.cloned = false;
        this.lost = false;
        this.loading = null;
    }

    /**
     * 虚拟文件系统句柄（每次新建包装器，底层 nodes 共享引用）。
     * @returns {WorkspaceFS}
     */
    get fs() {
        if (!this.store) throw new Error('工作区尚未加载，请先 await ready()');
        return new WorkspaceFS(this.store);
    }

    /**
     * @param {(reason: string) => void} listener
     * @returns {() => void} 取消订阅
     */
    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /**
     * 记录变更：更新指针、排一次落盘、通知 UI。
     * @param {string} reason
     * @param {{path?: string}} [detail] 变更的文件路径（自动写回要靠它定位世界书）
     * @returns {void}
     */
    touch(reason = 'change', detail = undefined) {
        this.#writeRef();
        if (this.storage) this.#scheduleFlush();
        for (const listener of this.listeners) {
            try {
                listener(reason, detail);
            } catch (error) {
                console.error('[atelier] listener 失败', error);
            }
        }
    }

    /**
     * 移动 / 重命名文件或目录（目录连子树一起搬）。
     *
     * 同步方法：调用前工作区必须已经 ready（`js` 工具里天然满足）。
     *
     * @param {string} from
     * @param {string} to
     * @returns {{from: string, to: string, count: number}}
     */
    movePath(from, to) {
        const result = this.fs.move(from, to);

        // 搬的是世界书目录：把"目录 → 书名"的映射跟着改，否则写回会落到错的名字上
        const books = this.store?.books;
        if (books) {
            for (const [dir, book] of Object.entries(books)) {
                if (dir === result.from || dir.startsWith(`${result.from}/`)) {
                    delete books[dir];
                    books[result.to + dir.slice(result.from.length)] = book;
                }
            }
        }

        this.touch('move', { path: result.to });
        void this.flush();
        return result;
    }

    /**
     * 删除文件或目录（递归），并清掉对应的"目录 → 书名"映射。
     *
     * 同步方法：调用前工作区必须已经 ready。
     *
     * @param {string} path
     * @returns {number} 删除的节点数
     */
    removePath(path) {
        const normalized = normalizePath(path);
        const count = this.fs.remove(normalized);

        const books = this.store?.books;
        if (books) {
            for (const dir of Object.keys(books)) {
                if (dir === normalized || dir.startsWith(`${normalized}/`)) delete books[dir];
            }
        }

        this.touch('remove', { path: normalized });
        void this.flush();
        return count;
    }

    /**
     * 立即把正文写进 IndexedDB。
     * @returns {Promise<void>}
     */
    async flush() {
        if (!this.storage || !this.store) return;
        const sid = this.sid;
        const payload = {
            version: this.store.version ?? SCHEMA_VERSION,
            nodes: this.store.nodes,
            books: this.store.books,
        };
        try {
            await this.storage.write(sid, payload);
        } catch (error) {
            console.warn('[atelier] 写入 IndexedDB 失败，退回聊天元数据存储', error);
            this.storage = null;
            this.#writeRef();
        }
    }

    /**
     * 建立骨架（幂等，不覆盖已有内容）。
     * @returns {Promise<boolean>} 是否有改动
     */
    async ensure() {
        await this.ready();
        const fs = this.fs;
        let changed = false;

        for (const dir of [HISTORY_DIR, BOOK_ROOT]) {
            if (!fs.exists(dir)) {
                fs.mkdirp(dir);
                changed = true;
            }
        }
        if (!fs.exists(README_PATH)) {
            fs.write(README_PATH, README_TEXT, { kind: 'readme' });
            changed = true;
        }

        if (changed) this.touch('ensure');
        return changed;
    }

    /**
     * 当前聊天「启用」的世界书名称。
     * 覆盖：聊天绑定 / 角色绑定 / 全局多选（World Info 面板）。
     * @returns {Promise<string[]>}
     */
    async activeBooks() {
        const ctx = this.context;
        /** @type {Set<string>} */
        const names = new Set();

        const add = (value) => {
            if (typeof value === 'string' && value.trim()) names.add(value.trim());
        };

        add(ctx?.chatMetadata?.world_info);

        const characters = Array.isArray(ctx?.characters) ? ctx.characters : [];
        const character = Number.isInteger(ctx?.characterId) ? characters[ctx.characterId] : null;
        add(character?.data?.extensions?.world);

        for (const name of await readGlobalSelection(ctx)) add(name);

        const known = new Set(ctx?.getWorldInfoNames?.() ?? []);
        return [...names].filter(name => (known.size ? known.has(name) : true));
    }

    /**
     * 取（或创建）某个世界书对应的目录。
     * @param {string} bookName
     * @returns {string}
     */
    ensureBookDir(bookName) {
        const root = this.store;
        if (!root) throw new Error('工作区尚未加载');
        const books = root.books;

        const existing = Object.entries(books).find(([, name]) => name === bookName);
        if (existing) {
            this.fs.mkdirp(existing[0]);
            return existing[0];
        }

        const base = `${BOOK_ROOT}/${safeSegment(bookName) || 'world_book'}`;
        let dir = base;
        let index = 2;
        while (books[dir] && books[dir] !== bookName) {
            dir = `${base} (${index})`;
            index += 1;
        }
        books[dir] = bookName;
        this.fs.mkdirp(dir);
        return dir;
    }

    /**
     * 从酒馆世界书导入到工作区。
     * @param {string} bookName
     * @param {'fill'|'reset'} [mode] fill=只补缺失文件；reset=清空重建
     * @returns {Promise<{book: string, dir: string, created: number, skipped: number, total: number}>}
     */
    async importBook(bookName, mode = 'fill') {
        if (typeof bookName !== 'string' || !bookName.trim()) throw new Error('世界书名称无效');
        await this.ready();

        const fs = this.fs;
        const dir = this.ensureBookDir(bookName);

        if (mode === 'reset') {
            fs.remove(dir);
            fs.mkdirp(`${dir}/entries`);
        }

        const data = await this.context?.loadWorldInfo?.(bookName);
        if (!data || typeof data.entries !== 'object' || data.entries === null) {
            throw new Error(`读不到世界书 "${bookName}" 的条目`);
        }

        const entriesDir = `${dir}/entries`;
        fs.mkdirp(entriesDir);

        const metaPath = `${dir}/_metadata.yaml`;
        if (mode === 'reset' || !fs.exists(metaPath)) {
            fs.write(metaPath, dumpYaml({
                name: bookName,
                entries: `world_book/${baseName(dir)}/entries`,
            }), { kind: 'book-meta', book: bookName });
        }

        let created = 0;
        let skipped = 0;
        let total = 0;

        for (const [key, entry] of Object.entries(data.entries)) {
            if (!entry || typeof entry !== 'object') continue;
            const uid = Number.isInteger(entry.uid) ? entry.uid : Number(key);
            if (!Number.isInteger(uid)) continue;
            total += 1;

            const { yaml, md } = entryToDoc(entry, uid);
            const stem = entryBaseName(uid, yaml.name);
            const yamlPath = `${entriesDir}/${stem}.yaml`;
            const mdPath = `${entriesDir}/${stem}.md`;

            if (!fs.exists(yamlPath)) {
                fs.write(yamlPath, dumpYaml(yaml), { kind: 'book-entry', book: bookName, uid, part: 'yaml' });
                created += 1;
            } else {
                skipped += 1;
            }

            if (!fs.exists(mdPath)) {
                fs.write(mdPath, md, { kind: 'book-entry', book: bookName, uid, part: 'md' });
            }
        }

        this.touch('import');
        return { book: bookName, dir, created, skipped, total };
    }

    /**
     * 把所有启用的世界书都导入一遍。
     * @param {'fill'|'reset'} [mode] reset 会先清空 world_book/ 再重建
     * @returns {Promise<{book: string, dir: string, created: number, skipped: number, total: number}[]>}
     */
    async importAll(mode = 'fill') {
        await this.ready();

        if (mode === 'reset') {
            const fs = this.fs;
            for (const item of fs.list(BOOK_ROOT)) {
                fs.remove(item.path);
            }
            this.store.books = {};
        }

        const results = [];
        for (const book of await this.activeBooks()) {
            results.push(await this.importBook(book, mode));
        }
        return results;
    }

    /**
     * 把已经不在「启用列表」里的世界书目录移除。
     *
     * 只负责执行；要不要删（比如世界书列表还没加载好时）由调用方判断。
     *
     * @param {string[]} activeBooks 当前仍启用的世界书
     * @returns {Promise<{dir: string, book: string}[]>} 被移除的目录
     */
    async removeInactiveBooks(activeBooks) {
        await this.ready();

        const active = new Set(activeBooks ?? []);
        const removed = [];

        for (const item of this.bookDirs()) {
            if (active.has(item.book)) continue;
            this.fs.remove(item.dir);
            delete this.store.books[item.dir];
            removed.push(item);
        }

        if (removed.length) this.touch('remove-inactive');
        return removed;
    }

    /**
     * 把工作区某个世界书目录写回酒馆。
     * @param {string} dir 目录路径或目录名
     * @param {{deleteMissing?: boolean}} [options]
     * @returns {Promise<{book: string, written: number, removed: number, warnings: string[]}>}
     */
    async applyBook(dir, options = {}) {
        await this.ready();
        const fs = this.fs;
        const path = normalizePath(dir.startsWith('/') ? dir : `${BOOK_ROOT}/${dir}`);
        const dirName = baseName(path);
        const bookName = this.store?.books[path] ?? dirName;
        const entriesDir = `${path}/entries`;

        if (!fs.isDir(entriesDir)) {
            throw new Error(`目录不存在: ${entriesDir}`);
        }

        const metaPath = `${path}/_metadata.yaml`;
        if (fs.exists(metaPath)) {
            try {
                const meta = parseYaml(fs.read(metaPath));
                if (meta.name && String(meta.name) !== bookName) {
                    console.warn(`[atelier] ${metaPath} 的 name 与映射不一致：${meta.name} != ${bookName}`);
                }
            } catch (error) {
                console.warn(`[atelier] ${metaPath} 解析失败，已忽略`, error);
            }
        }

        const previous = await this.context?.loadWorldInfo?.(bookName);
        /** @type {Record<string, any>} */
        const nextEntries = options.deleteMissing ? {} : { ...(previous?.entries ?? {}) };
        const previousCount = Object.keys(previous?.entries ?? {}).length;

        /** @type {string[]} */
        const warnings = [];
        /** @type {Set<number>} */
        const seen = new Set();
        let written = 0;

        const files = fs.list(entriesDir).filter(item => !item.dir && item.name.toLowerCase().endsWith('.yaml'));
        files.sort((a, b) => a.name.localeCompare(b.name, 'en'));

        for (const file of files) {
            const stem = file.name.slice(0, -'.yaml'.length);
            const mdPath = `${entriesDir}/${stem}.md`;
            const md = fs.exists(mdPath) ? fs.read(mdPath) : '';
            const fallbackUid = uidFromBaseName(stem);

            let doc;
            try {
                doc = parseYaml(fs.read(file.path));
            } catch (error) {
                throw new Error(`${file.path} 解析失败：${error.message}`);
            }

            const parsed = docToEntry(doc, md, fallbackUid);
            for (const warning of parsed.warnings) warnings.push(`${file.name}: ${warning}`);

            const uid = parsed.entry.uid;
            if (seen.has(uid)) {
                throw new Error(`uid ${uid} 重复出现（${file.name}）`);
            }
            seen.add(uid);
            nextEntries[uid] = parsed.entry;
            written += 1;
        }

        const removed = Math.max(0, previousCount - Object.keys(nextEntries).length);

        await this.context?.saveWorldInfo?.(bookName, { ...(previous ?? {}), entries: nextEntries }, true);
        this.touch('apply');

        return { book: bookName, written, removed, warnings };
    }

    /**
     * 写回所有已导入的世界书。
     * @param {{deleteMissing?: boolean}} [options]
     * @returns {Promise<{book: string, written: number, removed: number, warnings: string[]}[]>}
     */
    async applyAll(options = {}) {
        await this.ready();
        const results = [];
        for (const item of this.fs.list(BOOK_ROOT)) {
            if (!item.dir) continue;
            results.push(await this.applyBook(item.path, options));
        }
        return results;
    }

    /**
     * 已导入的世界书目录映射。
     * @returns {{dir: string, book: string}[]}
     */
    bookDirs() {
        if (!this.store) return [];
        return this.fs.list(BOOK_ROOT)
            .filter(item => item.dir)
            .map(item => ({ dir: item.path, book: this.store.books[item.path] ?? item.name }));
    }

    /**
     * @returns {{files: number, dirs: number, bytes: number, text: string}}
     */
    stats() {
        if (!this.store) return { files: 0, dirs: 0, bytes: 0, text: '0 文件 / 0 目录 / 0 B' };
        return this.fs.stats();
    }

    // -----------------------------------------------------------------------
    // 内部
    // -----------------------------------------------------------------------

    /**
     * @returns {Promise<Record<string, any>>}
     */
    async #load() {
        const ctx = this.context;
        const metadata = ctx?.chatMetadata;
        if (!metadata || typeof metadata !== 'object') {
            throw new Error('当前没有打开聊天，工作区不可用');
        }

        const chatId = String(ctx?.getCurrentChatId?.() ?? ctx?.chatId ?? '');

        if (this.storage === undefined) {
            try {
                this.storage = await WorkspaceStorage.create();
            } catch {
                this.storage = null;
            }
        }

        const ref = metadata[META_KEY] && typeof metadata[META_KEY] === 'object' ? metadata[META_KEY] : null;

        let previousSid = typeof ref?.sid === 'string' ? ref.sid : '';
        let data = previousSid && this.storage ? await this.storage.read(previousSid) : null;

        // 没有 IndexedDB（private 模式 / 浏览器不给配额）时的降级：正文就存在 chat_metadata 里
        if (!data && !this.storage && ref?.nodes && typeof ref.nodes === 'object') {
            data = { version: SCHEMA_VERSION, nodes: ref.nodes, books: ref.books ?? {} };
        }

        let sid = previousSid;
        let cloned = false;
        let lost = false;

        if (!data) {
            data = blankWorkspace();
            if (!sid) {
                sid = this.idFactory();
            } else if (this.storage) {
                // 指针还在、记录读不到（清过站点数据 / 换了浏览器）：
                // 换一个新 sid，绝不覆盖原记录，旧数据仍留在 IndexedDB 里
                lost = true;
                sid = this.idFactory();
            }
        } else if (ref?.owner && chatId && ref.owner !== chatId) {
            // 聊天被分支 / 改名：内容复制一份，避免两个聊天共享同一块数据
            data = {
                version: SCHEMA_VERSION,
                nodes: structuredClone(data.nodes ?? {}),
                books: { ...(data.books ?? {}) },
            };
            sid = this.idFactory();
            cloned = true;
        }

        data.version ??= SCHEMA_VERSION;
        data.nodes ??= { '/': { t: 'd' } };
        data.books ??= {};

        this.store = data;
        this.sid = sid;
        this.owner = chatId;
        this.cloned = cloned;
        this.lost = lost;
        this.#writeRef();

        if (this.storage && (cloned || lost || sid !== previousSid)) {
            try {
                await this.storage.write(sid, data);
            } catch (error) {
                console.warn('[atelier] 初始化写入 IndexedDB 失败', error);
                this.storage = null;
                this.#writeRef();
            }
        }

        return data;
    }

    /**
     * 把指针写回聊天元数据。
     * @returns {void}
     */
    #writeRef() {
        const metadata = this.context?.chatMetadata;
        if (!metadata || !this.store) return;

        /** @type {Record<string, any>} */
        const ref = {
            v: SCHEMA_VERSION,
            sid: this.sid,
            owner: this.owner,
            books: this.store.books,
            storage: this.storage ? 'idb' : 'chat',
        };
        if (!this.storage) {
            // 兜底：IndexedDB 不可用时，正文仍写进元数据
            ref.nodes = this.store.nodes;
        }

        metadata[META_KEY] = ref;
        try {
            this.context?.saveMetadataDebounced?.();
        } catch (error) {
            console.error('[atelier] 保存聊天元数据失败', error);
        }
    }

    /**
     * @returns {void}
     */
    #scheduleFlush() {
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            void this.flush();
        }, FLUSH_DELAY);
    }
}

/**
 * 全局 World Info 多选里勾选的条目。
 * 优先读 world-info.js 的实时 export，退化为读 UI 上的多选框。
 * @param {any} context
 * @returns {Promise<string[]>}
 */
async function readGlobalSelection(context) {
    try {
        const module = await import('../../../../world-info.js');
        if (Array.isArray(module.selected_world_info)) {
            return [...module.selected_world_info];
        }
    } catch {
        // 忽略：某些版本 / 测试环境拿不到内部 export
    }

    const fromSettings = context?.powerUserSettings?.world_info?.globalSelect;
    if (Array.isArray(fromSettings)) return [...fromSettings];

    try {
        const select = document.getElementById('world_info');
        if (select instanceof HTMLSelectElement) {
            return [...select.selectedOptions].map(option => option.value);
        }
    } catch {
        // 忽略
    }

    return [];
}
