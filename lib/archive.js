/**
 * /chat_history 的归档格式。
 *
 * 一条消息一个文件：`<楼层>-<分支>.md`。
 * 压缩和自我总结都走这里 —— 同一条消息被两个功能都归档时，写的是同一个文件，
 * 所以目录里不会出现两份内容重复的副本。
 */

import { HISTORY_DIR } from './workspace.js';

/** 归档文件的第一行前缀，用来和目录里别的东西区分开 */
export const ARCHIVE_HEADER = '# 楼层 ';

/**
 * 分支号 = swipe_id + 1。
 * @param {any} message
 * @returns {number}
 */
export function branchOf(message) {
    return Math.max(1, Math.trunc(Number(message?.swipe_id) || 0) + 1);
}

/**
 * 这条消息要不要归档。
 *
 * 工具消息（带 extra.tool_invocations）虽然是 is_system，但也要存；
 * 压缩摘要、回顾提示这类我们自己的系统消息跳过。
 *
 * @param {any} message
 * @returns {boolean}
 */
export function shouldArchive(message) {
    if (!message) return false;
    if (Array.isArray(message.extra?.tool_invocations)) return true;
    if (message.extra?.at_compression || message.extra?.at_review) return false;
    return !message.is_system;
}

/**
 * @param {number} floor 1-based 楼层
 * @param {number} branch 1-based 分支
 * @returns {string}
 */
export function archivePath(floor, branch) {
    return `${HISTORY_DIR}/${floor}-${branch}.md`;
}

/**
 * 一条消息 → 一份 md。
 *
 * @param {any} message
 * @param {number} floor 1-based 楼层
 * @param {number} branch 1-based 分支（swipe）
 * @returns {string}
 */
export function renderArchiveEntry(message, floor, branch) {
    const invocations = Array.isArray(message.extra?.tool_invocations) ? message.extra.tool_invocations : null;
    const role = invocations ? '工具' : (message.is_user ? '用户' : '角色');
    const name = typeof message.name === 'string' && message.name.trim() ? message.name.trim() : '';
    const label = name && name !== role ? `${role} · ${name}` : role;

    /** @type {string[]} */
    const lines = [`${ARCHIVE_HEADER}${floor} · 分支 ${branch}`, '', `- 角色：${label}`];

    const time = formatTimestamp(message.send_date);
    if (time) lines.push(`- 时间：${time}`);

    const model = message.extra?.model ?? message.model;
    if (typeof model === 'string' && model.trim()) lines.push(`- 模型：${model.trim()}`);

    lines.push('', '---', '');

    if (invocations) {
        lines.push('```json', JSON.stringify(invocations.map(cleanInvocation), null, 2), '```', '');
        return lines.join('\n');
    }

    lines.push(String(message.mes ?? ''));
    return lines.join('\n');
}

/**
 * 只保留归档需要的字段，顺便把 JSON 字符串解析成对象。
 * @param {any} invocation
 * @returns {Record<string, any>}
 */
function cleanInvocation(invocation) {
    const parse = value => {
        if (typeof value !== 'string') return value;
        try {
            return JSON.parse(value);
        } catch {
            return value;
        }
    };

    return {
        name: invocation?.name ?? invocation?.displayName ?? 'tool',
        parameters: parse(invocation?.parameters),
        result: parse(invocation?.result),
        ...(invocation?.error ? { error: true } : {}),
    };
}

/**
 * @param {any} value
 * @returns {string}
 */
function formatTimestamp(value) {
    if (value === undefined || value === null || value === '') return '';
    const date = new Date(typeof value === 'number' ? value : Number(value));
    if (Number.isNaN(date.getTime())) return '';

    const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
    return [
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    ].join(' ');
}
