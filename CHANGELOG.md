# lark-kiro-bridge

## 0.1.0

### Initial release

- Forward Feishu / Lark messages to local `kiro-cli chat` with streaming card replies.
- Per-chat × per-cwd Kiro session map (workspace plan B): switching directories preserves
  context and resumes automatically when you switch back.
- Named workspaces (`/ws save|use|list|remove`) for quick directory hopping.
- Slash commands: `/new`, `/cd`, `/pwd`, `/status`, `/stop`, `/timeout`, `/model`,
  `/reconnect`, `/doctor`, `/help`, plus pass-through for unknown commands.
- Tool-call output filtering: hides raw command stdout, surfaces a one-line summary.
- Idle watchdog with per-chat override.
- Process registry to detect duplicate bridge instances per Lark app.
- Image / file inputs forwarded to Kiro via local downloads (`~/.lark-kiro-bridge/media/`).
- v2 interactive cards with callback buttons for `/model`, `/help`, `/ws list`, `/status`.
- macOS launchd daemon with crash auto-restart and login auto-start.
- Three-tier access control: allowed users / chats / admins.
- Config and credentials stored at `~/.lark-kiro-bridge/config.json` (mode 0600).
- NDJSON daily-rotated logs with auto-pruning; secrets are redacted before write.
- Unit tests on `outputFilter`, `cardAction`, `parse`, `commands/parse`, and `SessionStore`
  (159 cases) covering the highest-risk pure-function and persistence layers.
- GitHub Actions CI on Linux + macOS × Node 20 + 22.
