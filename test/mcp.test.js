import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseSseFrames,
    normalizeServer,
    sanitizeToolName,
    summarizeResult,
    toToolParameters,
} from '../lib/mcp-client.js';

test('parseSseFrames：单帧、多帧、跨块缓冲', () => {
    const one = parseSseFrames('event: endpoint\ndata: /messages?sessionId=abc\n\n');
    assert.deepEqual(one.frames, [{ event: 'endpoint', data: '/messages?sessionId=abc' }]);
    assert.equal(one.rest, '');

    const two = parseSseFrames('data: {"a":1}\n\ndata: {"b":2}\n\n');
    assert.equal(two.frames.length, 2);
    assert.equal(two.frames[0].data, '{"a":1}');

    // 半截帧要留着
    const partial = parseSseFrames('data: {"a":1}\n\ndata: {"b"');
    assert.equal(partial.frames.length, 1);
    assert.equal(partial.rest, 'data: {"b"');
});

test('parseSseFrames：多行 data 用换行拼、注释行忽略', () => {
    const { frames } = parseSseFrames(': keep-alive\n\nevent: message\ndata: line1\ndata: line2\n\n');
    assert.equal(frames.length, 1);
    assert.equal(frames[0].event, 'message');
    assert.equal(frames[0].data, 'line1\nline2');
});

test('parseSseFrames：CRLF 也能解析', () => {
    const { frames } = parseSseFrames('event: endpoint\r\ndata: /m\r\n\r\n');
    assert.deepEqual(frames, [{ event: 'endpoint', data: '/m' }]);
});

test('normalizeServer：只接受 http(s)，默认 http 传输', () => {
    assert.equal(normalizeServer({ url: 'ftp://x' }), null);
    assert.equal(normalizeServer({ url: '' }), null);
    assert.equal(normalizeServer(null), null);

    const server = normalizeServer({ url: 'https://example.com/mcp' });
    assert.equal(server.transport, 'http');
    assert.equal(server.name, 'example.com');
    assert.equal(server.enabled, true);

    const sse = normalizeServer({ url: 'https://example.com/sse', transport: 'sse', name: '本地' });
    assert.equal(sse.transport, 'sse');
    assert.equal(sse.name, '本地');
});

test('normalizeServer：id 稳定（同地址同传输得到同一个 id）', () => {
    const a = normalizeServer({ url: 'https://x.dev/mcp' });
    const b = normalizeServer({ url: 'https://x.dev/mcp', transport: 'http' });
    assert.equal(a.id, b.id);
    assert.notEqual(normalizeServer({ url: 'https://x.dev/mcp', transport: 'sse' }).id, a.id);
});

test('sanitizeToolName：小写、下划线、长度受限', () => {
    assert.equal(sanitizeToolName('My Server', 'read-file'), 'mcp_my_server_read_file');
    assert.equal(sanitizeToolName('a b', 'x'), 'mcp_a_b_x');
    assert.ok(sanitizeToolName('s'.repeat(40), 't'.repeat(40)).length <= 60);
    // 纯中文清洗后为空 → 用短哈希兜底，保证不同服务器/工具不会撞名
    assert.match(sanitizeToolName('中文', '工具'), /^mcp_s[0-9a-z]+_t[0-9a-z]+$/);
    assert.notEqual(sanitizeToolName('中文', '工具'), sanitizeToolName('另一个', '工具'));
});

test('toToolParameters：缺 schema 时给空对象，非 object 也兜底', () => {
    assert.deepEqual(toToolParameters(null), { type: 'object', properties: {} });
    assert.deepEqual(toToolParameters({ type: 'string' }), { type: 'object', properties: {} });

    const converted = toToolParameters({
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
    });
    assert.deepEqual(converted, {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
    });
});

test('summarizeResult：拼文本块，非文本块给占位', () => {
    assert.equal(
        summarizeResult({ content: [{ type: 'text', text: '第一行' }, { type: 'text', text: '第二行' }] }),
        '第一行\n第二行',
    );
    assert.equal(summarizeResult({ content: [{ type: 'image', mimeType: 'image/png' }] }), '[image image/png]');
    assert.match(summarizeResult({ content: [], structuredContent: { a: 1 } }), /structuredContent/);
});

