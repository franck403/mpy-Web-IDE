import bluetooth
import time
import gc
from micropython import const
from machine import Pin
import _thread
import os
import machine
from collections import deque
import sys
import io

# ================= CONSTANTS =================
_IRQ_CENTRAL_CONNECT    = const(1)
_IRQ_CENTRAL_DISCONNECT = const(2)
_IRQ_GATTS_WRITE        = const(3)

ADV_INTERVAL_US = 100_000
HEARTBEAT_MS = 1000

SERVICE_UUID = bluetooth.UUID("12345678-1234-5678-1234-56789abcdef0")
CMD_UUID     = bluetooth.UUID("12345678-1234-5678-1234-56789abcdef1")
STATE_UUID   = bluetooth.UUID("12345678-1234-5678-1234-56789abcdef2")

WRITE_END = b"<<<END_WRITE>>>"
CMD_MAX = 512

# ================= HARDWARE =================
led = Pin(2, Pin.OUT)

# ================= GLOBAL STATE =================
notify_queue = deque((), 200)
rx_buffer = bytearray()
write_mode = False
write_file = None

# ================= EXEC WITH BLE OUTPUT =================
def run_cmd(cmd, notify):
    cmd = cmd.replace("exec", "", 1).strip()
    notify(b"<<<EXEC>>>")

    buf = io.StringIO()
    old_stdout = sys.stdout
    old_stderr = sys.stderr

    try:
        sys.stdout = buf
        sys.stderr = buf
        if cmd.endswith(".py"):
            with open(cmd) as f:
                exec(f.read(), globals())
        else:
            exec(cmd, globals())
    except Exception as e:
        buf.write("error: " + str(e))
    finally:
        sys.stdout = old_stdout
        sys.stderr = old_stderr

    out = buf.getvalue()
    if out:
        for line in out.splitlines():
            notify(line.encode())
    notify(b"<<<END_EXEC>>>")

