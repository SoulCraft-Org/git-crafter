// Tab icons and status glyphs for the Quality and Speed page, drawn once as
// SVG symbols in a sprite and placed with <use>, so each row and nav link
// costs a few bytes. 16 x 16 strokes in currentColor; the status glyphs
// carry their own colors from the site tokens.

const SYMBOLS = {
  overview: '<path d="M2.25 7.5 8 2.75l5.75 4.75M4 6.25v7h3V9.75h2v3.5h3v-7"/>',
  code: '<path d="M5.5 4 1.75 8l3.75 4M10.5 4l3.75 4-3.75 4"/>',
  documentation: '<path d="M3.75 1.75h5.5l3 3v9.5h-8.5zM9.25 1.75v3h3M6 8.25h4M6 11h4"/>',
  // Issues: a circle with a dot.
  issues: '<circle cx="8" cy="8" r="6.25"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/>',
  // Projects: the board's columns with cards moving across.
  projects: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M5.5 5h1.5v3H5.5zM9 5h1.5v5H9z"/>',
  "pull-requests": '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="12.5" r="1.5"/><path d="M4.5 5v6M11.5 11V7.25c0-1.5-.9-2.25-2.25-2.25H7.25M8.75 3.5 7.25 5l1.5 1.5"/>',
  // The Actions tab, named as GitHub names it; its icon is the play mark.
  actions: '<circle cx="8" cy="8" r="6.25"/><path d="M6.5 5.25v5.5L10.75 8z" fill="currentColor"/>',
  tests: '<path d="M6 1.75h4M6.75 1.75v4.5L2.9 12.6a1.1 1.1 0 0 0 .95 1.65h8.3a1.1 1.1 0 0 0 .95-1.65L9.25 6.25v-4.5M4.5 10h7"/>',
  security: '<path d="M8 1.75 13.25 3.75v4c0 3.25-2.25 5.5-5.25 6.5-3-1-5.25-3.25-5.25-6.5v-4z"/><path d="m5.75 8 1.5 1.5 3-3"/>',
  // Insights: a line graph on its axes, as GitHub draws the tab.
  insights: '<path d="M2.25 2.5v11h11.5"/><path d="m4.75 10 2.75-3.25 2.25 2 3.25-4.25"/>',
  // Settings: a cog, a hub with eight teeth.
  settings: '<circle cx="8" cy="8" r="2.5"/><path d="M8 1.75v2M8 12.25v2M1.75 8h2M12.25 8h2M3.6 3.6 5 5M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4"/>',
  design: '<path d="M8 1.75 12.25 7.5 8 14.25 3.75 7.5z"/><path d="M8 1.75v5.25"/><circle cx="8" cy="8.5" r="1.25"/>',
  usability: '<path d="M4 1.75v11l2.75-2.5 2 4.25 1.75-.75-2-4.25h3.75z"/>',
  claude: '<path d="M8 1.5c.6 3.4 3 5.9 6.5 6.5-3.5.6-5.9 3-6.5 6.5-.6-3.5-3-5.9-6.5-6.5 3.5-.6 5.9-3.1 6.5-6.5z"/>',
  // Claude settings: two sliders.
  "claude-settings": '<path d="M2 5h12M2 11h12M5.5 3v4M10.5 9v4"/>',
  // Claude desktop app: a screen on its stand.
  "desktop-app": '<rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1"/><path d="M5.5 13.75h5M8 11.25v2.5"/>',
  // Blockers: a no-entry sign.
  blockers: '<circle cx="8" cy="8" r="6.25"/><path d="m3.6 12.4 8.8-8.8"/>',
  // Tokens: a stack of coins, as on Git Crafter's Token use outcome.
  instructions: '<path d="M4 2.75h6.5L13 5.25v8H4z"/><path d="M6.25 7.5h4.5M6.25 10h4.5"/>',
  tokens: '<ellipse cx="8" cy="4.5" rx="5" ry="2"/><path d="M3 4.5v3.5c0 1.1 2.25 2 5 2s5-.9 5-2V4.5M3 8v3.5c0 1.1 2.25 2 5 2s5-.9 5-2V8"/>',
  // Deploy: an arrow up from a base, a change going out.
  deploy: '<path d="M8 11.5V2.75M4.75 6 8 2.75 11.25 6M2.75 13.25h10.5"/>',
  // Credits: a ticket with a notch.
  credits: '<path d="M1.75 4.5h12.5v2.25a1.25 1.25 0 0 0 0 2.5v2.25H1.75V9.25a1.25 1.25 0 0 0 0-2.5zM10 4.5v7"/>',
  // Tools: a wrench.
  tools: '<path d="M10.5 1.75a3.25 3.25 0 0 0-3.1 4.25L2.25 11.15a1.5 1.5 0 0 0 2.1 2.1L9.5 8.1a3.25 3.25 0 0 0 4.25-3.1l-1.9 1.15-1.5-.4-.4-1.5z"/>',
  // Any tab added to TABS before it gets its own icon.
  tab: '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/>',
};

// The sprite symbol for id, or the generic tab icon for an unknown one.
export const iconId = (id) => (Object.hasOwn(SYMBOLS, id) ? id : "tab");

// Shape and color together, so status never relies on color alone (the
// status set fails the dataviz chroma floor for pine and stone-edge).
const GLYPHS = {
  meets: '<circle cx="8" cy="8" r="7" style="fill:var(--c-pine)"/><path d="m4.75 8.25 2.25 2.25 4.25-4.5" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
  near: '<circle cx="8" cy="8" r="7" style="fill:var(--c-brass)"/><path d="M4.25 9.1c1.1-1.9 2.4-1.9 3.75-.9s2.65 1 3.75-.9" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round"/>',
  misses: '<circle cx="8" cy="8" r="7" style="fill:var(--c-danger)"/><path d="m5.5 5.5 5 5m0-5-5 5" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round"/>',
  "not-measured": '<circle cx="8" cy="8" r="6" fill="none" style="stroke:var(--c-text-dim)" stroke-width="2"/>',
};

export const SPRITE = `<svg class="sprite" aria-hidden="true" focusable="false" width="0" height="0">${Object.entries(SYMBOLS)
  .map(([id, body]) => `<symbol id="i-${id}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</symbol>`)
  .join("")}${Object.entries(GLYPHS)
  .map(([id, body]) => `<symbol id="g-${id}" viewBox="0 0 16 16">${body}</symbol>`)
  .join("")}</svg>`;

// One icon from the sprite, hidden from screen readers.
export const icon = (id, cls = "ic") => `<svg class="${cls}" aria-hidden="true"><use href="#i-${iconId(id)}"/></svg>`;

// Short names where the tab's own name is too wide for a massif or a nav
// link. Headings and tooltips keep the full name from TABS.
const SHORT = { documentation: "Docs", "pull-requests": "PRs", security: "Security", "desktop-app": "Desktop" };
// The tab's short name where one is set, else its name.
export const shortName = (id, name) => SHORT[id] ?? name;
