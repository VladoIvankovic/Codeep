/**
 * Raw input handling for terminal
 * Handles keypresses, special keys, and line editing
 */


export interface KeyEvent {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  raw: string;
  isPaste?: boolean; // True if this is a paste event (multiple chars at once)
}

export type KeyHandler = (event: KeyEvent) => void;

export class Input {
  private handlers: KeyHandler[] = [];
  private dataHandler: ((data: string) => void) | null = null;
  /**
   * Inside a bracketed paste whose end marker has not arrived yet: what came
   * since the paste started, or since the last hand-over. Null when none.
   */
  private pasteBuffer: string | null = null;
  private pasteTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The open paste is orphaned: its end marker was late, and what came first
   * has been handed over. The rest is still the paste — collected, its line
   * breaks kept as text — until the marker arrives or the terminal has been
   * quiet for ORPHANED_PASTE_WAIT_MS.
   */
  private pasteOrphaned = false;
  /** The line break that ended the part handed over; it goes in front of
   *  the rest, or is dropped as the paste's trailing one if nothing follows. */
  private pasteHeldBreak = false;
  
  /**
   * Start listening for input
   */
  start(): void {
    // Enable raw mode for character-by-character input
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    
    // Enable mouse tracking (SGR mode for better compatibility)
    // \x1b[?1000h - enable basic mouse tracking
    // \x1b[?1006h - enable SGR extended mouse mode
    // \x1b[?2004h - enable bracketed paste mode (wraps pastes in \x1b[200~ ... \x1b[201~)
    process.stdout.write('\x1b[?1000h\x1b[?1006h\x1b[?2004h');
    
    this.dataHandler = (data: string) => this.feed(data);
    process.stdin.on('data', this.dataHandler);
  }
  
  /**
   * Stop listening
   */
  stop(): void {
    // Remove data listener
    if (this.dataHandler) {
      process.stdin.removeListener('data', this.dataHandler);
      this.dataHandler = null;
    }
    // A paste still waiting for its end marker goes with the listener.
    this.clearPasteTimer();
    this.pasteBuffer = null;
    this.pasteOrphaned = false;
    this.pasteHeldBreak = false;
    
    // Disable mouse tracking and bracketed paste mode
    process.stdout.write('\x1b[?2004l\x1b[?1006l\x1b[?1000l');
    
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  }
  
