const UNLOCK_KEY = 'evlymc-access-unlocked';
const VALIDATE_URL = 'https://evlymc-access.mrfierrocarrilgames.workers.dev/validate';

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
 *
 * Validation happens server-side (access-worker/, a Cloudflare Worker backed
 * by KV) so the key list and "used" state never ship in this client bundle.
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
    const setMessage = (text: string, error: boolean) => {
      message.textContent = text;
      message.classList.toggle('access-gate-error', error);
    };
    const setNormal = () => setMessage('Enter your access key', false);

    let checking = false;
    const submit = async () => {
      if (checking) return;
      const name = nameInput.value.trim();
      const key = keyInput.value.trim();
      if (!name || !key) {
        setMessage('Invalid access key', true);
        return;
      }

      checking = true;
      continueBtn.disabled = true;
      setMessage('Checking...', false);
      try {
        const res = await fetch(VALIDATE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, key }),
        });
        const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !data?.ok) {
          setMessage(data?.error ?? 'Invalid access key', true);
          return;
        }
        markUnlocked();
        root.hidden = true;
        resolve();
      } catch {
        setMessage('Could not reach the server - check your connection', true);
      } finally {
        checking = false;
        continueBtn.disabled = false;
      }
    };

    continueBtn.addEventListener('click', () => { void submit(); });
    for (const input of [nameInput, keyInput]) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') void submit();
      });
      input.addEventListener('input', setNormal);
    }
  });
}
