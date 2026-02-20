/**
 * Key event handlers for inline UI panels.
 *
 * Each handler receives a context object that exposes only the state slices
 * and callbacks it needs, keeping the handlers decoupled from App internals.
 */

import { KeyEvent } from './Input';
import { SelectItem } from './components/SelectScreen';
import { ConfirmOptions } from './App';
import { helpCategories, keyboardShortcuts } from './components/Help';
import { spawn } from 'child_process';
import clipboardy from 'clipboardy';

// ─── Status ──────────────────────────────────────────────────────────────────

export interface StatusHandlerContext {
  close(): void;
  render(): void;
}

export function handleInlineStatusKey(event: KeyEvent, ctx: StatusHandlerContext): void {
  if (event.key === 'escape' || event.key === 'q') {
    ctx.close();
    ctx.render();
  }
}

// ─── Help ────────────────────────────────────────────────────────────────────

export interface HelpHandlerContext {
  scrollIndex: number;
  setScrollIndex(v: number): void;
  close(): void;
  render(): void;
}

export function handleInlineHelpKey(event: KeyEvent, ctx: HelpHandlerContext): void {
  if (event.key === 'escape' || event.key === 'q') {
    ctx.close();
    ctx.render();
    return;
  }

  let totalItems = 0;
  for (const cat of helpCategories) {
    totalItems += 1 + cat.items.length;
  }
  totalItems += 1 + keyboardShortcuts.length;

  if (event.key === 'down') {
    ctx.setScrollIndex(Math.min(ctx.scrollIndex + 1, Math.max(0, totalItems - 5)));
    ctx.render();
  } else if (event.key === 'up') {
    ctx.setScrollIndex(Math.max(0, ctx.scrollIndex - 1));
    ctx.render();
  } else if (event.key === 'pagedown') {
    ctx.setScrollIndex(Math.min(ctx.scrollIndex + 5, Math.max(0, totalItems - 5)));
    ctx.render();
  } else if (event.key === 'pageup') {
    ctx.setScrollIndex(Math.max(0, ctx.scrollIndex - 5));
    ctx.render();
  }
}

// ─── Menu ────────────────────────────────────────────────────────────────────

export interface MenuHandlerContext {
  index: number;
  items: SelectItem[];
  setIndex(v: number): void;
  close(callback: ((item: SelectItem) => void) | null, selected: SelectItem | null): void;
  render(): void;
}

export function handleMenuKey(event: KeyEvent, ctx: MenuHandlerContext): void {
  if (event.key === 'escape') {
    ctx.close(null, null);
    ctx.render();
    return;
  }

  if (event.key === 'up') {
    ctx.setIndex(Math.max(0, ctx.index - 1));
    ctx.render();
    return;
  }

  if (event.key === 'down') {
    ctx.setIndex(Math.min(ctx.items.length - 1, ctx.index + 1));
    ctx.render();
    return;
  }

  if (event.key === 'pageup') {
    ctx.setIndex(Math.max(0, ctx.index - 5));
    ctx.render();
    return;
  }

  if (event.key === 'pagedown') {
    ctx.setIndex(Math.min(ctx.items.length - 1, ctx.index + 5));
    ctx.render();
    return;
  }

  if (event.key === 'enter') {
    const selected = ctx.items[ctx.index];
    ctx.close(null, selected);
    ctx.render();
  }
}

// ─── Permission ──────────────────────────────────────────────────────────────

const PERMISSION_OPTIONS = ['read', 'write', 'none'] as const;
type PermissionLevel = typeof PERMISSION_OPTIONS[number];

export interface PermissionHandlerContext {
  index: number;
  setIndex(v: number): void;
  close(level: PermissionLevel): void;
  render(): void;
}

export function handleInlinePermissionKey(event: KeyEvent, ctx: PermissionHandlerContext): void {
  if (event.key === 'escape') {
    ctx.close('none');
    ctx.render();
    return;
  }

  if (event.key === 'up') {
    ctx.setIndex(Math.max(0, ctx.index - 1));
    ctx.render();
    return;
  }

  if (event.key === 'down') {
    ctx.setIndex(Math.min(PERMISSION_OPTIONS.length - 1, ctx.index + 1));
    ctx.render();
    return;
  }

  if (event.key === 'enter') {
    ctx.close(PERMISSION_OPTIONS[ctx.index]);
    ctx.render();
  }
}

// ─── Session Picker ──────────────────────────────────────────────────────────

export interface SessionItem {
  name: string;
  messageCount: number;
  createdAt: string;
}

export interface SessionPickerHandlerContext {
  index: number;
  items: SessionItem[];
  deleteMode: boolean;
  hasDeleteCallback: boolean;
  setIndex(v: number): void;
  setItems(items: SessionItem[]): void;
  setDeleteMode(v: boolean): void;
  close(sessionName: string | null): void;
  onDelete(sessionName: string): void;
  notify(msg: string): void;
  render(): void;
}

