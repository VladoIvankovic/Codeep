/**
 * Where the Telegram bot token lives, and how the two halves are read back.
 *
 * Deliberately separate from `telegramApproval.ts`, which stays free of I/O so
 * the parts that decide whether a stranger may approve your commands can be
 * tested without a keychain, a config file, or a network.
 *
 * The token goes in the OS keychain — it *is* the bot, and anyone holding it can
 * send messages as you. The chat id is ordinary config: it names a conversation
 * and is useless on its own.
 */

import { config } from '../config/index.js';
import { createSecureStorage } from './keychain.js';
import type { TelegramCredentials } from './telegramApproval.js';

/**
 * The keychain is keyed by provider id, and this is not a provider.
 *
 * Reusing the store rather than adding a second keychain integration is the
 * point; going through `setApiKey` is not, because that also records the id in
 * `configuredProviderIds` and Telegram would start appearing in provider lists
 * as something you could log out of.
 */
const CREDENTIAL_ID = 'telegram';

export async function setTelegramToken(token: string): Promise<void> {
  await createSecureStorage(config).setApiKey(CREDENTIAL_ID, token.trim());
}

export async function clearTelegramToken(): Promise<void> {
  await createSecureStorage(config).deleteApiKey(CREDENTIAL_ID);
}

export async function hasTelegramToken(): Promise<boolean> {
  return !!(await createSecureStorage(config).getApiKey(CREDENTIAL_ID));
}

/**
 * Both halves, or nothing.
 *
 * Returns null when the feature is off or either half is missing. Half-
 * configured must behave exactly like off: a token with no chat id would send
 * the question nowhere, and a chat id with no token cannot send at all — and
 * both would otherwise stall a run waiting for an answer that was never asked.
 */
export async function loadTelegramCredentials(): Promise<TelegramCredentials | null> {
  if (!config.get('telegramApproval')) return null;

  const chatID = String(config.get('telegramChatId') || '').trim();
  if (!chatID) return null;

  const botToken = await createSecureStorage(config).getApiKey(CREDENTIAL_ID);
  if (!botToken) return null;

  return { botToken, chatID };
}
