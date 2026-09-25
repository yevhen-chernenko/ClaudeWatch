# SPDX-License-Identifier: GPL-2.0-or-later
#
# There's no OS-level "default terminal" standard on Linux the way there is
# a default browser/mail client (xdg-mime), so this is necessarily
# best-effort: try the user's own $TERMINAL first, then a fixed, ordered
# list of common terminal emulators, newest GNOME default first. Each entry's
# argv shape is its own "run this one command, exit when it exits" convention
# — xdg-terminal-exec takes the command as-is (and picks the user's
# configured default terminal itself); ptyxis and gnome-terminal use `--`;
# xfce4-terminal and kgx take `-e` with one command string; the rest take
# `-e` followed by the argv.

import shlex


def _bare(binary, command):
    return [binary, *command]


def _dashdash(binary, command):
    return [binary, "--", *command]


def _dash_e_argv(binary, command):
    return [binary, "-e", *command]


def _dash_e_string(binary, command):
    return [binary, "-e", shlex.join(command)]


KNOWN_TERMINALS = (
    ("xdg-terminal-exec", _bare),
    ("ptyxis", _dashdash),
    ("gnome-terminal", _dashdash),
    ("kgx", _dash_e_string),
    ("konsole", _dash_e_argv),
    ("xfce4-terminal", _dash_e_string),
    ("xterm", _dash_e_argv),
)


def pick_terminal_command(command, env_terminal, find_program):
    """Return the full argv that runs `command` (an argv list) under a terminal.

    `find_program` is `shutil.which` at the call site, injected so this stays
    testable without touching the real PATH. Returns None if no terminal
    emulator could be found at all.
    """
    known = dict(KNOWN_TERMINALS)
    candidates = list(known)
    if env_terminal:
        candidates = [env_terminal] + [n for n in candidates if n != env_terminal]

    for name in candidates:
        binary = find_program(name)
        if not binary:
            continue
        return known.get(name, _dash_e_argv)(binary, command)
    return None
