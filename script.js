/* ================= HELPERS ================= */
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const CHUNK_SIZE = 18; // safe MTU for ESP32 notifications (20-3 overhead)

async function sendBLEChunked(text) {
  text = text.replace(/\r\n/g, '\n');
  const encoder = new TextEncoder();

  // Split by line first to avoid cutting mid-line
  const lines = text.split('\n');
  for (let line of lines) {
    line += '\n'; // preserve newline
    let offset = 0;
    while (offset < line.length) {
      const chunk = line.slice(offset, offset + CHUNK_SIZE);
      await cmdChar.writeValue(encoder.encode(chunk));
      offset += CHUNK_SIZE;
      await delay(10); // small delay for ESP32 to process
    }
  }
}

/* ================== AI =================== */
const apiKey = 'AIzaSyAjQmkO-8q8Syeu0gX_txuiOAR4mAQ3hiU';
const url = `https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent?key=${apiKey}`;

/* ================= ACE ================= */
function getEditorPrefix(maxLines = 40) {
  const pos = editor.getCursorPosition();
  const lines = editor.session.getDocument().getAllLines();
  const start = Math.max(0, pos.row - maxLines);
  let text = '';
  for (let i = start; i < pos.row; i++) text += lines[i] + '\n';
  text += lines[pos.row].slice(0, pos.column);
  return text;
}

function insertAtCursor(text) {
  if (!text) return;
  editor.session.insert(editor.getCursorPosition(), text);
}

