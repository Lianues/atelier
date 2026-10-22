/**
 * MCP 工具桥：把 MCP server 的 tools 注册成酒馆的函数工具。
 *
 * 命名：`mcp_<服务器>_<工具>`（小写、下划线、总长 ≤ 60）。
 * 参数：直接用 MCP 的 inputSchema 转成酒馆能吃的 JSON Schema。
 * 生命周期：服务器连上就注册，断开就注销；`shouldRegister` 再兜一层，没连上就不发给模型。
 */

import { sanitizeToolName, summarizeResult, toToolParameters } from './mcp-client.js';

const MAX_DESCRIPTION = 900;

export class McpToolRegistry {
    /**
     * @param {any} context getContext()
     */
    constructor(context) {
        this.context = context;
        /** @type {Map<string, string[]>} serverId -> 注册的工具名 */
        this.registered = new Map();
    }

    /**
     * @param {{id: string, name: string, url: string}} server
     * @param {import('./mcp-client.js').McpClient} client
     * @param {any[]} tools
     * @returns {string[]} 实际注册的工具名
     */
    registerServer(server, client, tools) {
        this.unregisterServer(server.id);

        const used = new Set([...this.registered.values()].flat());
        const names = [];

        for (const tool of tools) {
            if (!tool?.name) continue;

            let name = sanitizeToolName(server.name, tool.name);
            let suffix = 2;
            while (used.has(name)) {
                name = sanitizeToolName(server.name, `${tool.name}_${suffix}`);
                suffix += 1;
            }
            used.add(name);

            const description = String(tool.description ?? tool.title ?? tool.name).slice(0, MAX_DESCRIPTION);

            try {
                this.context.registerFunctionTool({
                    name,
                    displayName: `${server.name} · ${tool.title || tool.name}`,
                    description,
                    parameters: toToolParameters(tool.inputSchema),
                    action: async (args) => {
                        try {
                            const result = await client.callTool(tool.name, args);
                            return summarizeResult(result) || '(空结果)';
                        } catch (error) {
                            return `MCP 调用失败：${error?.message ?? error}`;
                        }
                    },
                    shouldRegister: () => client.connected,
                });
                names.push(name);
            } catch (error) {
                console.warn(`[atelier] 注册 MCP 工具 ${name} 失败`, error);
            }
        }

        this.registered.set(server.id, names);
        return names;
    }

    /**
     * @param {string} serverId
     * @returns {void}
     */
    unregisterServer(serverId) {
        const names = this.registered.get(serverId);
        if (!names) return;

        for (const name of names) {
            try {
                this.context.unregisterFunctionTool(name);
            } catch (error) {
                console.warn(`[atelier] 注销 MCP 工具 ${name} 失败`, error);
            }
        }
        this.registered.delete(serverId);
    }

    /**
     * @returns {number}
     */
    count() {
        let total = 0;
        for (const names of this.registered.values()) total += names.length;
        return total;
    }

    /**
     * @returns {void}
     */
    unregisterAll() {
        for (const serverId of [...this.registered.keys()]) this.unregisterServer(serverId);
    }
}
