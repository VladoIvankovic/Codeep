/**
 * Isolated Spinner component
 * Animation state is local - doesn't cause parent re-renders
 */

import React, { useState, useEffect, memo } from 'react';
import { Text } from 'ink';

// Different spinner styles
const SPINNERS = {
  dots: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  line: ['/', '-', '\\', '|'],
  simple: ['·', '•', '●', '•'],
  arrow: ['←', '↖', '↑', '↗', '→', '↘', '↓', '↙'],
  bounce: ['⠁', '⠂', '⠄', '⠂'],
};

type SpinnerType = keyof typeof SPINNERS;

interface SpinnerProps {
  type?: SpinnerType;
  color?: string;
  interval?: number;
  prefix?: string;
  suffix?: string;
}

/**
 * Spinner with isolated animation state
 * Parent component won't re-render when spinner frame changes
 */
export const Spinner: React.FC<SpinnerProps> = memo(({
  type = 'line',
  color = '#f02a30',
  interval = 100,
  prefix = '',
  suffix = '',
}) => {
  const [frame, setFrame] = useState(0);
  const frames = SPINNERS[type];
  
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % frames.length);
    }, interval);
    
    return () => clearInterval(timer);
  }, [frames.length, interval]);
  
  return (
    <Text>
      {prefix}
      <Text color={color}>{frames[frame]}</Text>
      {suffix}
    </Text>
  );
});

Spinner.displayName = 'Spinner';

/**
 * Static spinner character (no animation)
 * Use when you want consistent display without flickering
 */
export const StaticSpinner: React.FC<{ char?: string; color?: string }> = memo(({
  char = '●',
  color = '#f02a30',
}) => (
  <Text color={color}>{char}</Text>
));

StaticSpinner.displayName = 'StaticSpinner';

export default Spinner;
