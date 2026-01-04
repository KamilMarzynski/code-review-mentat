import { MultiServerMCPClient } from '@langchain/mcp-adapters';

const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

export function createMCPClient(): MultiServerMCPClient {
  return new MultiServerMCPClient({
    useStandardContentBlocks: true,
    mcpServers: {
      atlassian: {
        transport: 'stdio',
        command: process.platform === 'win32' ? 'cmd' : 'sh',
        args: process.platform === 'win32'
          ? ['/c', `${npxCmd} -y mcp-remote https://mcp.atlassian.com/v1/sse 2>nul`]
          : ['-c', `${npxCmd} -y mcp-remote https://mcp.atlassian.com/v1/sse 2>/dev/null`],
        restart: { enabled: true, maxAttempts: 3, delayMs: 1000 },
      },
    },
  });
}

export async function getMCPTools(client: MultiServerMCPClient) {
  return client.getTools();
}
