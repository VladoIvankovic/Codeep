/**
 * Intro animation component - matches Ink version style
 */

import { Screen } from '../Screen';
import { fg, style } from '../ansi';

// ASCII Logo (same as Ink version)
const LOGO = [
  ' ██████╗ ██████╗ ██████╗ ███████╗███████╗██████╗ ',
  '██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔════╝██╔══██╗',
  '██║     ██║   ██║██║  ██║█████╗  █████╗  ██████╔╝',
  '██║     ██║   ██║██║  ██║██╔══╝  ██╔══╝  ██╔═══╝ ',
  '╚██████╗╚██████╔╝██████╔╝███████╗███████╗██║     ',
  ' ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚══════╝╚═╝     ',
];

const TAGLINE = 'Deep into Code.';
const GLITCH_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ@#$%&*<>?/;:[]=';

// Primary color: #f02a30 (Codeep red)
const PRIMARY_COLOR = fg.rgb(240, 42, 48);

/**
 * Show intro animation with decrypt effect
 */
export async function showIntro(screen: Screen, duration: number = 1500): Promise<void> {
  const { width, height } = screen.getSize();
  
  // Calculate center position
  const logoWidth = LOGO[0].length;
  const logoHeight = LOGO.length;
  const startX = Math.floor((width - logoWidth) / 2);
  const startY = Math.floor((height - logoHeight) / 2) - 1;
  
  screen.showCursor(false);
  
  // Phase 1: Initial noise (500ms)
  const noiseFrames = 10;
  for (let frame = 0; frame < noiseFrames; frame++) {
    screen.clear();
    
    for (let i = 0; i < LOGO.length; i++) {
      const noiseLine = generateNoiseLine(LOGO[i]);
      screen.write(startX, startY + i, noiseLine, PRIMARY_COLOR + style.bold);
    }
    
    screen.fullRender();
    await sleep(50);
  }
  
  // Phase 2: Decrypt animation (1000ms)
  const decryptDuration = duration - 500;
  const startTime = Date.now();
  
  while (Date.now() - startTime < decryptDuration) {
    const progress = (Date.now() - startTime) / decryptDuration;
    
    screen.clear();
    
    for (let i = 0; i < LOGO.length; i++) {
      const decryptedLine = getDecryptedLine(LOGO[i], progress);
      screen.write(startX, startY + i, decryptedLine, PRIMARY_COLOR + style.bold);
    }
    
    // Show tagline when mostly decrypted
    if (progress > 0.7) {
      const taglineX = Math.floor((width - TAGLINE.length) / 2);
      screen.write(taglineX, startY + logoHeight + 1, TAGLINE, PRIMARY_COLOR);
    }
    
    screen.fullRender();
    await sleep(16); // ~60 FPS
  }
  
  // Phase 3: Final state
  screen.clear();
  
  for (let i = 0; i < LOGO.length; i++) {
    screen.write(startX, startY + i, LOGO[i], PRIMARY_COLOR + style.bold);
  }
  
  const taglineX = Math.floor((width - TAGLINE.length) / 2);
  screen.write(taglineX, startY + logoHeight + 1, TAGLINE, PRIMARY_COLOR);
  
  screen.fullRender();
  await sleep(200);
}

/**
 * Generate noise line (random glitch characters)
 */
function generateNoiseLine(original: string): string {
  let result = '';
  for (const char of original) {
    if (char === ' ' && Math.random() > 0.1) {
      result += ' ';
    } else {
      result += GLITCH_CHARS.charAt(Math.floor(Math.random() * GLITCH_CHARS.length));
    }
  }
  return result;
}

/**
 * Get partially decrypted line based on progress
 */
function getDecryptedLine(original: string, progress: number): string {
  let result = '';
  
  for (let i = 0; i < original.length; i++) {
    const char = original[i];
    const threshold = original.length > 0 ? i / original.length : 0;
    
    // Character is decrypted if progress is past its threshold (with some randomness)
    const isDecrypted = progress >= threshold - 0.1 && Math.random() > 0.2;
    
    if (char === ' ') {
      result += ' ';
    } else if (isDecrypted || progress > 0.95) {
      result += char;
    } else {
      result += GLITCH_CHARS.charAt(Math.floor(Math.random() * GLITCH_CHARS.length));
    }
  }
  
  return result;
}

/**
 * Simple sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Quick version without animation (for fast startup)
 */
export function showLogoStatic(screen: Screen): void {
  const { width, height } = screen.getSize();
  
  const logoWidth = LOGO[0].length;
  const logoHeight = LOGO.length;
  const startX = Math.floor((width - logoWidth) / 2);
  const startY = Math.floor((height - logoHeight) / 2) - 1;
  
  screen.clear();
  
  for (let i = 0; i < LOGO.length; i++) {
    screen.write(startX, startY + i, LOGO[i], PRIMARY_COLOR + style.bold);
  }
  
  const taglineX = Math.floor((width - TAGLINE.length) / 2);
  screen.write(taglineX, startY + logoHeight + 1, TAGLINE, PRIMARY_COLOR);
  
  screen.showCursor(false);
  screen.fullRender();
}
