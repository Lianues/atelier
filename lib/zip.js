/**
 * 工作区的 ZIP 导入 / 导出。
 *
 * 用酒馆自带的 JSZip（`public/lib/jszip.min.js`，酒馆自己的 utils.js 也是这么加载的），
 * 不额外引依赖。
 *
 * 导出：选中的文件 / 文件夹（或整个工作区）打成 zip，路径保持工作区内的相对路径，
 *       所以再导入能原位还原。整包导出时额外塞一个 __workspace_meta.json 记住
 *       "目录名 → 世界书名" 的映射（重名/非法字符时目录名会和书名不一致）。
 *
 * 导入：支持 zip 和散装文件。zip 里的路径原样落到工作区；散装文件放进当前选中的目录。
 */

const JSZIP_URL = '../../../../../lib/jszip.min.js';
const META_NAME = '__workspace_meta.json';

/**
 * 按需加载 JSZip（UMD，执行后挂到 window.JSZip）。
 * @returns {Promise<any>}
 */
export async function loadZip() {
    if (globalThis.JSZip) return globalThis.JSZip;

    await import(JSZIP_URL);

    if (!globalThis.JSZip) throw new Error('JSZip 加载失败（/lib/jszip.min.js）');
    return globalThis.JSZip;
}

/**
 * 导出目标包含哪些文件。空 target = 整个工作区。
 * @param {import('./vfs.js').WorkspaceFS} fs
 * @param {string} [target]
 * @returns {string[]}
 */
export function collectExportPaths(fs, target = '') {
    const files = fs.files();
    if (!target) return files;
    if (!fs.isDir(target)) return [target];
    const prefix = `${target}/`;
    return files.filter(path => path.startsWith(prefix));
}

/**
 * 打包成 zip。
 * @param {import('./vfs.js').WorkspaceFS} fs
 * @param {string[]} paths
 * @param {{meta?: Record<string, any>}} [options]
 * @returns {Promise<Blob>}
 */
export async function buildZip(fs, paths, options = {}) {
    const JSZip = await loadZip();
    const zip = new JSZip();

    for (const path of paths) {
        zip.file(path.replace(/^\/+/, ''), fs.read(path));
    }
    if (options.meta) {
        zip.file(META_NAME, JSON.stringify(options.meta, null, 2));
    }

    return zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
    });
}

/**
 * 读 zip，列出里面的文件。
 * @param {File|Blob} file
 * @returns {Promise<{path: string, getText: () => Promise<string>}[]>}
 */
export async function readZipEntries(file) {
    const JSZip = await loadZip();
    const zip = await JSZip.loadAsync(file);

    /** @type {{path: string, getText: () => Promise<string>}[]} */
    const entries = [];

    zip.forEach((relPath, entry) => {
        if (entry.dir) return;
        const name = relPath.split('/').pop() ?? '';
        if (name === '.DS_Store' || relPath.startsWith('__MACOSX/')) return;
        if (relPath === META_NAME) return;

        entries.push({
            path: relPath,
            getText: () => entry.async('string'),
        });
    });

    return entries;
}

/**
 * 从 zip 里读回工作区元数据（目录名 → 世界书名）。
 * @param {File|Blob} file
 * @returns {Promise<Record<string, any>|null>}
 */
export async function readZipMeta(file) {
    const JSZip = await loadZip();
    const zip = await JSZip.loadAsync(file);
    const metaFile = zip.file(META_NAME);
    if (!metaFile) return null;

    try {
        return JSON.parse(await metaFile.async('string'));
    } catch {
        return null;
    }
}

/**
 * zip 里的条目路径 → 工作区绝对路径。含 `..` 或空路径的一律丢弃。
 * @param {string} raw
 * @returns {string|null}
 */
export function normalizeZipPath(raw) {
    const cleaned = String(raw ?? '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
    if (!cleaned) return null;

    const segments = cleaned.split('/').filter(segment => segment && segment !== '.');
    if (!segments.length) return null;
    if (segments.includes('..')) return null;

    return `/${segments.join('/')}`;
}

/**
 * 触发浏览器下载。
 * @param {Blob} blob
 * @param {string} filename
 * @returns {void}
 */
export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 文件名里不能出现的字符换掉。
 * @param {string} name
 * @returns {string}
 */
export function safeFileName(name) {
    return String(name ?? '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
        .trim() || 'workspace';
}

export { META_NAME };
