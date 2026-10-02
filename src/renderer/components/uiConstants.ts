/**
 * Shared UI constants for the renderer.
 *
 * Centralised so the colour palette, spinner animation, and ASCII logo
 * have a single home — both `App.ts` and any extracted component can
 * import them without re-declaring (which would let the palette drift
 * between files).
 */

/**
 * Brand red — used for the logo, the agent-panel title, and accents — and
 * its bright variant for selected rows and modal titles.
 *
 * They live in ../palette now, which can swap them for an Omarchy theme's
 * accent while Codeep runs; re-exported here because a hundred-odd call
 * sites already import them from this module. A re-export is a live binding,
 * so each read sees the current colour, not the one at import time.
 */
export { PRIMARY_COLOR, PRIMARY_BRIGHT } from '../palette';

/** Spinner frames for the agent progress panel (8-step rotation). */
export const SPINNER_FRAMES = ['▖', '▘', '▝', '▗', '▌', '▀', '▐', '▄'];

/** ASCII art logo, one string per terminal line. */
export const LOGO_LINES = [
  ' ██████╗ ██████╗ ██████╗ ███████╗███████╗██████╗ ',
  '██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔════╝██╔══██╗',
  '██║     ██║   ██║██║  ██║█████╗  █████╗  ██████╔╝',
  '██║     ██║   ██║██║  ██║██╔══╝  ██╔══╝  ██╔═══╝ ',
  '╚██████╗╚██████╔╝██████╔╝███████╗███████╗██║     ',
  ' ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚══════╝╚═╝     ',
];

/** Logo height in terminal lines (LOGO_LINES.length). */
export const LOGO_HEIGHT = LOGO_LINES.length;
