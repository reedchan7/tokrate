# The prompt

Paste this into your coding agent (Claude Code or anything with shell access):

> Run tokrate's installer to fix claude-hud's tok/s display
> (`curl -fsSL https://raw.githubusercontent.com/reedchan7/tokrate/main/install.sh | bash`),
> confirm the statusline now shows a persistent `⚡ tok/s (▲~▼)` segment, and if the
> script reports incompatibility, read `https://github.com/reedchan7/tokrate`'s
> `reference/` and `DESIGN.md` to port the change by hand instead.

If you'd rather run it yourself without an agent in the loop:

```bash
curl -fsSL https://raw.githubusercontent.com/reedchan7/tokrate/main/install.sh | bash
```

`install.sh` locates your installed `claude-hud` version, backs up the four files it's
about to touch, patches them, turns on the `showSpeed` display flag, and runs a real
self-test before declaring success — so either it works and tells you so, or it fails
loudly with the fallback instruction above instead of silently corrupting your install.