  /**
   * Add key handler
   */
  onKey(handler: KeyHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const index = this.handlers.indexOf(handler);
      if (index !== -1) {
        this.handlers.splice(index, 1);
      }
    };
  }
  
  /**
   * Emit key event to all handlers
   */
  private emit(event: KeyEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  /**
   * One read from the terminal: a key, a paste, or several keys at once.
   *
   * A chunk is whatever arrived since the last read, so `tmux send-keys
   * "text" Enter`, a fast typist or a paste ending in a newline deliver text
   * and Enter together. Taken as one key, "text\r" went into the input with
   * the carriage return in it — a zero-width cell that left the placeholder's
   * old letter on screen ("/skills bundlesm") — and nothing was sent. Each key
   * in a chunk is its own event now (parseKeys).
   *
   * A bracketed paste (\x1b[200~ … \x1b[201~) is collected until its end
   * marker, which a long paste can deliver several reads later. If the marker
   * is late, what arrived is handed over after PASTE_END_WAIT_MS, so it is not
   * stuck out of sight, and the paste is orphaned: what follows is still
   * collected as pasted text, line breaks and all, so a paste that pauses
   * part-way can never send part of itself. It ends at the end marker, at a
   * read that is only Ctrl+C or Ctrl+D (then taken as that key), or after
   * ORPHANED_PASTE_WAIT_MS with no input at all.
   */
  feed(data: string): void {
    // Ctrl+C or Ctrl+D on its own, while an orphaned paste is still being
    // collected, is the user trying to get out — not more of the paste.
    // Taken as text, every press also restarted the wait, so there was no
    // way out. It ends the paste (what came is handed over) and is that key.
    // Inside a paste whose end marker is still coming, bytes stay text.
    if (this.pasteOrphaned && this.pasteBuffer !== null && ONLY_CTRL_C_OR_D.test(data)) {
      this.clearPasteTimer();
      this.finishPaste(this.pasteBuffer);
      for (const event of parseKeys(data)) this.emit(event);
      return;
    }
    let rest = data;
    while (rest.length > 0) {
      if (this.pasteBuffer !== null) {
        // Searched together: the end marker itself can be split between reads.
        const pasted = this.pasteBuffer + rest;
        const end = pasted.indexOf(PASTE_END);
        if (end === -1) {
          this.pasteBuffer = pasted;
          this.armPasteTimer();
          return;
        }
        this.clearPasteTimer();
        this.finishPaste(pasted.slice(0, end));
        rest = pasted.slice(end + PASTE_END.length);
        continue;
      }
      const start = rest.indexOf(PASTE_START);
      if (start === -1) {
        for (const event of parseKeys(rest)) this.emit(event);
        return;
      }
      for (const event of parseKeys(rest.slice(0, start))) this.emit(event);
      this.pasteBuffer = '';
      this.pasteOrphaned = false;
      this.pasteHeldBreak = false;
      rest = rest.slice(start + PASTE_START.length);
      if (rest.length === 0) this.armPasteTimer();
    }
  }

  /** The paste is over: hand over the rest of it and leave paste mode. */
  private finishPaste(raw: string): void {
    this.pasteBuffer = null;
    this.pasteOrphaned = false;
    this.handOverPaste(raw, true);
  }

  /**
   * Emit pasted text. One trailing line break is dropped at the end of the
   * paste (see pasteEvent); in a part handed over early it is held back
   * instead, and put in front of the next part, so the lines stay apart.
   */
  private handOverPaste(raw: string, last: boolean): void {
    // A start marker inside a paste is no text: one whose end marker was
    // lost, followed by the next paste.
    let text = normalizeLineBreaks(raw.split(PASTE_START).join(''));
    if (this.pasteHeldBreak && text.length > 0) text = '\n' + text;
    this.pasteHeldBreak = false;
    if (text.endsWith('\n')) {
      text = text.slice(0, -1);
      this.pasteHeldBreak = !last;
    }
    if (text.length > 0) this.emit({ ...blankEvent(raw), key: text, isPaste: true });
  }

  private armPasteTimer(): void {
    this.clearPasteTimer();
    this.pasteTimer = setTimeout(() => {
      this.pasteTimer = null;
      if (this.pasteBuffer === null) return;
      const text = this.pasteBuffer;
      if (this.pasteOrphaned) {
        // Quiet for long enough: the end marker is not coming.
        this.finishPaste(text);
        return;
      }
      // Late: show what came, and keep the rest of the paste a paste.
      this.pasteBuffer = '';
      this.pasteOrphaned = true;
      this.handOverPaste(text, false);
      this.armPasteTimer();
    }, this.pasteOrphaned ? ORPHANED_PASTE_WAIT_MS : PASTE_END_WAIT_MS);
  }

  private clearPasteTimer(): void {
    if (this.pasteTimer) clearTimeout(this.pasteTimer);
    this.pasteTimer = null;
  }
}

/** Bracketed paste markers (mode 2004, switched on in Input.start). */
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** A read of nothing but Ctrl+C / Ctrl+D presses (two can arrive in one read on a slow link). */
const ONLY_CTRL_C_OR_D = /^[\x03\x04]+$/;

/**
 * How long a bracketed paste waits for its end marker before what came is
 * handed over. Terminals send it, but input must not vanish into an open
 * paste for good if one never arrives.
 */
export const PASTE_END_WAIT_MS = 500;

/**
 * How long an orphaned paste (see Input.feed) waits, with no input at all,
 * for the rest of itself and its end marker before input is keys again. Long
 * enough for a paste over a slow ssh or mosh link to stall and resume.
 */
export const ORPHANED_PASTE_WAIT_MS = 5000;