# ================= BLE CONTROL =================
class BLEControl:
    def __init__(self):
        self.ble = bluetooth.BLE()
        self.ble.active(True)
        self.ble.irq(self._irq)
        self.conn_handle = None
        self.last_beat = time.ticks_ms()
        self._register()
        self._advertise()

    def _register(self):
        service = (
            SERVICE_UUID,
            (
                (CMD_UUID, bluetooth.FLAG_WRITE),
                (STATE_UUID, bluetooth.FLAG_NOTIFY),
            ),
        )
        ((self.cmd_handle, self.state_handle),) = \
            self.ble.gatts_register_services((service,))

    def _advertise(self):
        name = b"ESP32-BLE-UI"
        adv = b"\x02\x01\x06" + bytes((len(name) + 1, 0x09)) + name
        self.ble.gap_advertise(ADV_INTERVAL_US, adv)

    # ================= IRQ =================
    def _irq(self, event, data):
        if event == _IRQ_CENTRAL_CONNECT:
            self.conn_handle, _, _ = data

        elif event == _IRQ_CENTRAL_DISCONNECT:
            self.conn_handle = None
            time.sleep_ms(200)
            self._advertise()

        elif event == _IRQ_GATTS_WRITE:
            conn, attr = data
            if attr == self.cmd_handle:
                chunk = self.ble.gatts_read(self.cmd_handle)
                if chunk:
                    rx_buffer.extend(chunk)
                    self._process_rx()

    # ================= RX PROCESS =================
    def _process_rx(self):
        global rx_buffer, write_mode, write_file

        while True:
            if write_mode:
                end_idx = rx_buffer.find(WRITE_END)
                if end_idx != -1:
                    self._write_lines(rx_buffer[:end_idx])
                    write_file.close()
                    write_file = None
                    write_mode = False
                    rx_buffer = rx_buffer[end_idx + len(WRITE_END):]
                    self.notify_line(b"<<<END>>>")
                    continue

                nl = rx_buffer.find(b"\n")
                if nl == -1:
                    return

                write_file.write(rx_buffer[:nl + 1])
                rx_buffer = rx_buffer[nl + 1:]
                continue

            nl = rx_buffer.find(b"\n")
            if nl == -1:
                if len(rx_buffer) > CMD_MAX:
                    rx_buffer[:] = b""
                    self.notify_line(b"error: cmd too long")
                return

            line = rx_buffer[:nl]
            rx_buffer = rx_buffer[nl + 1:]
            self._handle_command(line)

    def _write_lines(self, data):
        while True:
            nl = data.find(b"\n")
            if nl == -1:
                break
            write_file.write(data[:nl + 1])
            data = data[nl + 1:]

    # ================= COMMAND HANDLER =================
    def _handle_command(self, raw):
        global write_mode, write_file

        try:
            cmd = raw.decode().strip()
        except:
            return

        self.notify_line(b"> " + cmd.encode())

        if cmd == "help":
            self.notify_line(
                b"help, on, off, status, list, read <f>, write <f>, delete <f>, exec <code>, reboot"
            )

        elif cmd == "on":
            led.value(1)

        elif cmd == "off":
            led.value(0)

        elif cmd == "status":
            self.notify_line(b"STATUS OK")

        elif cmd == "list":
            self.notify_line(b"<<<FILES>>>")
            for f in os.listdir():
                self.notify_line(f.encode())
            self.notify_line(b"<<<END>>>")

        elif cmd.startswith("read "):
            fn = cmd[5:].strip()
            self.notify_line(b"<<<FILE>>>")
            try:
                with open(fn, "rb") as f:
                    while True:
                        b = f.read(128)
                        if not b:
                            break
                        notify_queue.append(b)
            except Exception as e:
                self.notify_line(b"error: " + str(e).encode())
            self.notify_line(b"<<<END>>>")

        elif cmd.startswith("write "):
            fn = cmd[6:].strip()
            try:
                write_file = open(fn, "wb")
                write_mode = True
                rx_buffer[:] = b""
                self.notify_line(b"<<<WRITE>>>")
            except Exception as e:
                self.notify_line(b"error: " + str(e).encode())

        elif cmd.startswith("delete "):
            try:
                os.remove(cmd[7:].strip())
            except Exception as e:
                self.notify_line(b"error: " + str(e).encode())

        elif cmd.startswith("exec"):
            _thread.start_new_thread(run_cmd, (cmd, self.notify_line))

        elif cmd == "reboot":
            machine.reset()

        else:
            try:
                exec(cmd, globals())
            except Exception as e:
                self.notify_line(b"error: " + str(e).encode())

    # ================= NOTIFY =================
    def notify_line(self, line):
        if isinstance(line, str):
            line = line.encode()
        if not line.endswith(b"\n"):
            line += b"\n"
        notify_queue.append(line)

    def process_notifications(self):
        if self.conn_handle is None or not notify_queue:
            return

        try:
            mtu = self.ble.config("mtu")
            size = max(20, mtu - 3)
        except:
            size = 20

        while notify_queue:
            data = notify_queue.popleft()
            mv = memoryview(data)
            i = 0
            while i < len(mv):
                try:
                    self.ble.gatts_notify(
                        self.conn_handle,
                        self.state_handle,
                        mv[i:i + size]
                    )
                    i += size
                    time.sleep_ms(6)
                except OSError:
                    notify_queue.appendleft(bytes(mv[i:]))
                    gc.collect()
                    return
            machine.idle()

    def heartbeat(self):
        now = time.ticks_ms()
        if time.ticks_diff(now, self.last_beat) > HEARTBEAT_MS:
            self.last_beat = now
            if self.conn_handle is None:
                led.value((now // 500) & 1)

# ================= MAIN LOOP =================
ble = BLEControl()

while True:
    ble.heartbeat()
    ble.process_notifications()
    gc.collect()
    time.sleep_ms(40)


