import { ACCESS_KEYS } from './access-keys';

const UNLOCK_KEY = 'evlymc-access-unlocked';

function isUnlocked(): boolean {
  try {
    return localStorage.getItem(UNLOCK_KEY) === '1';
  } catch {
    return false;
  }
}

function markUnlocked(): void {
  try {
    localStorage.setItem(UNLOCK_KEY, '1');
  } catch {
    /* private mode / storage disabled: the gate will just reappear next visit */
  }
}

/**
 * Blocks until a valid name+key pair is submitted, or resolves immediately if
 * this browser already unlocked it before. Call this before anything else in
 * main.ts runs - awaiting it holds up the entire rest of module init (world,
 * player, the intro sequence, all of it) until the gate is cleared.
 */
export function waitForAccessGate(): Promise<void> {
  if (isUnlocked()) return Promise.resolve();

  const root = document.querySelector<HTMLElement>('#access-gate')!;
  const message = document.querySelector<HTMLElement>('#access-gate-message')!;
  const nameInput = document.querySelector<HTMLInputElement>('#access-gate-name')!;
  const keyInput = document.querySelector<HTMLInputElement>('#access-gate-key')!;
  const continueBtn = document.querySelector<HTMLButtonElement>('#access-gate-continue')!;

  root.hidden = false;
  nameInput.focus();

  return new Promise<void>((resolve) => {
    const setInvalid = () => {
      message.textContent = 'Invalid access key';
      message.classList.add('access-gate-error');
    };
    const setNormal = () => {
      message.textContent = 'Enter your access key';
      message.classList.remove('access-gate-error');
    };

    const submit = () => {
      const name = nameInput.value.trim();
      const key = keyInput.value.trim();
      const match = ACCESS_KEYS.some(
        (entry) => entry.name.toLowerCase() === name.toLowerCase() && entry.key === key,
      );
      if (!match || !name || !key) {
        setInvalid();
        return;
      }
      markUnlocked();
      root.hidden = true;
      resolve();
    };

    continueBtn.addEventListener('click', submit);
    for (const input of [nameInput, keyInput]) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') submit();
      });
      input.addEventListener('input', setNormal);
    }
  });
}