/** Line breaks as the editor keeps them: a terminal sends Enter as \r. */
function normalizeLineBreaks(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function blankEvent(raw: string): KeyEvent {
  return { key: '', ctrl: false, alt: false, shift: false, raw, isPaste: false };
}

function enterEvent(raw: string): KeyEvent {
  return { ...blankEvent(raw), key: 'enter' };
}

/**
 * Text that arrived in one read. One character is a keypress, as it always
 * was; more is a paste event, which App inserts whole (LineEditor.handleKey
 * takes only one UTF-16 unit, so an emoji arrives this way too).
 */
function textEvent(text: string): KeyEvent {
  if (text.length === 1) return parseSingleKey(text);
  return { ...blankEvent(text), key: text, isPaste: true };
}

/**
 * A pasted block. Its line breaks stay text — a paste is never sent by the
 * newline in it, which is what bracketed paste is for — and one trailing line
 * break is dropped: copying a whole line brings its newline along, and kept,
 * it would leave the input on an empty second line.
 */
function pasteEvent(raw: string): KeyEvent | null {
  const text = normalizeLineBreaks(raw).replace(/\n$/, '');
  if (text.length === 0) return null;
  return { ...blankEvent(raw), key: text, isPaste: true };
}

/** Control characters other than tab and the two line breaks. */
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x1b\x7f]/;

/**
 * Split one read (with no bracketed paste in it) into key events.
 *
 * Plain text and line breaks only:
 *  - nothing but line breaks: one Enter per break (\r\n is one);
 *  - one line followed by one line break: the text, then Enter — typed or
 *    sent ahead of the Enter key, so it is sent like typing would send it;
 *  - line breaks inside the text: a multi-line paste from a terminal without
 *    bracketed paste, kept as text and not sent (see pasteEvent);
 *  - otherwise: the text.
 * Anything with escape sequences or control keys in it is cut into its keys.
 */
export function parseKeys(data: string): KeyEvent[] {
  if (data.length === 0) return [];
  if (!CONTROL.test(data)) {
    if (/^(?:\r\n|\r|\n)+$/.test(data)) {
      return (data.match(/\r\n|\r|\n/g) ?? []).map(enterEvent);
    }
    const line = /^([^\r\n]+)(\r\n|\r|\n)$/.exec(data);
    if (line) return [textEvent(line[1]), enterEvent(line[2])];
    if (/[\r\n]/.test(data)) {
      const event = pasteEvent(data);
      return event ? [event] : [];
    }
    if (data === '\t') return [parseSingleKey(data)];
    return [textEvent(data)];
  }
  return splitKeys(data).map(token => (CONTROL.test(token) || token === '\t' || /^[\r\n]/.test(token)
    ? parseSingleKey(token)
    : textEvent(token)));
}

/**
 * Cut a chunk into tokens: escape sequences, single control characters,
 * line breaks, and runs of plain text.
 */
