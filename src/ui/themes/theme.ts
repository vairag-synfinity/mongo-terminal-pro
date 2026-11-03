import type { ThemeName } from '../../config/defaults.js';

export interface ThemeColors {
  primary: string;
  secondary: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  muted: string;
  text: string;
  border: string;
  borderFocus: string;
  selectionBg: string;
  selectionFg: string;
  title: string;
  json: {
    key: string;
    string: string;
    number: string;
    boolean: string;
    null: string;
    objectId: string;
    date: string;
    special: string;
    punctuation: string;
  };
}

export interface Theme {
  name: ThemeName;
  /** When true no colours are emitted (NO_COLOR / --no-color); emphasis uses bold/inverse only. */
  noColor: boolean;
  colors: ThemeColors;
}

const dark: ThemeColors = {
  primary: '#4DB33D', // MongoDB leaf green
  secondary: '#00ED64',
  accent: '#13AA52',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  info: 'cyan',
  muted: 'gray',
  text: 'white',
  border: 'gray',
  borderFocus: '#00ED64',
  selectionBg: '#116149',
  selectionFg: 'white',
  title: '#00ED64',
  json: {
    key: '#7FDBFF',
    string: '#B5E48C',
    number: '#FFD166',
    boolean: '#F78C6B',
    null: 'gray',
    objectId: '#C792EA',
    date: '#82AAFF',
    special: '#FF79C6',
    punctuation: 'gray',
  },
};

const light: ThemeColors = {
  primary: '#116149',
  secondary: '#00684A',
  accent: '#016BF8',
  success: '#00684A',
  warning: '#944F01',
  error: '#DB3030',
  info: '#016BF8',
  muted: '#5C6C75',
  text: 'black',
  border: '#889397',
  borderFocus: '#00684A',
  selectionBg: '#C3E7CA',
  selectionFg: 'black',
  title: '#00684A',
  json: {
    key: '#1254B7',
    string: '#00684A',
    number: '#944F01',
    boolean: '#B45AF2',
    null: '#5C6C75',
    objectId: '#7B1FA2',
    date: '#016BF8',
    special: '#C2185B',
    punctuation: '#5C6C75',
  },
};

export function createTheme(name: ThemeName, noColor: boolean): Theme {
  return { name, noColor, colors: name === 'light' ? light : dark };
}

/** Returns the colour or undefined in no-colour mode (Ink then renders the default colour). */
export function col(theme: Theme, color: string): string | undefined {
  return theme.noColor ? undefined : color;
}

export interface SymbolSet {
  unicode: boolean;
  pointer: string;
  bullet: string;
  check: string;
  cross: string;
  warning: string;
  info: string;
  arrowRight: string;
  arrowLeft: string;
  arrowUp: string;
  arrowDown: string;
  expanded: string;
  collapsed: string;
  ellipsis: string;
  barFull: string;
  barEmpty: string;
  separator: string;
  star: string;
  checkboxOn: string;
  checkboxOff: string;
  radioOn: string;
  radioOff: string;
  lock: string;
  dot: string;
  borderStyle: 'round' | 'classic';
  strongBorderStyle: 'double' | 'classic';
  spinner: 'dots' | 'line';
  hr: string;
}

export const UNICODE_SYMBOLS: SymbolSet = {
  unicode: true,
  pointer: '❯',
  bullet: '●',
  check: '✔',
  cross: '✖',
  warning: '⚠',
  info: 'ℹ',
  arrowRight: '→',
  arrowLeft: '←',
  arrowUp: '↑',
  arrowDown: '↓',
  expanded: '▾',
  collapsed: '▸',
  ellipsis: '…',
  barFull: '█',
  barEmpty: '░',
  separator: '›',
  star: '★',
  checkboxOn: '☑',
  checkboxOff: '☐',
  radioOn: '◉',
  radioOff: '○',
  lock: '⊘',
  dot: '•',
  borderStyle: 'round',
  strongBorderStyle: 'double',
  spinner: 'dots',
  hr: '─',
};

export const ASCII_SYMBOLS: SymbolSet = {
  unicode: false,
  pointer: '>',
  bullet: '*',
  check: 'v',
  cross: 'x',
  warning: '!',
  info: 'i',
  arrowRight: '->',
  arrowLeft: '<-',
  arrowUp: '^',
  arrowDown: 'v',
  expanded: '-',
  collapsed: '+',
  ellipsis: '...',
  barFull: '#',
  barEmpty: '-',
  separator: '>',
  star: '*',
  checkboxOn: '[x]',
  checkboxOff: '[ ]',
  radioOn: '(*)',
  radioOff: '( )',
  lock: 'RO',
  dot: '-',
  borderStyle: 'classic',
  strongBorderStyle: 'classic',
  spinner: 'line',
  hr: '-',
};

const ASCII_REPLACEMENTS: [RegExp, string][] = [
  [/↑↓/g, 'Up/Dn'],
  [/←→/g, 'Lt/Rt'],
  [/↑/g, 'Up'],
  [/↓/g, 'Dn'],
  [/←/g, 'Lt'],
  [/→/g, '->'],
  [/›/g, '>'],
  [/…/g, '...'],
  [/[•●]/g, '*'],
  [/─/g, '-'],
  [/│/g, '|'],
  [/✔/g, 'v'],
  [/✖/g, 'x'],
  [/⚠/g, '!'],
];

/** Replaces common Unicode glyphs with ASCII when the terminal cannot render them. */
export function asciiFallback(text: string, unicode: boolean): string {
  if (unicode) return text;
  let out = text;
  for (const [re, rep] of ASCII_REPLACEMENTS) out = out.replace(re, rep);
  return out;
}
