#!/usr/bin/env node
// Entry point. Owner: the planner. Each command loads only the code it needs.
//
//   corral            start the TUI
//   corral doctor     check this machine (OpenCode, service, PTY, Git, terminal)

const USAGE = `corral - session manager for OpenCode

Usage:
  node src/main.ts [options]      start the TUI
  node src/main.ts doctor         check this machine and print a report

Options:
  -h, --help       show this text
  -v, --version    show the version
`;

async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  if (first === '-h' || first === '--help' || first === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (first === '-v' || first === '--version') {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    process.stdout.write(pkg.version + '\n');
    return 0;
  }
  if (first === 'doctor') {
    const { runDoctor } = await import('./doctor.ts');
    return runDoctor(rest);
  }
  const { runApp } = await import('./tui/app/index.ts');
  return runApp(argv);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`corral: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