function splitKeys(data: string): string[] {
  const tokens: string[] = [];
  let text = '';
  const flush = () => { if (text) { tokens.push(text); text = ''; } };
  let i = 0;
  while (i < data.length) {
    const ch = data[i];
    if (ch === '\x1b') {
      flush();
      const next = data[i + 1];
      // Alt/Option + arrow from terminals that send ESC + CSI/SS3 (iTerm2 with
      // Option as Esc+, urxvt, older tmux): one key, as 3.9.0 read it. Split,
      // the leading ESC was a bare Escape — it stopped the agent, cancelled a
      // stream, or denied an open "Allow this action?" for the rest of the run.
      if (next === '\x1b' && (data[i + 2] === '[' || data[i + 2] === 'O')) {
        let end: number;
        if (data[i + 2] === 'O') {
          end = Math.min(data.length, i + 4);
        } else {
          let j = i + 3;
          while (j < data.length && !(data.charCodeAt(j) >= 0x40 && data.charCodeAt(j) <= 0x7e)) j++;
          end = Math.min(data.length, j + 1);
        }
        tokens.push(data.slice(i, end));
        i = end;
        continue;
      }
      if (next === '[') {
        // CSI: parameters, then one final byte in @–~.
        let j = i + 2;
        while (j < data.length && !(data.charCodeAt(j) >= 0x40 && data.charCodeAt(j) <= 0x7e)) j++;
        if (j >= data.length) { tokens.push(data.slice(i)); break; }
        let end = j + 1;
        // A legacy (X10) mouse report carries three raw bytes after "\x1b[M".
        if (j === i + 2 && data[j] === 'M') end = Math.min(data.length, j + 4);
        const token = data.slice(i, end);
        // A stray paste marker (its partner went in another read) is no key.
        if (token !== PASTE_START && token !== PASTE_END) tokens.push(token);
        i = end;
        continue;
      }
      if (next === 'O' && i + 2 < data.length) {
        tokens.push(data.slice(i, i + 3));
        i += 3;
        continue;
      }
      if (next !== undefined && next !== '\x1b') {
        // Alt+key: ESC and the character (a whole surrogate pair for an emoji).
        const width = (data.codePointAt(i + 1) ?? 0) > 0xffff ? 2 : 1;
        tokens.push(data.slice(i, i + 1 + width));
        i += 1 + width;
        continue;
      }
      tokens.push(ch);
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      flush();
      if (ch === '\r' && data[i + 1] === '\n') {
        tokens.push('\r\n');
        i += 2;
      } else {
        tokens.push(ch);
        i++;
      }
      continue;
    }
    if (CONTROL.test(ch) || ch === '\t') {
      flush();
      tokens.push(ch);
      i++;
      continue;
    }
    text += ch;
    i++;
  }
  flush();
  return tokens;
}

/**
 * Parse one key — a single character, control code or escape sequence — into
 * a KeyEvent. This was the whole parser when a read was taken as one key;
 * parseKeys now hands it one key at a time, and pastes never reach it.
 */
