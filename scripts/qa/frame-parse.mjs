// Turns a docs/figma/frames/*.txt dump into absolute boxes, so a page can be measured against its frame.
import { readFileSync } from 'node:fs';

const TOKENS = {
  'text/primary': '#182723',
  'text/secondary': '#586d65',
  'signal/accent': '#187b66',
  'status/warning': '#8b5d1d',
  'status/danger': '#b44949',
  'text/on-accent': '#ffffff',
  'text/disabled': '#8a9992',
};

const BOX = /^(F|T|R|V|C|CS|ICON)\s+(?:(.*?)\s+)?@(-?[\d.]+),(-?[\d.]+)\s+([\d.]+)x([\d.]+)(.*)$/;
const RUN = /"((?:[^"\\]|\\.)*)"\[([^\]]*)\]/g;

function parseRuns(rest) {
  const runs = [];
  for (const match of rest.matchAll(RUN)) {
    const text = match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
    const style = match[2].split(/\s+/);
    const mono = style[0] === 'Mono';
    const parts = mono ? style.slice(1) : style;
    const weight = parts[0];
    const size = Number(parts[1]);
    const lh = (parts.find((part) => part.startsWith('lh')) ?? 'lh150%').replace(/\D/g, '');
    const color = parts[parts.length - 1];
    runs.push({ text, mono, weight, size, lh: Number(lh || 150), color: TOKENS[color] ?? (color.startsWith('#') ? color : null) });
  }
  return runs;
}

/** The dumps are flat, so parents are rebuilt: a node's parent is the nearest open frame it fits inside. */
export function parseFrame(file) {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const nodes = [];
  const stack = [];
  for (const line of lines) {
    const match = BOX.exec(line);
    if (!match) continue;
    const [, kind, name, x, y, w, h, rest] = match;
    const node = { kind, name: name ?? '', x: Number(x), y: Number(y), w: Number(w), h: Number(h), rest };
    if (kind === 'T') node.runs = parseRuns(line);
    if (stack.length === 0) {
      node.ax = 0;
      node.ay = 0;
      stack.push(node);
      nodes.push(node);
      continue;
    }
    while (stack.length > 1) {
      const parent = stack[stack.length - 1];
      if (node.x >= -1 && node.y >= -1 && node.x + node.w <= parent.w + 1.5 && node.y + node.h <= parent.h + 1.5) break;
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    node.ax = parent.ax + node.x;
    node.ay = parent.ay + node.y;
    nodes.push(node);
    if (kind === 'F' || kind === 'C' || kind === 'CS') stack.push(node);
  }
  return nodes;
}

/** Text lines with the position the frame gives them, assuming unwrapped lines inside a block. */
export function frameLines(nodes) {
  const out = [];
  for (const node of nodes) {
    if (node.kind !== 'T') continue;
    let y = node.ay;
    let firstInBlock = true;
    for (const run of node.runs) {
      const parts = run.text.split('\n');
      parts.forEach((part, index) => {
        const lineHeight = (run.size * run.lh) / 100;
        const text = part.trim();
        if (text) {
          out.push({ text, x: node.ax, y, size: run.size, weight: run.weight, mono: run.mono, color: run.color, blockStart: firstInBlock, wrapWidth: node.w });
          firstInBlock = false;
        }
        if (index < parts.length - 1) y += lineHeight;
        else if (text) y += 0;
      });
    }
  }
  return out;
}

export function frameBoxes(nodes) {
  return nodes.filter((node) => node.kind === 'F' && ['Alert', 'Action', 'Disabled action', 'Field', 'Table row', 'Application bar', 'Workspace navigation', 'Actions', 'Evidence workbench'].includes(node.name)).map((node) => ({ name: node.name, x: node.ax, y: node.ay, w: node.w, h: node.h }));
}
