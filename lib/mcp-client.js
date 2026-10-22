/**
 * MCP 客户端（浏览器侧，只做网络传输）。
 *
 * 支持两种：
 *   http —— Streamable HTTP（spec 2025-03-26+）：单端点 POST JSON-RPC，
 *           响应体可能是 application/json，也可能是 text/event-stream；
 *           会话靠 `Mcp-Session-Id` 响应头维持。
 *   sse  —— HTTP + SSE（2024-11-05，已废弃）：GET 一条长连接收结果，
 *           首帧 `event: endpoint` 给出 POST 地址，请求都 POST 到那个地址。
 *
 * stdio 不做：浏览器起不了本地进程。
 *
 * 浏览器直连还取决于对方是否放行 CORS —— 报 `Failed to fetch` 基本都是这个原因，
 * 不是协议实现的问题。
 */

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'atelier', version: '1.0.0' };
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 解析 SSE 帧。传入累积缓冲，返回已完成的帧和剩余尾巴。
 * @param {string} buffer
 * @returns {{frames: {event: string, data: string}[], rest: string}}
 */
export function parseSseFrames(buffer) {
    const frames = [];
    let rest = String(buffer ?? '').replace(/\r\n/g, '\n');

    let boundary = rest.indexOf('\n\n');
    while (boundary !== -1) {
        const block = rest.slice(0, boundary);
        rest = rest.slice(boundary + 2);

        let event = 'message';
        const data = [];
        for (const line of block.split('\n')) {
            if (!line || line.startsWith(':')) continue;
            const colon = line.indexOf(':');
            const field = colon === -1 ? line : line.slice(0, colon);
            const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
            if (field === 'event') event = value;
            else if (field === 'data') data.push(value);
        }

        if (data.length) frames.push({ event, data: data.join('\n') });
        boundary = rest.indexOf('\n\n');
    }

    return { frames, rest };
}

/**
 * 工具名要满足酒馆的命名约束，同时保证同一台服务器内唯一。
 * @param {string} serverName
 * @param {string} toolName
 * @returns {string}
 */
export function sanitizeToolName(serverName, toolName) {
    const clean = (value) => String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 24);

    // 纯中文/符号的名字清洗后是空的：用一个稳定的短哈希兜底，别全都变成 mcp_x_x
    const hash = (value) => {
        let result = 5381;
        for (const char of String(value ?? '')) result = ((result << 5) + result + char.codePointAt(0)) | 0;
        return (result >>> 0).toString(36).slice(0, 5);
    };

    const server = clean(serverName) || `s${hash(serverName)}`;
    const tool = clean(toolName) || `t${hash(toolName)}`;

    return `mcp_${server}_${tool}`.slice(0, 60);
}

/**
 * 把 MCP 的 inputSchema 变成酒馆能接受的 parameters。
 *
 * MCP server 的 schema 不做白名单裁剪 —— 服务端写什么就发什么，
 * `enum` / `pattern` / `items` / `format` 这些提示原样保留给模型。
 *
 * 只做两件必要的事：
 *   1. 顶层必须是 object（不是就退化成空参数，否则酒馆那边直接报错）；
 *   2. 不额外塞 `additionalProperties` —— Gemini 的 Schema proto 没有这个字段，
 *      带上就是 400 `Unknown name "additionalProperties"`。
 *
 * @param {any} schema
 * @returns {Record<string, any>}
 */
export function toToolParameters(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object') {
        return { type: 'object', properties: {} };
    }

    return {
        type: 'object',
        properties: schema.properties && typeof schema.properties === 'object' ? schema.properties : {},
        required: Array.isArray(schema.required) ? schema.required : [],
    };
}

/**
 * 规范化自定义请求头。
 *
 * 接受对象或 `[{key, value}]`（面板里就是行数组），丢掉空值和非法名字。
 * 浏览器的 Headers 对名字很挑：非法 token 会直接抛 TypeError，所以这里先过滤。
 *
 * @param {any} input
 * @returns {Record<string, string>}
 */
export function normalizeHeaders(input) {
    /** @type {Record<string, string>} */
    const headers = {};

    const pairs = Array.isArray(input)
        ? input.map(item => [item?.key, item?.value])
        : (input && typeof input === 'object' ? Object.entries(input) : []);

    for (const [rawKey, rawValue] of pairs) {
        const key = String(rawKey ?? '').trim();
        const value = String(rawValue ?? '').trim();
        if (!key || !value) continue;
        if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key)) continue;
        headers[key] = value;
    }

    return headers;
}

/**
 * 规范化一条服务器配置；不合法返回 null。
 * @param {any} input
 * @returns {{id: string, name: string, url: string, transport: 'http'|'sse', headers: Record<string, string>, enabled: boolean}|null}
 */
