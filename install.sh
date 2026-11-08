#!/bin/zsh
# 老入口，保留给习惯：等价于 bin/agent-hub install（参数原样转过去：--home / --no-launchd / --no-mcp）
exec "${0:A:h}/bin/agent-hub" install "$@"
