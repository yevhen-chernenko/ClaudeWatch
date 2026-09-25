# SPDX-License-Identifier: GPL-2.0-or-later

import unittest

from claudewatch_usage.terminal import pick_terminal_command

COMMAND = ["/opt/venv/bin/python", "-m", "claudewatch_usage"]


def find_among(installed):
    return lambda name: f"/usr/bin/{name}" if name in installed else None


class PickTerminalCommandTest(unittest.TestCase):
    def test_none_when_no_terminal_is_on_path(self):
        self.assertIsNone(pick_terminal_command(COMMAND, None, find_among([])))

    def test_prefers_gnome_terminal_dashdash_convention(self):
        argv = pick_terminal_command(COMMAND, None, find_among(["gnome-terminal", "xterm"]))
        self.assertEqual(argv, ["/usr/bin/gnome-terminal", "--", *COMMAND])

    def test_prefers_ptyxis_over_gnome_terminal_and_xterm(self):
        argv = pick_terminal_command(
            COMMAND, None, find_among(["xterm", "gnome-terminal", "ptyxis"])
        )
        self.assertEqual(argv, ["/usr/bin/ptyxis", "--", *COMMAND])

    def test_xdg_terminal_exec_wins_and_takes_the_bare_command(self):
        argv = pick_terminal_command(
            COMMAND, None, find_among(["xdg-terminal-exec", "ptyxis"])
        )
        self.assertEqual(argv, ["/usr/bin/xdg-terminal-exec", *COMMAND])

    def test_falls_through_the_fixed_list(self):
        argv = pick_terminal_command(COMMAND, None, find_among(["xterm"]))
        self.assertEqual(argv, ["/usr/bin/xterm", "-e", *COMMAND])

    def test_string_command_terminals_get_one_quoted_argument(self):
        argv = pick_terminal_command(["/a b/python", "-m", "x"], None, find_among(["xfce4-terminal"]))
        self.assertEqual(argv, ["/usr/bin/xfce4-terminal", "-e", "'/a b/python' -m x"])

    def test_env_terminal_wins_over_known_list(self):
        argv = pick_terminal_command(COMMAND, "alacritty", find_among(["alacritty", "gnome-terminal"]))
        self.assertEqual(argv, ["/usr/bin/alacritty", "-e", *COMMAND])

    def test_env_terminal_not_installed_falls_back(self):
        argv = pick_terminal_command(COMMAND, "alacritty", find_among(["xterm"]))
        self.assertEqual(argv, ["/usr/bin/xterm", "-e", *COMMAND])

    def test_env_terminal_matching_a_known_one_keeps_its_convention(self):
        argv = pick_terminal_command(COMMAND, "gnome-terminal", find_among(["gnome-terminal"]))
        self.assertEqual(argv, ["/usr/bin/gnome-terminal", "--", *COMMAND])


if __name__ == "__main__":
    unittest.main()
