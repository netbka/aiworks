// The Telegram alert transport (docs/design/OWNER_UI_V2.md section 9, work package WP6; docs/SUPERVISOR.md section 10).
// It sends one rendered owner alert (alerts.mjs renderAlert) as a plain-text Telegram Bot API `sendMessage`, and nothing
// else: no buttons that act, no `getUpdates`, no webhook, so no reply ever reaches AIWorks and an alert carries no
// authority. Answers stay on the dashboard on this computer, behind its own checks.
//
// - The bot credential and the chat are operator-owned secret store references (`secretRef`, `recipientRef`), resolved
//   by `resolve(ref)` inside `send` only, for that one request. Their values are never returned, stored, logged or put in
//   an error: every outcome below carries fixed words, and the provider's own description is cleaned of both values and
//   redacted before it is returned.
// - Telegram's `sendMessage` has no idempotency key, so the provider cannot deduplicate a retry (`dedup: 'none'`). The
//   outcome of every attempt is therefore classified, and only an attempt that certainly did not reach Telegram is tried
//   again:
//     delivered  Telegram answered `ok` with a message id;
//     retry      nothing reached Telegram (no credential or chat resolved, a secret store that cannot tell, a connection
//                that was never made) or Telegram refused for rate (HTTP 429): sent again later, bounded by the outbox;
//     rejected   Telegram refused the message (HTTP 4xx) or a resolved value is malformed: given up at once;
//     unknown    the request may have reached Telegram without a clear answer (time-out, reset, HTTP 5xx, an unreadable
//                answer): never sent again, so the owner gets no duplicate; the item stays in Needs me.
import { redact } from './owner-intervention.mjs';

export const TELEGRAM_API = 'https://api.telegram.org';
const TIMEOUT_MS = 15_000;
const MAX_TEXT = 3_500; // Telegram allows 4,096 characters.
const MAX_ANSWER = 64 * 1024;
const TOKEN = /^\d{5,16}:[A-Za-z0-9_-]{30,64}$/;
const CHAT = /^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
// Connection errors that happen before any byte of the request is sent.
const NOT_CONNECTED = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

/** The plain text of one alert. Dashboard addresses are written out as places on this computer, never as links that act. */
export function telegramText(alert) {
  const lines = [alert?.title, ...(Array.isArray(alert?.lines) ? alert.lines : []),
    ...(Array.isArray(alert?.buttons) ? alert.buttons : []).map((b) => (String(b?.address ?? '').startsWith('#')
      ? `${b.label}: open AIWorks on your computer (${b.address})` : `${b?.label}: ${b?.address}`)),
    'Replies here do nothing. Answer in AIWorks on your computer.']
    .map((text) => redact(text, 400)).filter(Boolean);
  const text = lines.join('\n');
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

const outcome = (kind, receipt) => ({ delivered: kind === 'delivered', outcome: kind, receipt });
const cleaned = (text, values) => redact(values.reduce((out, value) => (value ? out.split(value).join('[withheld]') : out), String(text ?? '')), 200);

/**
 * A Telegram transport for config.json `alerts.transport` `{ kind: 'telegram', secretRef, recipientRef }`.
 *   resolve(ref) -> string | null   the operator's secret store; null means absent, a throw means it cannot tell.
 *   request(url, init) -> Response  fetch; injected by tests, which never reach a network.
 */
export function telegramTransport({ secretRef, recipientRef }, { resolve, request = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (typeof resolve !== 'function') throw new TypeError('the Telegram transport needs a secret store resolver');
  return Object.freeze({
    name: 'telegram', live: true, dedup: 'none',
    async send({ alert }) {
      let token, chat;
      try { token = resolve(secretRef); chat = resolve(recipientRef); } catch { return outcome('retry', 'the secret store could not be read; nothing was sent'); }
      if (typeof token !== 'string' || !token || typeof chat !== 'string' || !chat) {
        return outcome('retry', 'a secret store reference does not resolve; nothing was sent');
      }
      if (!TOKEN.test(token) || !CHAT.test(chat)) return outcome('rejected', 'a resolved value is not a Telegram bot credential or chat; nothing was sent');
      let response;
      try {
        response = await request(`${TELEGRAM_API}/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({ chat_id: chat, text: telegramText(alert), link_preview_options: { is_disabled: true } }),
        });
      } catch (error) {
        const code = error?.cause?.code ?? error?.code;
        return NOT_CONNECTED.has(code) ? outcome('retry', `Telegram could not be reached (${code}); nothing was sent`)
          : outcome('unknown', 'the request to Telegram ended without an answer; it may have arrived, so it is not sent again');
      }
      let answer = null;
      try {
        const text = await response.text();
        answer = text.length <= MAX_ANSWER ? JSON.parse(text) : null;
      } catch { answer = null; }
      const status = Number(response?.status);
      if (status === 200 && answer?.ok === true && Number.isSafeInteger(answer?.result?.message_id)) {
        return outcome('delivered', `Telegram accepted message ${answer.result.message_id}`);
      }
      const said = answer?.description ? `: ${cleaned(answer.description, [token, chat])}` : '';
      if (status === 429) return outcome('retry', `Telegram asked to slow down (HTTP 429)${said}`);
      if (status >= 400 && status < 500) return outcome('rejected', `Telegram refused the message (HTTP ${status})${said}`);
      return outcome('unknown', `Telegram gave no clear answer (HTTP ${Number.isFinite(status) ? status : 'none'}); it may have arrived, so it is not sent again`);
    },
  });
}
