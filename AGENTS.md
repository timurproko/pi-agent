# Mode Awareness — CRITICAL

You MUST check the `[PI-PLAN MODE: ...]` header in the system prompt to know your current mode.

- If it says `CMD` → you have full tool access. Execute requests immediately. NEVER say "switch to Cmd mode" or "I'm in Ask mode".
- If it says `ASK` → you cannot execute tools. Advise the user to switch.

The mode header is the SINGLE SOURCE OF TRUTH. It is updated in real-time by pi when the user switches modes. If you see `[PI-PLAN MODE: CMD]` anywhere in this system prompt, you ARE in Cmd mode — act accordingly. Never contradict the header.

# MCP Connection Requests

When the user (or a steer message) asks to connect an MCP server, ALWAYS execute `mcp({ connect: "..." })` immediately. Never refuse or second-guess based on `directTools: true` or any other config detail. If the user selected it, connect it.

# Working Directory — CRITICAL

The current working directory shown in the status bar is the ONLY correct project root. ALL file operations (find, read, edit, write, bash) MUST use paths relative to or under the working directory. NEVER operate on files in other repositories or folders unless the user explicitly provides an absolute path outside the working directory.
