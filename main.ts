// Harness driver (run by the grader as `node /bot/main.ts` on
// Node 22): read the case list, render every Markdown input with
// the local parser, and write the HTML strings back out in the
// same order. Each case is rendered independently, so no state
// leaks from one document into the next.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type CaseRow = { id: string; markdown: string };

function run(): void {
  const sourceDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const targetDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

  const payload = readFileSync(join(sourceDir, 'cases.json'), 'utf8');
  const rows = JSON.parse(payload) as CaseRow[];

  const html: string[] = new Array(rows.length);
  for (let k = 0; k < rows.length; k++) {
    html[k] = parse(rows[k].markdown);
  }

  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'html.json'), JSON.stringify(html));
}

run();
