import React, { useState, useEffect } from 'react';
import { Text, Box } from 'ink';

export const LOGO = `
 ██████╗ ██████╗ ██████╗ ███████╗███████╗██████╗
██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔════╝██╔══██╗
██║     ██║   ██║██║  ██║█████╗  █████╗  ██████╔╝
██║     ██║   ██║██║  ██║██╔══╝  ██╔══╝  ██╔═══╝
╚██████╗╚██████╔╝██████╔╝███████╗███████╗██║
 ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚══════╝╚═╝     `;

// Static logo for after intro
export const Logo: React.FC = () => (
  <Box flexDirection="column" alignItems="center">
    <Text color="#f02a30" bold>{LOGO}</Text>
    <Text color="#f02a30">Deep into Code.</Text>
  </Box>
);

const GLITCH_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ@#$%&*<>?/;:[]=';

interface IntroProps {
  onComplete: () => void;
}

type Phase = 'init' | 'decrypt' | 'done';

export const IntroAnimation: React.FC<IntroProps> = ({ onComplete }) => {
  const [phase, setPhase] = useState<Phase>('init');
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    const sequence = async () => {
      // Phase 1: Initial Noise
      setPhase('init');

      // Run noise loop (similar to index.html's 10 steps of 50ms)
      for (let i = 0; i < 10; i++) {
        setProgress(Math.random()); // Trigger re-render
        await delay(50);
      }

      // Phase 2: Unified Decryption
      setPhase('decrypt');
      const duration = 1500;
      const startTime = Date.now();

      const animate = () => {
        const elapsed = Date.now() - startTime;
        const p = Math.min(elapsed / duration, 1);

        setProgress(p);

        if (p < 1) {
          setTimeout(animate, 16); // ~60 FPS
        } else {
          // Phase 3: Done
          setPhase('done');
          // Short delay before firing complete
          setTimeout(() => onComplete(), 200);
        }
      };

      animate();
    };

    sequence();
  }, [onComplete]);

  const getDecryptedText = () => {
    const rawLines = LOGO.split('\n');
    // Handle leading newline similar to index.html logic if needed
    // index.html logic: const linesToRender = rawLines[0] === '' ? rawLines.slice(1) : rawLines;
    const lines = rawLines[0] === '' ? rawLines.slice(1) : rawLines;

    return lines.map((line) => {
      let resultLine = '';

      for (let charIndex = 0; charIndex < line.length; charIndex++) {
        const char = line[charIndex];
        let isDecrypted = false;

        if (phase === 'init') {
          isDecrypted = false;
        }
        else if (phase === 'decrypt' || phase === 'done') {
           const threshold = line.length > 0 ? charIndex / line.length : 0;

           if (progress >= threshold - 0.1) {
             isDecrypted = Math.random() > 0.2;
           }
        }

        if (phase === 'done') isDecrypted = true;

        if (char === ' ' && phase !== 'init') {
           resultLine += ' ';
        } else if (isDecrypted) {
           resultLine += char;
        } else {
           if (char === ' ' && Math.random() > 0.1) {
               resultLine += ' ';
           } else {
               resultLine += GLITCH_CHARS.charAt(Math.floor(Math.random() * GLITCH_CHARS.length));
           }
        }
      }
      return resultLine;
    }).join('\n');
  };

  return (
    <Box flexDirection="column" alignItems="center">
      <Text
        color="#f02a30"
        bold
      >
        {getDecryptedText()}
      </Text>

      {phase === 'done' && (
        <Text color="#f02a30">Deep into Code.</Text>
      )}
    </Box>
  );
};