export function handleInlineSessionPickerKey(event: KeyEvent, ctx: SessionPickerHandlerContext): void {
  if (event.key === 'n' && !ctx.deleteMode) {
    ctx.close(null);
    ctx.render();
    return;
  }

  if (event.key === 'd' && ctx.hasDeleteCallback && ctx.items.length > 0) {
    ctx.setDeleteMode(!ctx.deleteMode);
    ctx.render();
    return;
  }

  if (event.key === 'escape') {
    if (ctx.deleteMode) {
      ctx.setDeleteMode(false);
      ctx.render();
      return;
    }
    ctx.close(null);
    ctx.render();
    return;
  }

  if (event.key === 'up') {
    ctx.setIndex(Math.max(0, ctx.index - 1));
    ctx.render();
    return;
  }

  if (event.key === 'down') {
    ctx.setIndex(Math.min(ctx.items.length - 1, ctx.index + 1));
    ctx.render();
    return;
  }

  if (event.key === 'enter' && ctx.items.length > 0) {
    const selected = ctx.items[ctx.index];

    if (ctx.deleteMode) {
      ctx.onDelete(selected.name);
      const newItems = ctx.items.filter(s => s.name !== selected.name);
      ctx.setItems(newItems);
      ctx.setIndex(Math.min(ctx.index, Math.max(0, newItems.length - 1)));
      if (newItems.length === 0) ctx.setDeleteMode(false);
      ctx.notify(`Deleted: ${selected.name}`);
      ctx.render();
      return;
    }

    ctx.close(selected.name);
    ctx.render();
  }
}

// ─── Confirm ─────────────────────────────────────────────────────────────────

export interface ConfirmHandlerContext {
  options: ConfirmOptions;
  selection: 'yes' | 'no';
  setSelection(v: 'yes' | 'no'): void;
  close(confirmed: boolean): void;
  render(): void;
}

export function handleInlineConfirmKey(event: KeyEvent, ctx: ConfirmHandlerContext): void {
  if (event.key === 'escape') {
    ctx.close(false);
    ctx.render();
    return;
  }

  if (event.key === 'left' || event.key === 'right' || event.key === 'tab') {
    ctx.setSelection(ctx.selection === 'yes' ? 'no' : 'yes');
    ctx.render();
    return;
  }

  if (event.key === 'y') {
    ctx.setSelection('yes');
    ctx.render();
    return;
  }

  if (event.key === 'n') {
    ctx.setSelection('no');
    ctx.render();
    return;
  }

  if (event.key === 'enter') {
    ctx.close(ctx.selection === 'yes');
    ctx.render();
  }
}

// ─── Login ───────────────────────────────────────────────────────────────────

export interface LoginProvider {
  id: string;
  name: string;
  subscribeUrl?: string;
}

export interface LoginHandlerContext {
  step: 'provider' | 'apikey';
  providerIndex: number;
  providers: LoginProvider[];
  apiKey: string;
  setStep(v: 'provider' | 'apikey'): void;
  setProviderIndex(v: number): void;
  setApiKey(v: string): void;
  setError(msg: string): void;
  close(result: { providerId: string; apiKey: string } | null): void;
  render(): void;
}

export function handleLoginKey(event: KeyEvent, ctx: LoginHandlerContext): void {
  if (ctx.step === 'provider') {
    if (event.key === 'escape') {
      ctx.close(null);
      ctx.render();
      return;
    }
    if (event.key === 'up') {
      ctx.setProviderIndex(Math.max(0, ctx.providerIndex - 1));
      ctx.render();
      return;
    }
    if (event.key === 'down') {
      ctx.setProviderIndex(Math.min(ctx.providers.length - 1, ctx.providerIndex + 1));
      ctx.render();
      return;
    }
    if (event.key === 'enter') {
      ctx.setStep('apikey');
      ctx.setApiKey('');
      ctx.setError('');
      ctx.render();
    }
    return;
  }

  // apikey step
  if (event.key === 'escape') {
    ctx.setStep('provider');
    ctx.setApiKey('');
    ctx.setError('');
    ctx.render();
    return;
  }

  if (event.key === 'enter') {
    if (ctx.apiKey.length < 10) {
      ctx.setError('API key too short (min 10 characters)');
      ctx.render();
      return;
    }
    ctx.close({ providerId: ctx.providers[ctx.providerIndex].id, apiKey: ctx.apiKey });
    ctx.render();
    return;
  }

  if (event.key === 'backspace') {
    ctx.setApiKey(ctx.apiKey.slice(0, -1));
    ctx.setError('');
    ctx.render();
    return;
  }

  if (event.ctrl && event.key === 'v') {
    clipboardy.read().then(text => {
      if (text) {
        ctx.setApiKey(text.trim());
        ctx.setError('');
        ctx.render();
      }
    }).catch(() => {
      ctx.setError('Could not read clipboard');
      ctx.render();
    });
    return;
  }

  if (event.ctrl && event.key === 'b') {
    const provider = ctx.providers[ctx.providerIndex];
    if (provider.subscribeUrl) {
      try {
        const cmd = process.platform === 'darwin' ? 'open'
          : process.platform === 'win32' ? 'start'
          : 'xdg-open';
        const child = spawn(cmd, [provider.subscribeUrl], { detached: true, stdio: 'ignore' });
        child.unref();
      } catch { /* ignore */ }
    }
    return;
  }

  if (event.isPaste && event.key.length > 1) {
    ctx.setApiKey(ctx.apiKey + event.key.trim());
    ctx.setError('');
    ctx.render();
    return;
  }

  if (event.key.length === 1 && !event.ctrl) {
    ctx.setApiKey(ctx.apiKey + event.key);
    ctx.setError('');
    ctx.render();
  }
}
