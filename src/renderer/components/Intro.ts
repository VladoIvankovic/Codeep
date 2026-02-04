/**
 * Intro animation component
 */

import { Screen } from '../Screen';
import { fg, style } from '../ansi';

// ASCII Logo
const LOGO = [
  '  ██████╗ ██████╗ ██████╗ ███████╗███████╗██████╗ ',
  ' ██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔════╝██╔══██╗',
  ' ██║     ██║   ██║██║  ██║█████╗  █████╗  ██████╔╝',
  ' ██║     ██║   ██║██║  ██║██╔══╝  ██╔══╝  ██╔═══╝ ',
  ' ╚██████╗╚██████╔╝██████╔╝███████╗███████╗██║     ',
  '  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚══════╝╚═╝     ',
];

const TAGLINE = 'AI-powered coding assistant';

/**
 * Show intro animation
 */
export async function showIntro(screen: Screen, duration: number = 1500): Promise<void> {
  const { width, height } = screen.getSize();
  
  // Calculate center position
  const logoWidth = LOGO[0].length;
  const logoHeight = LOGO.length;
  const startX = Math.floor((width - logoWidth) / 2);
  const startY = Math.floor((height - logoHeight) / 2) - 2;
  
  screen.clear();
  
  // Draw logo with color
  for (let i = 0; i < LOGO.length; i++) {
    screen.write(startX, startY + i, LOGO[i], fg.cyan + style.bold);
  }
  
  // Tagline
  const taglineX = Math.floor((width - TAGLINE.length) / 2);
  screen.write(taglineX, startY + logoHeight + 2, TAGLINE, fg.gray);
  
  // Version
  const version = 'v1.1.12';
  const versionX = Math.floor((width - version.length) / 2);
  screen.write(versionX, startY + logoHeight + 4, version, fg.gray);
  
  // Loading dots animation
  const loadingY = startY + logoHeight + 6;
  const loadingX = Math.floor((width - 20) / 2);
  
  screen.showCursor(false);
  screen.fullRender();
  
  // Animate loading dots
  const frames = ['·', '··', '···', '····', '·····'];
  const frameTime = duration / (frames.length * 2);
  
  for (let i = 0; i < frames.length * 2; i++) {
    const frame = frames[i % frames.length];
    screen.write(loadingX, loadingY, '     ' + frame.padEnd(10) + '     ', fg.cyan);
    screen.fullRender();
    await sleep(frameTime);
  }
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
  const startY = Math.floor((height - logoHeight) / 2) - 2;
  
  screen.clear();
  
  for (let i = 0; i < LOGO.length; i++) {
    screen.write(startX, startY + i, LOGO[i], fg.cyan + style.bold);
  }
  
  const taglineX = Math.floor((width - TAGLINE.length) / 2);
  screen.write(taglineX, startY + logoHeight + 2, TAGLINE, fg.gray);
  
  screen.showCursor(false);
  screen.fullRender();
}
