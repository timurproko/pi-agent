# pi-bash

Loads a pi-specific Bash config before user-bash commands submitted with `!` or `!!`.

## Config file

`~/.pi/agent/.bashrc`

This file is separate from your normal `~/.bashrc` so pi can have safe aliases/functions/env vars without loading interactive shell setup such as prompts, `cd` restoration, plugin init, etc.

## What gets loaded

Before each user-bash command, this extension runs:

```bash
export PI_BASH=1
export PI_AGENT_DIR="$HOME/.pi/agent"
export PI_AGENT_BASHRC="$PI_AGENT_DIR/.bashrc"
shopt -s expand_aliases
[ -f "$PI_AGENT_BASHRC" ] && source "$PI_AGENT_BASHRC"
# original user command follows
```

Then the original command runs in pi's requested working directory.

## Example `~/.pi/agent/.bashrc`

```bash
alias open='explorer.exe'
alias ll='ls -la'
export PI="$HOME/.pi/agent"
```

Then in pi:

```text
!open .
!ll
```

## Caveats

- This affects only user `!` / `!!` commands, not LLM bash tool calls.
- If your pi-specific `.bashrc` changes directory with `cd`, the command will run from that changed directory.
- Keep this file non-interactive: avoid prompt setup, long-running commands, and commands that print output on every shell startup.