/* ------------------------- 端到端：真起一个 HTTP 服务 ------------------------- */

import http from 'node:http';
import { McpClient, isTransportMismatch, normalizeHeaders } from '../lib/mcp-client.js';

/**
 * @param {http.ServerResponse} res
 * @param {any} payload
 */
function sendJson(res, payload) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
}

/**
 * @param {any} message
 * @returns {any}
 */
function mcpResult(message) {
    if (message.method === 'initialize') {
        return { protocolVersion: '2025-06-18', serverInfo: { name: 'test-server', version: '1' }, capabilities: { tools: {} } };
    }
    if (message.method === 'tools/list') {
        return {
            tools: [{
                name: 'echo',
                description: '回显',
                inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
            }],
        };
    }
    if (message.method === 'tools/call') {
        return { content: [{ type: 'text', text: `hi ${message.params?.arguments?.text ?? ''}` }] };
    }
    return {};
}

test('isTransportMismatch：只有 404/405/406/415 才回退', () => {
    assert.equal(isTransportMismatch(new Error('HTTP 405：Method Not Allowed')), true);
    assert.equal(isTransportMismatch(new Error('HTTP 404')), true);
    assert.equal(isTransportMismatch(new Error('Failed to fetch')), false);
    assert.equal(isTransportMismatch(new Error('HTTP 500')), false);
    assert.equal(isTransportMismatch(new Error('连接结束但没有收到响应')), false);
});

test('McpClient：Streamable HTTP 端到端（initialize / tools/list / tools/call）', async () => {
    /** @type {string[]} */
    const methods = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const message = JSON.parse(body || '{}');
            methods.push(message.method);
            if (message.method === 'notifications/initialized') {
                res.writeHead(202).end();
                return;
            }
            sendJson(res, { jsonrpc: '2.0', id: message.id, result: mcpResult(message) });
        });
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const client = new McpClient({ url: `http://127.0.0.1:${port}/mcp` });
    try {
        const { tools, transport } = await client.connect();
        assert.equal(transport, 'http');
        assert.equal(tools.length, 1);
        assert.equal(tools[0].name, 'echo');

        const result = await client.callTool('echo', { text: '工作区' });
        assert.equal(summarizeResult(result), 'hi 工作区');
        assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    } finally {
        client.close();
        server.close();
    }
});

test('McpClient：显式指定 SSE 才能连旧版服务端，选 HTTP 会明确报错', async () => {
    /** @type {http.ServerResponse[]} */
    const streams = [];

    const server = http.createServer((req, res) => {
        // 旧版 SSE：GET /sse 建流
        if (req.method === 'GET' && req.url === '/sse') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            res.write('event: endpoint\ndata: /messages?sessionId=1\n\n');
            streams.push(res);
            return;
        }

        // 请求走 POST /messages，结果从上面的流里回
        if (req.method === 'POST' && req.url.startsWith('/messages')) {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                const message = JSON.parse(body || '{}');
                res.writeHead(202).end();

                if (message.id === undefined) return; // 通知不用回
                const payload = { jsonrpc: '2.0', id: message.id, result: mcpResult(message) };
                for (const stream of streams) stream.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
            });
            return;
        }

        // 对 POST /sse 装死：模拟只支持旧版 SSE 的服务端
        res.writeHead(405).end('Method Not Allowed');
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    // 1) 选错传输：必须直接失败，不能偷偷切换
    const wrong = new McpClient({ url: `http://127.0.0.1:${port}/sse`, transport: 'http' });
    try {
        await assert.rejects(() => wrong.connect(), /HTTP 405/);
    } finally {
        wrong.close();
    }

    // 2) 显式选 SSE：正常连上
    const client = new McpClient({ url: `http://127.0.0.1:${port}/sse`, transport: 'sse' });
    try {
        const { tools, transport } = await client.connect();
        assert.equal(transport, 'sse');
        assert.equal(tools[0].name, 'echo');

        const result = await client.callTool('echo', { text: 'SSE' });
        assert.equal(summarizeResult(result), 'hi SSE');
    } finally {
        client.close();
        for (const stream of streams) stream.end();
        server.close();
    }
});

