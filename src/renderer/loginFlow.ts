/**
 * The first-run setup, before the App starts: pick a provider ("Welcome to
 * Codeep"), then paste its API key. Full screen, on its own Screen and Input.
 *
 * It repaints whenever what it shows would otherwise go stale: on an Omarchy
 * theme switch (the palette changed) and on a terminal resize, which clears
 * the screen. Before, only a key press redrew it — the picker kept the old
 * theme's colours, and after `tmux attach` at a smaller size it was blank.
 */
import { Screen } from './Screen';
import { Input, type KeyEvent } from './Input';
import { LoginScreen, renderProviderSelect } from './components/Login';
import { onPaletteChange } from './palette';

export interface LoginFlowProvider {
  id: string;
  name: string;
  description?: string;
  subscribeUrl?: string;
  noApiKey?: boolean;
}

export interface LoginFlowOptions {
  providers: LoginFlowProvider[];
  setProvider: (id: string) => void;
  setApiKey: (key: string) => Promise<void>;
  /** For tests; a new Screen and Input otherwise. */
  screen?: Screen;
  input?: Input;
}

/**
 * Resolves with the API key that was saved, 'ollama' for a provider that
 * needs none, or null when setup was cancelled.
 */
export function runLoginFlow(options: LoginFlowOptions): Promise<string | null> {
  const { providers, setProvider, setApiKey } = options;
  return new Promise((resolve) => {
    const screen = options.screen ?? new Screen();
    const input = options.input ?? new Input();

    let currentStep: 'provider' | 'apikey' = 'provider';
    let selectedProviderIndex = 0;
    let selectedProvider = providers[0];
    let loginScreen: LoginScreen | null = null;
    let loginError = '';

    screen.init();
    input.start();

    let stopRepainting = () => {};
    const cleanup = () => { stopRepainting(); input.stop(); screen.cleanup(); };

    const renderCurrentStep = () => {
      if (currentStep === 'provider') {
        renderProviderSelect(screen, providers, selectedProviderIndex);
      } else if (loginScreen) {
        loginScreen.render();
      }
    };

    /**
     * The API-key screen for the chosen provider, showing loginError if
     * there is one. Every attempt gets the same screen: after "API key too
     * short" or a failed save, Enter tries the new key and Esc goes back to
     * the provider list. The retry screen used to ignore Enter, and its Esc
     * ended setup.
     */
    const showKeyScreen = () => {
      loginScreen = new LoginScreen(screen, input, {
        providerName: selectedProvider.name,
        error: loginError,
        subscribeUrl: selectedProvider.subscribeUrl,
        onSubmit: async (key) => {
          if (key.length < 10) {
            loginError = 'API key too short';
            showKeyScreen();
            return;
          }
          try {
            await setApiKey(key);
          } catch {
            loginError = 'Could not save the API key (secure storage unavailable). Please try again.';
            showKeyScreen();
            return;
          }
          cleanup();
          resolve(key);
        },
        onCancel: () => {
          currentStep = 'provider';
          loginScreen = null;
          loginError = '';
          renderCurrentStep();
        },
      });
      renderCurrentStep();
    };

    // A resize rebuilds the Screen's buffers and clears the terminal; a palette
    // change leaves every colour on screen out of date. Both redraw the step
    // that is showing, the way the chat screen does.
    screen.onResize(renderCurrentStep);
    stopRepainting = onPaletteChange(renderCurrentStep);

    input.onKey((event: KeyEvent) => {
      // Ctrl+C / Ctrl+D leave setup on either step, as Esc does on the list.
      // The terminal is in raw mode here, so nothing else would end it.
      if (event.ctrl && (event.key === 'c' || event.key === 'd')) {
        cleanup();
        resolve(null);
        return;
      }
      if (currentStep === 'provider') {
        if (event.key === 'up') {
          selectedProviderIndex = Math.max(0, selectedProviderIndex - 1);
          renderCurrentStep();
        } else if (event.key === 'down') {
          selectedProviderIndex = Math.min(providers.length - 1, selectedProviderIndex + 1);
          renderCurrentStep();
        } else if (event.key === 'enter') {
          selectedProvider = providers[selectedProviderIndex];
          setProvider(selectedProvider.id);
          // Providers that don't need a key (Ollama, Custom OpenAI-compatible)
          // skip the API-key prompt entirely. Configure their endpoint in
          // /settings (Ollama URL / Custom Base URL) once inside the app.
          if (selectedProvider.noApiKey) {
            cleanup();
            resolve('ollama'); // non-null sentinel so the caller proceeds
            return;
          }
          currentStep = 'apikey';
          showKeyScreen();
        } else if (event.key === 'escape') {
          cleanup();
          resolve(null);
        }
      } else if (loginScreen) {
        loginScreen.handleKey(event);
      }
    });

    renderCurrentStep();
  });
}
