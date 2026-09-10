import { lockPointer, isTouchDevice } from './is-touch';

export type ChatCommandHandler = (args: string[]) => string | void;

type ChatOptions = {
  canvas: HTMLCanvasElement;
  /** Called with true when chat opens, false when it closes (used to lock movement). */
  onOpenChange: (open: boolean) => void;
};

/**
 * In-game chat. Press T to type; plain text is echoed as "<Player> message",
 * text starting with "/" is dispatched as a command. While open the chat owns
 * the keyboard (a capture-phase listener stops gameplay handlers).
 */
export class Chat {
  private readonly root: HTMLElement;
  private readonly log: HTMLElement;
  private readonly inputEl: HTMLElement;
  private readonly inputText: HTMLElement;
  private readonly commands = new Map<string, ChatCommandHandler>();
  private readonly lines: HTMLElement[] = [];
  private buffer = '';
  private open = false;
  private idleTimer = 0;
  /** Hidden real <input>: on a phone, focusing it raises the soft keyboard. */
  private readonly softInput = document.createElement('input');

  /** When false, slash commands are rejected (world created without "Allow Cheats"). */
  cheatsEnabled = false;

  constructor(private readonly opts: ChatOptions) {
    this.root = document.querySelector<HTMLElement>('#chat')!;
    this.log = document.querySelector<HTMLElement>('#chat-log')!;
    this.inputEl = document.querySelector<HTMLElement>('#chat-input')!;
    this.inputText = document.querySelector<HTMLElement>('#chat-input-text')!;
    document.addEventListener('keydown', this.onKeyDown, { capture: true });

    this.softInput.id = 'chat-soft-input';
    this.softInput.type = 'text';
    this.softInput.autocomplete = 'off';
    this.softInput.autocapitalize = 'off';
    this.softInput.spellcheck = false;
    this.softInput.setAttribute('enterkeyhint', 'send');
    this.root.appendChild(this.softInput);
    this.softInput.addEventListener('input', () => {
      this.buffer = this.softInput.value.slice(0, 256);
      this.inputText.textContent = this.buffer;
    });
    this.softInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.closeChat(false); }
    });
    this.softInput.addEventListener('blur', () => { if (this.open) this.closeChat(false); });
  }

  get isOpen() {
    return this.open;
  }

  /** Open the chat input (on-screen chat button; mirrors pressing T). */
  openInput() {
    if (!this.open) this.openChat();
  }

  registerCommand(name: string, handler: ChatCommandHandler) {
    this.commands.set(name.toLowerCase(), handler);
  }

  /** Add a yellow system line (also used for command feedback). */
  system(text: string) {
    this.addLine(text, 'chat-system');
  }

  /** Call every frame with delta seconds; fades old lines out while chat is closed. */
  update(delta: number) {
    if (this.open || this.lines.length === 0) return;
    this.idleTimer += delta;
    if (this.idleTimer > 8) {
      for (const line of this.lines) line.classList.add('chat-old');
    }
  }

  private addLine(text: string, cls?: string) {
    const el = document.createElement('div');
    el.className = cls ? `chat-line ${cls}` : 'chat-line';
    el.textContent = text;
    this.log.appendChild(el);
    this.lines.push(el);
    while (this.lines.length > 50) this.lines.shift()!.remove();
    this.idleTimer = 0;
    for (const line of this.lines) line.classList.remove('chat-old');
  }

  private openChat() {
    this.open = true;
    this.buffer = '';
    this.inputText.textContent = '';
    this.inputEl.hidden = false;
    this.root.classList.add('chat-open');
    for (const line of this.lines) line.classList.remove('chat-old');
    if (document.pointerLockElement) document.exitPointerLock();
    this.opts.onOpenChange(true);
    if (isTouchDevice()) {
      this.softInput.value = '';
      // focus() must run from the tap's own gesture for the keyboard to open.
      this.softInput.focus();
    }
  }

  private closeChat(regrabPointer: boolean) {
    this.open = false;
    this.buffer = '';
    this.inputEl.hidden = true;
    this.root.classList.remove('chat-open');
    this.idleTimer = 0;
    this.softInput.value = '';
    if (document.activeElement === this.softInput) this.softInput.blur();
    this.opts.onOpenChange(false);
    if (regrabPointer) lockPointer(this.opts.canvas);
  }

  private submit() {
    const raw = this.buffer.trim();
    if (raw.length === 0) {
      this.closeChat(true);
      return;
    }
    if (raw.startsWith('/')) {
      this.runCommand(raw);
    } else {
      this.addLine(`<Player> ${raw}`);
    }
    this.closeChat(true);
  }

  private runCommand(raw: string) {
    const parts = raw.slice(1).trim().split(/\s+/).filter((p) => p.length > 0);
    const name = (parts.shift() ?? '').toLowerCase();
    if (!this.cheatsEnabled) {
      this.addLine('Cheats are disabled for this world.', 'chat-error');
      return;
    }
    const handler = this.commands.get(name);
    if (!handler) {
      this.addLine(`Unknown command: /${name}`, 'chat-error');
      return;
    }
    try {
      const feedback = handler(parts);
      if (feedback) this.addLine(feedback, 'chat-system');
    } catch (err) {
      this.addLine(`Error: ${(err as Error).message}`, 'chat-error');
    }
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (!this.open) {
      if ((event.key === 't' || event.key === 'T') && !event.repeat) {
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.openChat();
      }
      return;
    }

    // Chat open: take over the keyboard.
    event.preventDefault();
    event.stopImmediatePropagation();

    if (event.key === 'Escape') {
      this.closeChat(false);
      return;
    }
    if (event.key === 'Enter') {
      this.submit();
      return;
    }
    if (event.key === 'Backspace') {
      this.buffer = this.buffer.slice(0, -1);
      this.inputText.textContent = this.buffer;
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === 'v' || event.key === 'V')) {
      navigator.clipboard?.readText()
        .then((text) => {
          this.buffer = (this.buffer + text.replace(/\s+/g, ' ')).slice(0, 256);
          this.inputText.textContent = this.buffer;
        })
        .catch(() => {});
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (this.buffer.length < 256) {
        this.buffer += event.key;
        this.inputText.textContent = this.buffer;
      }
    }
  };
}
