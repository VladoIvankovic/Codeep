import React, { useState } from 'react';
import { Text, Box, useInput } from 'ink';
import TextInput from 'ink-text-input';
import open from 'open';
import { setApiKey, setProvider, config, PROVIDERS } from '../config/index';
import { validateApiKey } from '../api/index';
import { Logo } from './Logo';
import { getProviderList } from '../config/providers';

const PROVIDER_URLS: Record<string, string> = {
  'z.ai': 'https://z.ai/subscribe?ic=NXYNXZOV14',
  'minimax': 'https://platform.minimax.io/subscribe/coding-plan?code=2lWvoWUhrp&source=link',
};

interface LoginProps {
  onLogin: () => void;
  onCancel?: () => void;
}

type Step = 'provider' | 'apikey';

export const Login: React.FC<LoginProps> = ({ onLogin, onCancel }) => {
  const [step, setStep] = useState<Step>('provider');
  const [selectedProvider, setSelectedProvider] = useState(0);
  const [apiKey, setApiKeyState] = useState('');
  const [error, setError] = useState('');
  const [validating, setValidating] = useState(false);

  const providers = getProviderList();
  const currentProvider = providers[selectedProvider];

  // Handle keyboard input
  useInput((input, key) => {
    if (step === 'provider') {
      if (key.upArrow) {
        setSelectedProvider(i => Math.max(0, i - 1));
      }
      if (key.downArrow) {
        setSelectedProvider(i => Math.min(providers.length - 1, i + 1));
      }
      if (key.return) {
        setProvider(currentProvider.id);
        setStep('apikey');
      }
      // Escape to cancel login
      if (key.escape && onCancel) {
        onCancel();
      }
    } else if (step === 'apikey') {
      // G key to open browser for API key
      if ((input === 'g' || input === 'G') && apiKey === '') {
        const url = PROVIDER_URLS[currentProvider.id];
        if (url) open(url);
      }
      // Escape to go back to provider selection
      if (key.escape) {
        setStep('provider');
        setError('');
      }
    }
  });

  const handleSubmit = async (key: string) => {
    if (!key.trim()) {
      setError('Please enter your API key');
      return;
    }

    setValidating(true);
    setError('');

    const result = await validateApiKey(key, currentProvider.id);
    
    if (result.valid) {
      setApiKey(key, currentProvider.id);
      onLogin();
    } else {
      setError(result.error || 'Invalid API key');
      setValidating(false);
    }
  };

  // Provider selection screen
  if (step === 'provider') {
    return (
      <Box flexDirection="column" alignItems="center" padding={2}>
        <Logo />
        <Text> </Text>
        <Text color="#f02a30" bold>Select AI Provider</Text>
        <Text> </Text>
        
        {providers.map((provider, i) => (
          <Text key={provider.id}>
            {i === selectedProvider ? <Text color="#f02a30">▸ </Text> : '  '}
            <Text color={i === selectedProvider ? '#f02a30' : undefined} bold={i === selectedProvider}>
              {provider.name}
            </Text>
            <Text> - {provider.description}</Text>
          </Text>
        ))}
        
        <Text> </Text>
        <Text>↑/↓ Navigate, Enter = Select, Esc = Cancel</Text>
      </Box>
    );
  }

  // API key input screen
  return (
    <Box flexDirection="column" alignItems="center" padding={2}>
      <Logo />
      <Text> </Text>
      <Text color="#f02a30">Enter your <Text bold>{currentProvider.name}</Text> API key</Text>
      <Text> </Text>
      <Text>Press <Text color="#f02a30">G</Text> to get an API key, or paste your key below:</Text>
      <Text> </Text>
      
      <Box>
        <Text color="#f02a30">Key: </Text>
        {validating ? (
          <Text>Validating...</Text>
        ) : (
          <TextInput
            value={apiKey}
            onChange={setApiKeyState}
            onSubmit={handleSubmit}
            mask="*"
            placeholder="Enter API key..."
          />
        )}
      </Box>

      {error && (
        <Text color="#f02a30">{error}</Text>
      )}

      <Text> </Text>
      <Text>Enter = login, <Text color="#f02a30">G</Text> = get key, Esc = back, Ctrl+C = exit</Text>
    </Box>
  );
};
