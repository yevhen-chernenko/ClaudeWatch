# claudewatch-usage

The terminal rate-limit view behind the **Show usage** menu item of the
[ClaudeWatch GNOME Shell extension](https://github.com/yevhen-chernenko/claudewatch):
a live, auto-refreshing display of your Claude 5-hour and 7-day usage windows.

## Install

```sh
pipx install claudewatch-usage
# or: pip install --user claudewatch-usage
```

Both put a `claudewatch-usage` command in `~/.local/bin`. The extension looks
there as well as on `PATH`.

## Use

Create the opt-in token file, then run the command (or click **Show usage** in
the extension's menu):

```sh
mkdir -p ~/.config/claudewatch
ln -s ~/.claude/.credentials.json ~/.config/claudewatch/token
claudewatch-usage
```

Stdlib only, no third-party dependencies. The only network request is to
`https://api.anthropic.com/api/oauth/usage`, made with the token above.
