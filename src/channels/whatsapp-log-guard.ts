/**
 * Keeps libsignal's session dumps out of the host log.
 *
 * libsignal (under Baileys) reports session changes with
 * `console.info("Closing session:", session)` and the like, and Node prints
 * the whole SessionEntry — root key, chain keys and the ephemeral private
 * key. Under launchd or systemd stdout is the service log, so every rekey
 * wrote live Signal key material to disk.
 *
 * libsignal has no logger to inject, so its console calls are recognised by
 * their exact messages and re-logged as text only; every other argument,
 * which is where the session objects travel, is dropped. Anything else goes
 * through to the console untouched. Separate from the adapter file so that
 * refreshing the WhatsApp skill does not take the guard with it.
 */
import { log } from '../log.js';

/** libsignal 6.x console messages, and whether they help an operator diagnose. */
const LIBSIGNAL_MESSAGES: ReadonlyArray<{ prefix: string; level: 'debug' | 'warn' }> = [
  { prefix: 'Closing session:', level: 'debug' },
  { prefix: 'Opening session:', level: 'debug' },
  { prefix: 'Removing old closed session:', level: 'debug' },
  { prefix: 'Session already closed', level: 'debug' },
  { prefix: 'Session already open', level: 'debug' },
  { prefix: 'Closing open session in favor of incoming prekey bundle', level: 'debug' },
  { prefix: 'Decrypted message with closed session.', level: 'debug' },
  { prefix: 'Migrating session to:', level: 'debug' },
  { prefix: 'Unhandled bucket type (for naming):', level: 'debug' },
  { prefix: 'Failed to decrypt message with any known session', level: 'warn' },
  { prefix: 'Session error:', level: 'warn' },
  { prefix: 'V1 session storage migration error', level: 'warn' },
  { prefix: 'WARNING: Expected pubkey of length 33', level: 'warn' },
];

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error';
const GUARDED = Symbol.for('nanoclaw.whatsapp-log-guard');

export function libsignalMessage(args: unknown[]): { text: string; level: 'debug' | 'warn' } | null {
  const [first] = args;
  if (typeof first !== 'string') return null;
  const match = LIBSIGNAL_MESSAGES.find((entry) => first.startsWith(entry.prefix));
  // 'Session error:' carries the error text in the string itself; the
  // second argument is only its stack.
  return match ? { text: first.slice(0, 500), level: match.level } : null;
}

export function installLibsignalLogGuard(target: Console = console): void {
  const marked = target as Console & { [GUARDED]?: true };
  if (marked[GUARDED]) return;
  marked[GUARDED] = true;
  for (const method of ['log', 'info', 'warn', 'error'] as ConsoleMethod[]) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => {
      const message = libsignalMessage(args);
      if (!message) return original(...args);
      log[message.level](message.text, { source: 'libsignal' });
    };
  }
}

installLibsignalLogGuard();