function parseSingleKey(data: string): KeyEvent {
    const event: KeyEvent = {
      key: '',
      ctrl: false,
      alt: false,
      shift: false,
      raw: data,
      isPaste: false,
    };
    
    // Check for mouse scroll events (SGR format: \x1b[<button;x;yM or \x1b[<button;x;ym)
    // Button 64 = scroll up, Button 65 = scroll down
    const mouseMatch = data.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (mouseMatch) {
      const button = parseInt(mouseMatch[1], 10);
      // const x = parseInt(mouseMatch[2], 10);
      // const y = parseInt(mouseMatch[3], 10);
      // const release = mouseMatch[4] === 'm';
      
      if (button === 64) {
        // Scroll up
        event.key = 'scrollup';
        return event;
      } else if (button === 65) {
        // Scroll down
        event.key = 'scrolldown';
        return event;
      }
      // Ignore other mouse events (clicks, etc.)
      event.key = 'mouse';
      return event;
    }
    
    // Enter (also handle \r\n sent by some terminals)
    if (data === '\r' || data === '\n' || data === '\r\n') {
      event.key = 'enter';
      return event;
    }
    
    // Legacy (X10) mouse report, from a terminal without SGR mouse mode:
    // "\x1b[M" and three bytes — button, column, row — each offset by 32.
    if (data.startsWith('\x1b[M') && data.length === 6) {
      const button = data.charCodeAt(3) - 32;
      event.key = button === 64 ? 'scrollup' : button === 65 ? 'scrolldown' : 'mouse';
      return event;
    }
    
    // Ctrl+C
    if (data === '\x03') {
      event.key = 'c';
      event.ctrl = true;
      return event;
    }
    
    // Ctrl+D
    if (data === '\x04') {
      event.key = 'd';
      event.ctrl = true;
      return event;
    }
    
    // Ctrl+L
    if (data === '\x0c') {
      event.key = 'l';
      event.ctrl = true;
      return event;
    }
    
    // Ctrl+V (paste)
    if (data === '\x16') {
      event.key = 'v';
      event.ctrl = true;
      return event;
    }
    
    // Ctrl+A (go to beginning)
    if (data === '\x01') {
      event.key = 'a';
      event.ctrl = true;
      return event;
    }
    
    // Ctrl+E (go to end)
    if (data === '\x05') {
      event.key = 'e';
      event.ctrl = true;
      return event;
    }
    
    // Ctrl+U (clear line)
    if (data === '\x15') {
      event.key = 'u';
      event.ctrl = true;
      return event;
    }
    
    // Ctrl+W (delete word)
    if (data === '\x17') {
      event.key = 'w';
      event.ctrl = true;
      return event;
    }
    
    // Ctrl+K (delete to end of line)
    if (data === '\x0b') {
      event.key = 'k';
      event.ctrl = true;
      return event;
    }
    
    // Ctrl+G
    if (data === '\x07') {
      event.key = 'g';
      event.ctrl = true;
      return event;
    }
    
    // Ctrl+O
    if (data === '\x0f') {
      event.key = 'o';
      event.ctrl = true;
      return event;
    }
    
    // Ctrl+T
    if (data === '\x14') {
      event.key = 't';
      event.ctrl = true;
      return event;
    }
    
    // Backspace
    if (data === '\x7f' || data === '\b') {
      event.key = 'backspace';
      return event;
    }
    
    // Escape
    if (data === '\x1b') {
      event.key = 'escape';
      return event;
    }
    
    // Tab
    if (data === '\t') {
      event.key = 'tab';
      return event;
    }
    
    // Arrow keys and other escape sequences
    if (data.startsWith('\x1b[')) {
      const seq = data.slice(2);
      
      switch (seq) {
        case 'A':
          event.key = 'up';
          break;
        case 'B':
          event.key = 'down';
          break;
        case 'C':
          event.key = 'right';
          break;
        case 'D':
          event.key = 'left';
          break;
        case 'H':
          event.key = 'home';
          break;
        case 'F':
          event.key = 'end';
          break;
        case '3~':
          event.key = 'delete';
          break;
        case '5~':
          event.key = 'pageup';
          break;
        case '6~':
          event.key = 'pagedown';
          break;
        // Ctrl+Right (word jump forward)
        case '1;5C':
          event.key = 'ctrl-right';
          event.ctrl = true;
          break;
        // Ctrl+Left (word jump backward)
        case '1;5D':
          event.key = 'ctrl-left';
          event.ctrl = true;
          break;
        default:
          event.key = 'unknown';
      }
      
      return event;
    }
    
    // Alt+key (ESC followed by character)
    if (data.startsWith('\x1b') && data.length === 2) {
      event.key = data[1];
      event.alt = true;
      return event;
    }
    
    // Ctrl+letter (0x01-0x1a maps to a-z)
    const code = data.charCodeAt(0);
    if (code >= 1 && code <= 26) {
      event.key = String.fromCharCode(code + 96); // 1 -> 'a', etc.
      event.ctrl = true;
      return event;
    }
    
    // Regular character
    event.key = data;
    
    return event;
}

/**
 * Simple line editor with cursor support
 */
export class LineEditor {
  private value = '';
  private cursorPos = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private tempValue = '';
  
  getValue(): string {
    return this.value;
  }
  
  getCursorPos(): number {
    return this.cursorPos;
  }
  
  setValue(value: string): void {
    this.value = value;
    this.cursorPos = value.length;
  }
  
  clear(): void {
    this.value = '';
    this.cursorPos = 0;
    this.historyIndex = -1;
  }
  
  /**
   * Insert text at cursor position
   */
  insert(text: string): void {
    this.value = this.value.slice(0, this.cursorPos) + text + this.value.slice(this.cursorPos);
    this.cursorPos += text.length;
  }
  
  /**
   * Set cursor position
   */
  setCursorPos(pos: number): void {
    this.cursorPos = Math.max(0, Math.min(pos, this.value.length));
  }
  
  /**
   * Check if character is a word boundary (space, path separator, punctuation)
   */
  private isWordBoundary(ch: string): boolean {
    return ' \t/\\.-_:'.includes(ch);
  }

  /**
   * Move cursor to previous word boundary (Ctrl+Left)
   */
  wordLeft(): void {
    if (this.cursorPos === 0) return;
    let i = this.cursorPos - 1;
    // Skip current boundary chars
    while (i > 0 && this.isWordBoundary(this.value[i])) i--;
    // Move to start of word
    while (i > 0 && !this.isWordBoundary(this.value[i - 1])) i--;
    this.cursorPos = i;
  }

