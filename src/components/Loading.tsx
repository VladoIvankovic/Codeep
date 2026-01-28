import React, { useState, useEffect } from 'react';
import { Text, Box } from 'ink';

// Spinner frames
const SPINNER = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];

interface LoadingProps {
  isStreaming?: boolean;
}

export const Loading: React.FC<LoadingProps> = ({ isStreaming = false }) => {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    // Force re-render every 100ms to animate even when parent doesn't update
    const timer = setInterval(() => {
      setTick(t => t + 1);
    }, 100);

    return () => clearInterval(timer);
  }, []);

  const spinnerFrame = tick % SPINNER.length;
  const dotsCount = (Math.floor(tick / 3) % 4); // 0, 1, 2, 3 dots cycling
  const dots = '.'.repeat(dotsCount);
  const message = isStreaming ? 'Writing' : 'Thinking';

  return (
    <Box paddingLeft={2} paddingY={0}>
      <Text color="#f02a30" bold>
        {SPINNER[spinnerFrame]} {message}{dots}
      </Text>
    </Box>
  );
};

// Simple inline spinner for smaller spaces
export const InlineSpinner: React.FC<{ text?: string }> = ({ text = 'Loading' }) => {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setTick(t => t + 1);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text>
      <Text color="#f02a30">{SPINNER[tick % SPINNER.length]} </Text>
      <Text>{text}</Text>
    </Text>
  );
};