function getHelpContext() {
  const code = editor.getValue();
  const regex = /([\S\s][^\n]*import[\S\s][^\n]+)/g;
  const matches = [];
  let match;
  while ((match = regex.exec(code)) !== null) matches.push(match[0]);
  const imports = matches.join('\n') + '\n';

  const sel = editor.getSelectedText();
  if (sel && sel.trim()) return imports + sel;

  const pos = editor.getCursorPosition();
  return (
    'CUSOR POSTION FOR AUTOCOMPLETION' +
    JSON.stringify(pos) +
    '\nCODE:\n' +
    imports +
    editor.session.getLines(0, 10000).join('\n')
  );
}
let cuFile = 'main.py';
async function aiHelpCode(snippet) {
  setStatus('AI: running');
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `You are an ESP32 MicroPython coding assistant.

RULES
- OUTPUT CODE ONLY
- NO explanations
- NO markdown
- NO repetition
- NO CODE BLOCK ONLY THE CODE
- KEEP UNDER 20 LINE
- Valid MicroPython only
- Optimize for ESP32 (low RAM)
- NEVER return any import statement
- Never return any input
- Don't resent already existing code

TASK
Fix or complete this code:

${snippet}`,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.15,
      maxOutputTokens: 1000,
      stopSequences: ['\n\n'],
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  setStatus('Idle');
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

const editor = ace.edit('editor');
editor.setTheme('ace/theme/one_dark');
editor.session.setMode('ace/mode/python');
editor.session.setTabSize(2);
editor.session.setUseSoftTabs(true);
editor.setOptions({
  fontSize: '14px',
  wrap: true,
  showPrintMargin: false,
});
editor.setValue('# Connected file\n', -1);

let aiHelpBusy = false;

editor.commands.addCommand({
  name: 'aiCodeHelp',
  bindKey: { win: 'Ctrl-Shift-Enter', mac: 'Cmd-Shift-Enter' },
  exec: async () => {
    if (aiHelpBusy) return;
    aiHelpBusy = true;
    try {
      const ctx = getHelpContext();
      const code = await aiHelpCode(ctx);
      if (code) editor.session.insert(editor.getCursorPosition(), '\n' + code);
    } catch (e) {
      console.error(e);
    }
    aiHelpBusy = false;
  },
});

/* ================= XTERM ================= */
import { Terminal } from 'https://cdn.jsdelivr.net/npm/xterm@5.3.0/+esm';
import { FitAddon } from 'https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/+esm';

const term = new Terminal({
  cursorBlink: true,
  convertEol: true,
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal'));
fitAddon.fit();

term.element.tabIndex = 0;
term.element.addEventListener('mousedown', () => term.focus());
term.writeln('Waiting for connection...');

/* ================= SERIAL ================= */
let port;
let reader;
let writer;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let buffer = '';
let onSerialLine = null;

async function readSerial() {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    const text = decoder.decode(value);
    term.write(text);

    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();

    for (const line of lines) {
      if (onSerialLine) onSerialLine(line);
    }
  }
}

let bleLineBuffer = '';

term.onData((data) => {
  if (writer) {
    // Serial mode: send immediately
    writer.write(encoder.encode(data));
    return;
  }

  if (!cmdChar) return; // not connected

  // Handle Enter
  if (data === '\r') {
    term.write('\r\n'); // echo Enter on screen
    if (bleLineBuffer.length > 0) {
      sendBLEChunked(bleLineBuffer + '\n'); // send full line to ESP32
      bleLineBuffer = '';
    }
  }
  // Handle Backspace
  else if (data === '\u007F') {
    if (bleLineBuffer.length > 0) {
      bleLineBuffer = bleLineBuffer.slice(0, -1);
      term.write('\b \b'); // erase character visually
    }
  }
  // Normal characters
  else {
    bleLineBuffer += data;
    term.write(data); // echo typed character
  }
});

async function serialPaste(code) {
  writer.write(new Uint8Array([3]));
  await delay(80);
  writer.write(new Uint8Array([5]));
  await delay(40);
  writer.write(encoder.encode(code + '\n'));
  await delay(40);
  writer.write(new Uint8Array([4]));
}

async function syncRepl() {
  writer.write(new Uint8Array([3]));
  await delay(100);
  writer.write(new Uint8Array([3]));
  await delay(200);
}

/* ================= BLE ================= */
let bleDevice, cmdChar, stateChar;
let bleBuffer = '';
let onBLELine = null;

async function connectBLE() {
  bleDevice = await navigator.bluetooth.requestDevice({
    filters: [{ name: 'ESP32-BLE-UI' }],
    optionalServices: ['12345678-1234-5678-1234-56789abcdef0'],
  });

  const server = await bleDevice.gatt.connect();
  const service = await server.getPrimaryService(
    '12345678-1234-5678-1234-56789abcdef0'
  );

  cmdChar = await service.getCharacteristic(
    '12345678-1234-5678-1234-56789abcdef1'
  );
  stateChar = await service.getCharacteristic(
    '12345678-1234-5678-1234-56789abcdef2'
  );

  await stateChar.startNotifications();
  stateChar.addEventListener('characteristicvaluechanged', (e) => {
    const text = new TextDecoder().decode(e.target.value);
    term.write(text);

    bleBuffer += text;
    const lines = bleBuffer.split(/\r?\n/);
    bleBuffer = lines.pop();
    for (const line of lines) {
      if (onBLELine) onBLELine(line);
    }
  });

  term.writeln('[BLE Connected]');
  await listFilesBLE();
}

async function sendBLE(cmd) {
  await sendBLEChunked(cmd + '\n');
}

/* ================= FILE SYSTEM (SERIAL + BLE) ================= */
async function listFiles() {
  const files = [];
  let capture = false;

  const endPromise = new Promise((resolve) => {
    onSerialLine = (line) => {
      if (line === '<<<FILES>>>') {
        capture = true;
        return;
      }
      if (line === '<<<END>>>') {
        onSerialLine = null;
        renderFiles(files);
        resolve();
        return;
      }
      if (capture) files.push(line);
    };
  });

  await serialPaste(`
import os
print("<<<FILES>>>")
for f in os.listdir(): print(f)
print("<<<END>>>")
`);
  await endPromise;
}

async function listFilesBLE() {
  const files = [];
  let capture = false;

  const endPromise = new Promise((resolve) => {
    onBLELine = (line) => {
      if (line === '<<<FILES>>>') {
        capture = true;
        return;
      }
      if (line === '<<<END>>>') {
        onBLELine = null;
        renderFiles(files);
        resolve();
        return;
      }
      if (capture) files.push(line);
    };
  });

  await sendBLE('list');
  await endPromise;
}

function renderFiles(files) {
  const filesEl = document.getElementById('files');
  filesEl.innerHTML = '';
  files.forEach((name) => {
    const div = document.createElement('div');
    div.className = 'file';
    div.textContent = name;
    div.onclick = async () => {
      if (writer) editor.setValue(await readFileSerial(name), -1);
      else editor.setValue(await readFileBLE(name), -1);
      // set name in memory
      cuFile = name;
    };
    filesEl.appendChild(div);
  });
}

async function readFileSerial(path) {
  let content = '';
  let capture = false;

  const endPromise = new Promise((resolve) => {
    onSerialLine = (line) => {
      if (line === '<<<FILE>>>') {
        capture = true;
        return;
      }
      if (line === '<<<END>>>') {
        capture = false;
        onSerialLine = null;
        resolve();
        return;
      }
      if (capture) content += line + '\n';
    };
  });

  await serialPaste(`
print("<<<FILE>>>")
print(open("${path}").read())
print("<<<END>>>")
`);
  await endPromise;
  return content;
}

async function readFileBLE(path) {
  let content = '';
  let capture = false;

  const endPromise = new Promise((resolve) => {
    onBLELine = (line) => {
      if (line === '<<<FILE>>>') {
        capture = true;
        return;
      }
      if (line === '<<<END>>>') {
        capture = false;
        onBLELine = null;
        resolve();
        return;
      }
      if (capture) content += line + '\n';
    };
  });

  await sendBLE('read ' + path);
  await endPromise;
  return content;
}

/* ================= UI ================= */
const statusEl = document.getElementById('statusbar');
function setStatus(msg) {
  statusEl.textContent = msg;
}

document.getElementById('connect').onclick = async () => {
  if (navigator.serial) {
    try {
      port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
      reader = port.readable.getReader();
      writer = port.writable.getWriter();
      readSerial();
      await syncRepl();
      await listFiles();
      term.writeln('[Serial Connected]');
    } catch {
      await connectBLE();
    }
  } else {
    await connectBLE();
  }
};

document.getElementById('run').onclick = async () => {
  if (writer) await serialPaste(editor.getValue());
  else await sendBLE('exec ' + cuFile);
};

document.getElementById('save').onclick = async () => {
  const filename = prompt('Save as:', cuFile);
  if (!filename) return;

  if (writer) {
    await serialPaste(`
open("${filename}","w").write("""${editor
      .getValue()
      .replace(/\\/g, '\\\\')
      .replace(/"""/g, '\\"""')}""")
`);
    await listFiles();
  } else {
    await sendBLE('write ' + filename); // adds '\n'
    await sendBLEChunked(editor.getValue()); // contains MANY '\n'
    await sendBLE('\n<<<END_WRITE>>>\n'); // adds '\n' before marker
    delay(50);
    await listFilesBLE();
  }
};
