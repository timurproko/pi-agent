# pi bash config
#
# This file is loaded only for pi user-bash commands submitted with `!` / `!!`.
# Keep it non-interactive: avoid prompt setup, long-running commands, and
# commands that print output on every shell startup.

# Aliases work because the pi-bash extension enables `expand_aliases` before
# sourcing this file.
alias open='explorer.exe'
alias ll='ls -la'
alias la='ls -la'
alias l='ls -CF'

# Useful pi-specific environment variables.
export PI="$HOME/.pi/agent"
export PI_EXTENSIONS="$PI/extensions"
export PI_PLANS="$PI/plans"
