import { savePlayerName } from './player-skin';

// sessionStorage, not localStorage: a login should only stick for the current
// tab/session, not forever. The old localStorage flag (a previous version of
// this gate) let anyone who had EVER logged in bypass the gate permanently,
// even after being removed from the server-side whitelist, since it was
// never re-checked - a fresh key name here throws away every such stale
// flag on this deploy, and sessionStorage stops new ones from outliving the
// tab. A closed/reopened browser (or a new tab) always re-logs-in, so a
// whitelist removal actually takes effect.
const UNLOCK_KEY = 'evlymc-account-session';
const ACCOUNT_NAME_KEY = 'evlymc-account-name';
const API_BASE = 'https://evlymc-access.mrfierrocarrilgames.workers.dev';

function isUnlocked(): boolean {
  try {
    return sessionStorage.getItem(UNLOCK_KEY) === '1';
  } catch {
    return false;
  }
}

function markUnlocked(username: string): void {
  try {
    sessionStorage.setItem(UNLOCK_KEY, '1');
    localStorage.setItem(ACCOUNT_NAME_KEY, username); // remembered only to prefill the name field
  } catch {
    /* private mode / storage disabled: the gate will just reappear next visit */
  }
}

type ApiResult = { ok: true; username: string } | { ok: false; error: string };

async function callApi(path: '/login' | '/register', username: string, password: string): Promise<ApiResult> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; username?: string; error?: string } | null;
    if (!res.ok || !data?.ok) {
      return { ok: false, error: data?.error ?? 'Something went wrong' };
    }
    return { ok: true, username: data.username ?? username };
  } catch {
    return { ok: false, error: 'Could not reach the server - check your connection' };
  }
}

/**
 * Blocks until the player logs in or creates an account, or resolves
 * immediately if this browser already did so before. Call this before
 * anything else in main.ts runs - awaiting it holds up the entire rest of
 * module init (world, player, the intro sequence, all of it) until the gate
 * is cleared.
 *
 * Accounts (name/password, hashed server-side with PBKDF2) live in Workers KV
 * behind access-worker/ - see its README for the max-2-accounts-per-IP and
 * hashing details.
 */
export function waitForAccessGate(): Promise<void> {
  if (isUnlocked()) return Promise.resolve();

  const root = document.querySelector<HTMLElement>('#access-gate')!;
  const message = document.querySelector<HTMLElement>('#access-gate-message')!;
  const modeButtons = document.querySelector<HTMLElement>('#access-gate-mode-buttons')!;
  const loginForm = document.querySelector<HTMLFormElement>('#access-gate-login-form')!;
  const registerForm = document.querySelector<HTMLFormElement>('#access-gate-register-form')!;
  const loginUsername = document.querySelector<HTMLInputElement>('#login-username')!;
  const loginPassword = document.querySelector<HTMLInputElement>('#login-password')!;
  const registerUsername = document.querySelector<HTMLInputElement>('#register-username')!;
  const registerPassword = document.querySelector<HTMLInputElement>('#register-password')!;
  const registerPasswordConfirm = document.querySelector<HTMLInputElement>('#register-password-confirm')!;

  root.hidden = false;
  try {
    const rememberedName = localStorage.getItem(ACCOUNT_NAME_KEY);
    if (rememberedName) loginUsername.value = rememberedName;
  } catch { /* private mode */ }

  return new Promise<void>((resolve) => {
    const setMessage = (text: string, error: boolean) => {
      message.textContent = text;
      message.classList.toggle('access-gate-error', error);
    };
    const showButtons = () => {
      modeButtons.hidden = false;
      loginForm.hidden = true;
      registerForm.hidden = true;
      setMessage('Log in or create an account to continue', false);
    };
    const showLogin = () => {
      modeButtons.hidden = true;
      loginForm.hidden = false;
      registerForm.hidden = true;
      setMessage('Log in to your account', false);
      loginUsername.focus();
    };
    const showRegister = () => {
      modeButtons.hidden = true;
      loginForm.hidden = true;
      registerForm.hidden = false;
      setMessage('Create a new account', false);
      registerUsername.focus();
    };

    const succeed = (username: string) => {
      markUnlocked(username);
      savePlayerName(username);
      root.hidden = true;
      resolve();
    };

    let busy = false;

    loginForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (busy) return;
      const username = loginUsername.value.trim();
      const password = loginPassword.value;
      if (!username || !password) {
        setMessage('Enter your name and password', true);
        return;
      }
      busy = true;
      setMessage('Checking...', false);
      void callApi('/login', username, password).then((result) => {
        busy = false;
        if (!result.ok) {
          setMessage(result.error, true);
          return;
        }
        succeed(result.username);
      });
    });

    registerForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (busy) return;
      const username = registerUsername.value.trim();
      const password = registerPassword.value;
      const confirm = registerPasswordConfirm.value;

      // Client-side pre-checks are just UX - the Worker re-validates all of
      // this itself and is the only copy that actually matters.
      if (username.length < 4 || username.length > 16) {
        setMessage('Name must be 4-16 characters', true);
        return;
      }
      if (password.length < 8 || password.length > 16) {
        setMessage('Password must be 8-16 characters', true);
        return;
      }
      if (password !== confirm) {
        setMessage('Passwords do not match', true);
        return;
      }

      busy = true;
      setMessage('Creating account...', false);
      void callApi('/register', username, password).then((result) => {
        busy = false;
        if (!result.ok) {
          setMessage(result.error, true);
          return;
        }
        succeed(result.username);
      });
    });

    document.querySelector('#access-gate-show-login')!.addEventListener('click', showLogin);
    document.querySelector('#access-gate-show-register')!.addEventListener('click', showRegister);
    for (const backBtn of document.querySelectorAll('.access-gate-form [data-back]')) {
      backBtn.addEventListener('click', showButtons);
    }
  });
}
