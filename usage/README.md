# claudewatch-usage

The terminal rate-limit view behind the **Show usage** menu item of the
[ClaudeWatch GNOME Shell extension](https://github.com/yevhen-chernenko/claudewatch):
a live, auto-refreshing display of your Claude 5-hour and 7-day usage windows.

## Install

```sh
pipx install --force claudewatch-usage
# or: pip install --user --upgrade claudewatch-usage
```

Both put a `claudewatch-usage` command in `~/.local/bin`. Then let the session
bus start the D-Bus service the extension calls:

```sh
claudewatch-usage install-service
```

That writes one file,
`~/.local/share/dbus-1/services/io.github.yevhen_chernenko.ClaudeWatchUsage.service`;
`claudewatch-usage uninstall-service` removes it. The service
(`io.github.yevhen_chernenko.ClaudeWatchUsage`, method `Show()`) opens a
terminal running this view when the extension's **Show usage** item is
clicked, and exits by itself after ten idle minutes.

## Use

Create the opt-in token file, then run the command (or click **Show usage** in
the extension's menu):

```sh
mkdir -p ~/.config/claudewatch
ln -s ~/.claude/.credentials.json ~/.config/claudewatch/token
claudewatch-usage
```

The usage view itself is stdlib-only; the D-Bus service adds one pure-Python
dependency, [jeepney](https://pypi.org/project/jeepney/). The only network request is to
`https://api.anthropic.com/api/oauth/usage`, made with the token above.