  /**
   * Move cursor to next word boundary (Ctrl+Right)
   */
  wordRight(): void {
    const len = this.value.length;
    if (this.cursorPos >= len) return;
    let i = this.cursorPos;
    // Skip current word chars
    while (i < len && !this.isWordBoundary(this.value[i])) i++;
    // Skip boundary chars
    while (i < len && this.isWordBoundary(this.value[i])) i++;
    this.cursorPos = i;
  }

  /**
   * Delete word backward (Ctrl+W) — respects path separators
   */
  deleteWordBackward(): void {
    if (this.cursorPos === 0) return;
    
    const afterCursor = this.value.slice(this.cursorPos);
    let i = this.cursorPos - 1;
    // Skip trailing spaces
    while (i >= 0 && this.value[i] === ' ') i--;
    // Delete back to next word boundary
    while (i >= 0 && !this.isWordBoundary(this.value[i])) i--;
    
    const newBefore = this.value.slice(0, i + 1);
    this.value = newBefore + afterCursor;
    this.cursorPos = newBefore.length;
  }
  
  /**
   * Delete to end of line (Ctrl+K)
   */
  deleteToEnd(): void {
    this.value = this.value.slice(0, this.cursorPos);
  }
  
  addToHistory(value: string): void {
    if (value.trim()) {
      this.history.push(value);
      // Keep last 100 entries
      if (this.history.length > 100) {
        this.history.shift();
      }
    }
    this.historyIndex = -1;
  }
  
  /**
   * Handle key event, returns true if value changed
   */
  handleKey(event: KeyEvent): boolean {
    const oldValue = this.value;
    const oldCursor = this.cursorPos;
    
    switch (event.key) {
      case 'backspace':
        if (this.cursorPos > 0) {
          this.value = this.value.slice(0, this.cursorPos - 1) + this.value.slice(this.cursorPos);
          this.cursorPos--;
        }
        break;
        
      case 'delete':
        if (this.cursorPos < this.value.length) {
          this.value = this.value.slice(0, this.cursorPos) + this.value.slice(this.cursorPos + 1);
        }
        break;
        
      case 'left':
        if (this.cursorPos > 0) {
          this.cursorPos--;
        }
        break;
        
      case 'right':
        if (this.cursorPos < this.value.length) {
          this.cursorPos++;
        }
        break;
        
      case 'ctrl-left':
        this.wordLeft();
        break;
        
      case 'ctrl-right':
        this.wordRight();
        break;
        
      case 'home':
        this.cursorPos = 0;
        break;
        
      case 'end':
        this.cursorPos = this.value.length;
        break;
        
      case 'up':
        if (this.history.length > 0) {
          if (this.historyIndex === -1) {
            this.tempValue = this.value;
            this.historyIndex = this.history.length - 1;
          } else if (this.historyIndex > 0) {
            this.historyIndex--;
          }
          this.value = this.history[this.historyIndex];
          this.cursorPos = this.value.length;
        }
        break;
        
      case 'down':
        if (this.historyIndex !== -1) {
          if (this.historyIndex < this.history.length - 1) {
            this.historyIndex++;
            this.value = this.history[this.historyIndex];
          } else {
            this.historyIndex = -1;
            this.value = this.tempValue;
          }
          this.cursorPos = this.value.length;
        }
        break;
        
      default:
        // Alt+b / Alt+f — word jump (macOS Option+Left/Right)
        if (event.alt && event.key === 'b') {
          this.wordLeft();
        } else if (event.alt && event.key === 'f') {
          this.wordRight();
        }
        // Regular character (single char, not control)
        else if (event.key.length === 1 && !event.ctrl && !event.alt) {
          this.value = this.value.slice(0, this.cursorPos) + event.key + this.value.slice(this.cursorPos);
          this.cursorPos++;
        }
    }
    
    return this.value !== oldValue || this.cursorPos !== oldCursor;
  }
}
