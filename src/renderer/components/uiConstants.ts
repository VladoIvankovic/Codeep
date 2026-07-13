/**
 * Shared UI constants for the renderer.
 *
 * Centralised so the colour palette, spinner animation, and ASCII logo
 * have a single home — both `App.ts` and any extracted component can
 * import them without re-declaring (which would let the palette drift
 * between files).
 */
import { fg } from '../ansi';

/** Brand red — used for the logo, the agent-panel title, and accents. */
export const PRIMARY_COLOR = fg.rgb(240, 42, 48);

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
