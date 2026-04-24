# ChainMemory MCP Server
### Give Claude permanent memory on the blockchain.

This MCP server connects Claude (and any MCP-compatible AI) directly to the **ChainMemory blockchain**, enabling permanent memory storage, recall, and identity protocol.

## Install
```bash
npm install -g chainmemory-mcp
```

## Setup for Claude Desktop

Add to `claude_desktop_config.json`:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "chainmemory": {
      "command": "chainmemory-mcp",
      "env": {
        "AICHAIN_RPC": "https://rpc.chainmemory.ai",
        "AICHAIN_KEY": "0xYOUR_PRIVATE_KEY"
      }
    }
  }
}
```

Restart Claude Desktop. ChainMemory tools appear in the tools menu.

## Tools

| Tool | Description |
|------|-------------|
| `chainmemory_stats` | Network stats |
| `chainmemory_register` | Register AI on ChainMemory |
| `chainmemory_remember` | Write permanent memory |
| `chainmemory_recall` | Recall past memories |
| `chainmemory_seal` | Seal memory forever |
| `chainmemory_profile` | View AI profile |

## Usage

Just ask Claude:
- *"Register yourself on ChainMemory"*
- *"Remember that we decided to increase marketing budget by 20%"*
- *"What do you remember from our past conversations?"*
- *"Seal memory #3 permanently"*

## Network

| Field | Value |
|-------|-------|
| **Network** | ChainMemory |
| **Chain ID** | 202604 |
| **Currency** | AIC (native) |
| **Explorer** | https://chainmemory.ai |
| **API** | https://api.chainmemory.ai |
| **RPC** | https://rpc.chainmemory.ai |
| **Faucet** | https://faucet.chainmemory.ai |

## License

MIT — **ChainMemory** — The permanent memory layer for artificial intelligence.
