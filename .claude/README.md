# ponytail

Lazy-senior-dev mode for agents working in this repo: YAGNI, stdlib first,
shortest diff that actually works. Vendored from
[DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) v4.8.4,
MIT (`ponytail.LICENSE`).

Only the parts Claude Code reads are here — the six skills and the lifecycle
hooks. The upstream assets, benchmarks, and the adapters for other agents
(Cursor, Windsurf, Qoder, opencode, Gemini, Copilot) are not vendored.

## What you get

`skills/` is picked up automatically. Nothing to configure:

| Skill | What it does |
|-------|--------------|
| `/ponytail [lite\|full\|ultra]` | The persistent mode. Default `full`. |
| `/ponytail-review` | Review a diff for over-engineering only. |
| `/ponytail-audit` | Same, whole repo, ranked biggest-cut-first. |
| `/ponytail-debt` | Collect every `ponytail:` comment into a ledger. |
| `/ponytail-gain` | Benchmark scoreboard. |
| `/ponytail-help` | Reference card. |

Turn it off mid-session with `stop ponytail` or `/ponytail off`.

## Optional: make it automatic

The skills above are invoked on demand. `hooks/` makes ponytail load itself at
session start, survive compaction, and propagate into subagents. Wiring it up
means letting this repo register commands that run on every session, so it is
opt-in — add to `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [{ "type": "command", "timeout": 5, "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/ponytail-activate.js\"" }]
      }
    ],
    "SubagentStart": [
      {
        "hooks": [{ "type": "command", "timeout": 5, "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/ponytail-subagent.js\"" }]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [{ "type": "command", "timeout": 5, "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/ponytail-mode-tracker.js\"" }]
      }
    ]
  }
}
```

Statusline badge (`[PONYTAIL]` / `[PONYTAIL:ULTRA]`), also optional:

```json
"statusLine": { "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/ponytail-statusline.sh\"" }
```

Mode is a flag file at `~/.claude/.ponytail-active`; the default lives in
`~/.config/ponytail/config.json` or `PONYTAIL_DEFAULT_MODE`.

`hooks/package.json` exists only because the game is `"type": "module"` and
these hooks are CommonJS — without it Node parses them as ESM and session
start dies on `require`.