test('normalizeHeaders：对象、数组两种形态，丢掉空值和非法名字', () => {
    assert.deepEqual(normalizeHeaders({ Authorization: 'Bearer x', 'X-Empty': '' }), { Authorization: 'Bearer x' });
    assert.deepEqual(
        normalizeHeaders([{ key: 'X-A', value: '1' }, { key: '', value: '2' }, { key: 'X-B', value: '  ' }]),
        { 'X-A': '1' },
    );
    // 非法 header 名会被浏览器拒绝，这里先过滤掉
    assert.deepEqual(normalizeHeaders({ 'Bad Header': 'v', 'Good-One': 'v' }), { 'Good-One': 'v' });
    assert.deepEqual(normalizeHeaders(null), {});
});

test('normalizeServer：带上请求头', () => {
    const server = normalizeServer({
        url: 'https://example.com/mcp',
        headers: [{ key: 'Authorization', value: 'Bearer abc' }],
    });
    assert.deepEqual(server.headers, { Authorization: 'Bearer abc' });
});

test('McpClient：自定义请求头会带到每个请求上', async () => {
    /** @type {Record<string, string>[]} */
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push(/** @type {any} */ (req.headers));
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const message = JSON.parse(body || '{}');
            if (message.method === 'notifications/initialized') {
                res.writeHead(202).end();
                return;
            }
            sendJson(res, { jsonrpc: '2.0', id: message.id, result: mcpResult(message) });
        });
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const client = new McpClient({
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { Authorization: 'Bearer test-token', 'X-Trace': 'abc' },
    });
    try {
        await client.connect();
        assert.equal(seen[0].authorization, 'Bearer test-token');
        assert.equal(seen[0]['x-trace'], 'abc');

        // 自定义头允许覆盖默认值
        const overriding = new McpClient({
            url: `http://127.0.0.1:${port}/mcp`,
            headers: { Accept: 'application/json' },
        });
        assert.equal(overriding.baseHeaders().Accept, 'application/json');
        overriding.close();
    } finally {
        client.close();
        server.close();
    }
});

test('toToolParameters：嵌套 schema 原样透传，不额外加 additionalProperties', () => {
    const input = {
        type: 'object',
        additionalProperties: false,
        properties: {
            query: { type: 'string', minLength: 1, pattern: '^/', description: '查询' },
            mode: { type: 'string', enum: ['fast', 'deep'] },
            tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['query'],
    };

    const params = toToolParameters(input);

    // 顶层只留三个键，`additionalProperties` 不往上传
    assert.deepEqual(Object.keys(params).sort(), ['properties', 'required', 'type']);
    assert.equal(JSON.stringify(params).includes('additionalProperties'), false);

    // 但属性里的约束原样保留
    assert.equal(params.properties.query.pattern, '^/');
    assert.equal(params.properties.query.minLength, 1);
    assert.deepEqual(params.properties.mode.enum, ['fast', 'deep']);
    assert.deepEqual(params.properties.tags.items, { type: 'string' });
});

test('toToolParameters：顶层不是 object 就退化成空参数', () => {
    assert.deepEqual(toToolParameters({ type: 'string' }), { type: 'object', properties: {} });
    assert.deepEqual(toToolParameters([{ type: 'string' }]), { type: 'object', properties: {} });
});

test('工具注册：发给模型的 parameters 不含 Gemini 不认的字段', async () => {
    const { registerWorkspaceTools } = await import('../lib/tools.js');
    const { JS_PARAMETERS } = await import('../lib/js-tool.js');

    /** @type {any[]} */
    const registered = [];
    const context = {
        registerFunctionTool: definition => registered.push(definition),
        unregisterFunctionTool: () => { },
    };
    const workspace = { isBound: () => true };

    registerWorkspaceTools(context, workspace);

    // 只扫「绝不可能是参数名」的那几个关键字；`pattern` 本身是 grep 的参数名，不能算
    const forbidden = ['additionalProperties', '$schema', 'minLength', 'maxLength', 'exclusiveMinimum', 'oneOf', 'anyOf', 'allOf'];
    const schemas = [...registered.map(item => item.parameters), JS_PARAMETERS];

    for (const schema of schemas) {
        const text = JSON.stringify(schema);
        for (const key of forbidden) {
            assert.equal(text.includes(`"${key}"`), false, `${key} 不该出现在工具参数里`);
        }
    }

    assert.equal(registered.length, 4);
});
