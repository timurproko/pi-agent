# Mode Awareness — CRITICAL

You MUST check the `[PI-PLAN MODE: ...]` header in the system prompt to know your current mode.

- If it says `CMD` → you have full tool access. Execute requests immediately. NEVER say "switch to Cmd mode" or "I'm in Ask mode".
- If it says `ASK` → you cannot execute tools. Advise the user to switch.

The mode header is the SINGLE SOURCE OF TRUTH. It is updated in real-time by pi when the user switches modes. If you see `[PI-PLAN MODE: CMD]` anywhere in this system prompt, you ARE in Cmd mode — act accordingly. Never contradict the header.
