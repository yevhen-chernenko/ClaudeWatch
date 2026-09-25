# SPDX-License-Identifier: GPL-2.0-or-later
#
# The D-Bus side of `claudewatch-usage`: the ClaudeWatch GNOME Shell
# extension calls Show() on this service instead of spawning anything itself,
# and the service opens the terminal running the usage view. Started on demand
# by the session bus once `claudewatch-usage install-service` has put its
# activation file in place, or by hand with `claudewatch-usage service`.

import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

from jeepney import (
    DBusNameFlags,
    HeaderFields,
    MessageType,
    message_bus,
    new_error,
    new_method_return,
)
from jeepney.io.blocking import open_dbus_connection

from .terminal import pick_terminal_command

BUS_NAME = "io.github.yevhen_chernenko.ClaudeWatchUsage"
OBJECT_PATH = "/io/github/yevhen_chernenko/ClaudeWatchUsage"
INTERFACE = BUS_NAME
NO_TERMINAL_ERROR = f"{BUS_NAME}.Error.NoTerminal"
LAUNCH_FAILED_ERROR = f"{BUS_NAME}.Error.LaunchFailed"

# Each Show() only needs the service alive for as long as it takes to open a
# terminal, so an activated instance exits once it has been idle this long —
# the bus starts it again on the next call.
IDLE_TIMEOUT_SECONDS = 10 * 60

INTROSPECTION_XML = f"""<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
  <interface name="org.freedesktop.DBus.Peer">
    <method name="Ping"/>
  </interface>
  <interface name="org.freedesktop.DBus.Introspectable">
    <method name="Introspect">
      <arg type="s" name="xml_data" direction="out"/>
    </method>
  </interface>
  <interface name="{INTERFACE}">
    <method name="Show"/>
  </interface>
</node>
"""


class ServiceError(Exception):
    def __init__(self, error_name, message):
        super().__init__(message)
        self.error_name = error_name


def show_usage():
    # `-m claudewatch_usage` under this same interpreter rather than a PATH
    # lookup for the console script: a D-Bus-activated service doesn't get
    # the login shell's PATH, so ~/.local/bin (pipx/--user) isn't visible.
    command = [sys.executable, "-m", "claudewatch_usage"]
    argv = pick_terminal_command(command, os.environ.get("TERMINAL"), shutil.which)
    if argv is None:
        raise ServiceError(NO_TERMINAL_ERROR, "No terminal emulator found on PATH")
    try:
        subprocess.Popen(argv, start_new_session=True)
    except OSError as error:
        raise ServiceError(LAUNCH_FAILED_ERROR, f"Failed to launch terminal: {error}")


def reply_to(message):
    header = message.header.fields
    interface = header.get(HeaderFields.interface)
    member = header.get(HeaderFields.member)
    path = header.get(HeaderFields.path)

    if interface == "org.freedesktop.DBus.Peer" and member == "Ping":
        return new_method_return(message)
    if (
        interface == "org.freedesktop.DBus.Introspectable"
        and member == "Introspect"
        and path in (OBJECT_PATH, "/")
    ):
        return new_method_return(message, "s", (INTROSPECTION_XML,))
    if path == OBJECT_PATH and interface in (INTERFACE, None) and member == "Show":
        try:
            show_usage()
        except ServiceError as error:
            return new_error(message, error.error_name, "s", (str(error),))
        return new_method_return(message)
    return new_error(
        message,
        "org.freedesktop.DBus.Error.UnknownMethod",
        "s",
        (f"No such method {interface}.{member} on {path}",),
    )


def run_service():
    # Launched terminals are fire-and-forget; auto-reap them instead of
    # leaving zombies for the life of the service.
    signal.signal(signal.SIGCHLD, signal.SIG_IGN)

    connection = open_dbus_connection(bus="SESSION")
    with connection:
        # Not send_and_get_reply(): when the bus activated us for a pending
        # Show(), it can deliver that call before the RequestName reply, and
        # send_and_get_reply() discards every message that isn't the reply —
        # the caller would then wait for an answer until its timeout.
        request = message_bus.RequestName(BUS_NAME, flags=DBusNameFlags.do_not_queue)
        request_serial = next(connection.outgoing_serial)
        connection.send_message(request, serial=request_serial)

        deadline = time.monotonic() + IDLE_TIMEOUT_SECONDS
        while True:
            try:
                message = connection.receive(
                    timeout=max(0.0, deadline - time.monotonic())
                )
            except TimeoutError:
                return 0
            fields = message.header.fields
            if fields.get(HeaderFields.reply_serial) == request_serial:
                if (
                    message.header.message_type != MessageType.method_return
                    or message.body[0] != 1  # DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER
                ):
                    print(f"{BUS_NAME} is already running.", file=sys.stderr)
                    return 1
                continue
            if message.header.message_type != MessageType.method_call:
                continue
            deadline = time.monotonic() + IDLE_TIMEOUT_SECONDS
            response = reply_to(message)
            # NO_REPLY_EXPECTED callers don't want an answer.
            if not message.header.flags & 0x1:
                connection.send_message(response)


def service_file_path():
    data_home = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(data_home) / "dbus-1" / "services" / f"{BUS_NAME}.service"


def _quote_exec(argument):
    return f'"{argument}"' if " " in argument else argument


def install_service():
    path = service_file_path()
    exec_line = " ".join(
        _quote_exec(part)
        for part in (sys.executable, "-m", "claudewatch_usage", "service")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"[D-BUS Service]\nName={BUS_NAME}\nExec={exec_line}\n")
    print(f"Wrote {path}")
    print("Show usage in the ClaudeWatch menu will now start this on demand.")
    return 0


def uninstall_service():
    path = service_file_path()
    try:
        path.unlink()
    except FileNotFoundError:
        print(f"Nothing to remove at {path}")
    else:
        print(f"Removed {path}")
    return 0
