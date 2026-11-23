// The harness runs `node /bot/main.ts` (node22). It reads every case from
// /input/cases.json (a JSON array of {id, input}), answers each one alone
// with run() from solve.js, and writes /output/answers.json: a JSON array of
// the answers, one per case and in the cases' order. Outside a container
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its
// work runs under it (the rules: the house baseline runs with
// --no-incremental-marking, and an entry may tune V8's flags too).
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));

/**
 * The answers, serialised: an array of objects whose values are all strings,
 * so one JSON.stringify per key and value plus a join is the same text
 * JSON.stringify(answers) writes, without its object traversal.
 */
function stringifyAnswers(answers: unknown[]): string {
  const parts: string[] = ['['];
  for (let i = 0; i < answers.length; i++) {
    if (i > 0) parts.push(',');
    const obj = answers[i] as Record<string, string>;
    const keys = Object.keys(obj);
    parts.push('{');
    for (let k = 0; k < keys.length; k++) {
      if (k > 0) parts.push(',');
      parts.push(JSON.stringify(keys[k]), ':', JSON.stringify(obj[keys[k]]));
    }
    parts.push('}');
  }
  parts.push(']');
  return parts.join('');
}

writeFileSync(join(OUTPUT_DIR, 'answers.json'), stringifyAnswers(answers));
