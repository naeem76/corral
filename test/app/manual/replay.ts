// Replay raw program output through the terminal emulator and print the final screen.
//   node test/app/manual/replay.ts <output-file> <cols> <rows>
// Used by live_e2e.py to read what the user would see.

import { readFileSync } from 'node:fs';
import { createEmulator, screenToText } from '../../../src/term/index.ts';

const [file, cols, rows] = process.argv.slice(2);
if (!file || !cols || !rows) {
  process.stderr.write('usage: replay.ts <file> <cols> <rows>\n');
  process.exit(2);
}
const em = createEmulator(Number(cols), Number(rows));
em.write(readFileSync(file).toString('utf8'));
process.stdout.write(screenToText(em) + '\n');
