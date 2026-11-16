// Driver for markdown-render-speed-02: reads each case from the input
// directory, renders it on its own with parse() from parse.js, and
// writes the resulting HTML strings, in order, to the output directory.
// The harness runs this as `node /bot/main.ts` on Node 22.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];

const html: string[] = [];
for (const c of cases) html.push(parse(c.markdown));

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