export function normalizeServer(input) {
    if (!input || typeof input !== 'object') return null;

    const url = String(input.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) return null;

    const transport = input.transport === 'sse' ? 'sse' : 'http';
    const name = String(input.name ?? '').trim() || url.replace(/^https?:\/\//, '').split('/')[0];
    const id = String(input.id ?? '').trim() || `${transport}:${url}`;
    const headers = normalizeHeaders(input.headers);

    return { id, name, url, transport, headers, enabled: input.enabled !== false };
}

/**
 * MCP 工具调用结果里的文本，拼成一段给人看的东西。
 * @param {any} result
 * @returns {string}
 */
export function summarizeResult(result) {
    if (!result || typeof result !== 'object') return String(result ?? '');

    const content = Array.isArray(result.content) ? result.content : [];
    const parts = content.map(item => {
        if (!item || typeof item !== 'object') return '';
        if (item.type === 'text') return String(item.text ?? '');
        if (item.type === 'image') return `[image ${item.mimeType ?? ''}]`.trim();
        if (item.type === 'resource') return `[resource ${item.resource?.uri ?? ''}]`.trim();
        return `[${item.type ?? 'unknown'}]`;
    }).filter(Boolean);

    const text = parts.join('\n').trim();
    if (text) return text;
    return JSON.stringify(result, null, 2).slice(0, 8000);
}

export class McpClient {
    /**
     * @param {{url: string, transport?: 'http'|'sse', name?: string}} config
     */
    constructor(config) {
        this.url = config.url;
        this.transport = config.transport === 'sse' ? 'sse' : 'http';
        this.name = config.name ?? this.url;
        /** 自定义请求头，原样带到每个请求 */
        this.customHeaders = normalizeHeaders(config.headers);
        this.sessionId = '';
        this.nextId = 0;
        this.serverInfo = null;
        this.protocolVersion = '';
        this.tools = [];
        this.connected = false;

        this.abort = null;
        this.sseEndpoint = '';
        this.pending = new Map();
    }

    /**
     * @returns {Record<string, string>}
     */
    baseHeaders() {
        /** @type {Record<string, string>} */
        const headers = {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
        };
        if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
        if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion;

        // 自定义头放最后，允许覆盖默认值（比如自己指定 Accept）
        Object.assign(headers, this.customHeaders);
        return headers;
    }

    /**
     * 连接 + 握手 + 拉工具列表。
     *
     * 传输方式由配置显式指定（面板上二选一），不做自动探测：
     *   http —— Streamable HTTP（2025-03-26+）
     *   sse  —— 旧版 HTTP + SSE（2024-11-05）
     *
     * @returns {Promise<{serverInfo: any, tools: any[], transport: 'http'|'sse'}>}
     */
    async connect() {
        if (this.transport === 'sse') {
            await this.openSseStream();
        }
        return this.handshake();
    }

    /**
     * @returns {Promise<{serverInfo: any, tools: any[], transport: 'http'|'sse'}>}
     */
    async handshake() {
        const init = await this.request('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: CLIENT_INFO,
        });

        this.serverInfo = init?.serverInfo ?? null;
        this.protocolVersion = String(init?.protocolVersion ?? '');
        this.notify('notifications/initialized');

        const listed = await this.request('tools/list', {});
        this.tools = Array.isArray(listed?.tools) ? listed.tools : [];
        this.connected = true;
        return { serverInfo: this.serverInfo, tools: this.tools, transport: this.transport };
    }

    /**
     * @param {string} name
     * @param {Record<string, any>} args
     * @returns {Promise<any>}
     */
    async callTool(name, args) {
        return this.request('tools/call', { name, arguments: args ?? {} });
    }

    /**
     * @returns {void}
     */
    close() {
        this.connected = false;
        this.sessionId = '';
        this.tools = [];
        this.abort?.abort();
        this.abort = null;
        for (const { reject, timer } of this.pending.values()) {
            clearTimeout(timer);
            reject(new Error('连接已关闭'));
        }
        this.pending.clear();
    }

    /**
     * 发一个 JSON-RPC 请求并等结果。
     * @param {string} method
     * @param {Record<string, any>} params
     * @returns {Promise<any>}
     */
    async request(method, params) {
        if (this.transport === 'sse') return this.requestOverSse(method, params);

        const id = ++this.nextId;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

        try {
            const response = await fetch(this.url, {
                method: 'POST',
                headers: this.baseHeaders(),
                body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
                signal: controller.signal,
            });

            const session = response.headers.get('mcp-session-id');
            if (session) this.sessionId = session;

            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                throw new Error(`HTTP ${response.status}${detail ? `：${detail.slice(0, 300)}` : ''}`);
            }

            // 通知类请求没有响应体
            if (response.status === 202) return null;

            const contentType = response.headers.get('content-type') ?? '';
            if (contentType.includes('text/event-stream')) {
                return this.readStreamResponse(response, id);
            }

            const payload = await response.json();
            return unwrapMessage(payload, id);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Streamable HTTP 的 SSE 响应：从流里挑出 id 对得上的那一条。
     * @param {Response} response
     * @param {number} id
     * @returns {Promise<any>}
     */
    async readStreamResponse(response, id) {
        const reader = response.body?.getReader();
        if (!reader) throw new Error('响应没有可读流');

        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const { frames, rest } = parseSseFrames(buffer);
                buffer = rest;

                for (const frame of frames) {
                    if (frame.event !== 'message') continue;
                    let payload;
                    try {
                        payload = JSON.parse(frame.data);
                    } catch {
                        continue;
                    }
                    if (payload?.id !== id) continue;
                    return unwrapMessage(payload, id);
                }
            }
        } finally {
            reader.releaseLock?.();
        }

        throw new Error('连接结束但没有收到响应');
    }

    /**
     * 发通知（不需要结果）。
     * @param {string} method
     * @param {Record<string, any>} [params]
     * @returns {void}
     */
    notify(method, params = {}) {
        const body = JSON.stringify({ jsonrpc: '2.0', method, params });

        if (this.transport === 'sse') {
            if (!this.sseEndpoint) return;
            void fetch(this.sseEndpoint, {
                method: 'POST',
                headers: this.baseHeaders(),
                body,
            }).catch(() => { });
            return;
        }

        void fetch(this.url, { method: 'POST', headers: this.baseHeaders(), body }).catch(() => { });
    }

    /**
     * 打开 legacy SSE 长连接，等 endpoint 帧。
     * @returns {Promise<void>}
     */
    async openSseStream() {
        this.abort = new AbortController();
        const response = await fetch(this.url, {
            method: 'GET',
            headers: { Accept: 'text/event-stream', ...this.customHeaders },
            signal: this.abort.signal,
        });

        if (!response.ok) throw new Error(`SSE 连接失败：HTTP ${response.status}`);

        const endpointReady = new Promise((resolve, reject) => {
            this.resolveEndpoint = resolve;
            this.rejectEndpoint = reject;
        });

        void this.pumpSse(response);

        const timer = setTimeout(() => this.rejectEndpoint?.(new Error('没等到 endpoint 帧')), DEFAULT_TIMEOUT_MS);
        try {
            await endpointReady;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * 持续读 SSE 流，把响应分发给等待中的请求。
     * @param {Response} response
     * @returns {Promise<void>}
     */
    async pumpSse(response) {
        const reader = response.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const { frames, rest } = parseSseFrames(buffer);
                buffer = rest;

                for (const frame of frames) {
                    if (frame.event === 'endpoint') {
                        this.sseEndpoint = new URL(frame.data, this.url).toString();
                        this.resolveEndpoint?.();
                        continue;
                    }
                    if (frame.event !== 'message') continue;

                    let payload;
                    try {
                        payload = JSON.parse(frame.data);
                    } catch {
                        continue;
                    }

                    const entry = this.pending.get(payload?.id);
                    if (!entry) continue;
                    this.pending.delete(payload.id);
                    clearTimeout(entry.timer);
                    if (payload.error) entry.reject(new Error(payload.error.message ?? 'MCP 返回错误'));
                    else entry.resolve(payload.result);
                }
            }
        } catch (error) {
            if (error?.name !== 'AbortError') {
                for (const { reject, timer } of this.pending.values()) {
                    clearTimeout(timer);
                    reject(error);
                }
                this.pending.clear();
            }
        }
    }

    /**
     * legacy SSE 模式下：POST 到 endpoint，等流里回来。
     * @param {string} method
     * @param {Record<string, any>} params
     * @returns {Promise<any>}
     */
    async requestOverSse(method, params) {
        if (!this.sseEndpoint) throw new Error('SSE 还没建立好');

        const id = ++this.nextId;
        const response = await fetch(this.sseEndpoint, {
            method: 'POST',
            headers: this.baseHeaders(),
            body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        });

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status}${detail ? `：${detail.slice(0, 300)}` : ''}`);
        }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`请求超时：${method}`));
            }, DEFAULT_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timer });
        });
    }
}

/**
 * 判断这个错误像不像"服务端只支持旧版 SSE"。
 *
 * Streamable HTTP 的服务端收到 POST 会正常处理；旧版 SSE 服务端只认 GET /sse，
 * 对 POST 通常回 404（路径不存在）、405（方法不允许）、406（Accept 不匹配），
 * 或者直接回一个 HTML 页面。这些都值得切 SSE 再试一次。
 *
 * 网络层错误（Failed to fetch）不重试 —— 那是 CORS 或地址不通，换传输也没用。
 *
 * @param {any} error
 * @returns {boolean}
 */
export function isTransportMismatch(error) {
    const message = String(error?.message ?? error ?? '');
    return /HTTP (404|405|406|415)\b/.test(message);
}

/**
 * @param {any} payload
 * @param {number} id
 * @returns {any}
 */
function unwrapMessage(payload, id) {
    const message = Array.isArray(payload)
        ? payload.find(item => item?.id === id) ?? payload[0]
        : payload;

    if (message?.error) {
        throw new Error(message.error.message ?? 'MCP 返回错误');
    }
    return message?.result ?? null;
}
