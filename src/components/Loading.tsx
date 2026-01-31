import React, { useState, useEffect, memo } from 'react';
import { Text, Box } from 'ink';

// Spinner frames - Braille pattern for smooth animation
const SPINNER = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];

interface LoadingProps {
  isStreaming?: boolean;
}

/**
 * Isolated spinner animation component
 * Only this component re-renders during animation, not the parent
 */
const AnimatedSpinner: React.FC = memo(() => {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER.length);
    }, 100);
    return () => clearInterval(timer);
  }, []);

  return <Text color="#f02a30">{SPINNER[frame]}</Text>;
});

AnimatedSpinner.displayName = 'AnimatedSpinner';

/**
 * Animated dots component
 * Isolated animation state
 */
const AnimatedDots: React.FC = memo(() => {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setCount(c => (c + 1) % 4);
    }, 300);
    return () => clearInterval(timer);
  }, []);

  return <Text color="#f02a30">{'.'.repeat(count)}</Text>;
});

AnimatedDots.displayName = 'AnimatedDots';

/**
 * Loading indicator with isolated animation
 * Parent component won't re-render when spinner animates
 */
export const Loading: React.FC<LoadingProps> = memo(({ isStreaming = false }) => {
  const message = isStreaming ? 'Writing' : 'Thinking';

  return (
    <Box paddingLeft={2} paddingY={0}>
      <AnimatedSpinner />
      <Text color="#f02a30" bold> {message}</Text>
      <AnimatedDots />
    </Box>
  );
});

Loading.displayName = 'Loading';

/**
 * Simple inline spinner for smaller spaces
 * Also uses isolated animation
 */
export const InlineSpinner: React.FC<{ text?: string }> = memo(({ text = 'Loading' }) => {
  return (
    <Text>
      <AnimatedSpinner />
      <Text> {text}</Text>
    </Text>
  );
});

InlineSpinner.displayName = 'InlineSpinner';
