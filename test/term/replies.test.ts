import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CSI, ESC, ST, make, text } from './helpers.ts';

function replies(input: string, cols = 80, rows = 24, setup = ''): string[] {
  const h = make(cols, rows);
  h.em.write(setup);
  h.replies.length = 0;
  const before = text(h.em);
  h.em.write(input);
  assert.equal(text(h.em), before, 'a query must not put text on the screen');
  return h.replies;
}

test('DSR status and cursor position', () => {
  assert.deepEqual(replies(`${CSI}5n`), [`${CSI}0n`]);
  assert.deepEqual(replies(`${CSI}6n`), [`${CSI}1;1R`]);
  assert.deepEqual(replies(`${CSI}6n`, 80, 24, `${CSI}12;34H`), [`${CSI}12;34R`]);
  assert.deepEqual(replies(`${CSI}?6n`, 80, 24, `${CSI}3;4H`), [`${CSI}?3;4R`]);
});

test('device attributes', () => {
  assert.deepEqual(replies(`${CSI}c`), [`${CSI}?62;22c`]);
  assert.deepEqual(replies(`${CSI}0c`), [`${CSI}?62;22c`]);
  assert.deepEqual(replies(`${CSI}>c`), [`${CSI}>0;0;0c`]);
  assert.deepEqual(replies(`${CSI}>0c`), [`${CSI}>0;0;0c`]);
  assert.deepEqual(replies(`${CSI}=c`), []);
});

test('XTVERSION', () => {
  assert.deepEqual(replies(`${CSI}>0q`), [`${ESC}P>|corral${ST}`]);
  assert.deepEqual(replies(`${CSI}>q`), [`${ESC}P>|corral${ST}`]);
});

test('DECRQM for DEC private modes', () => {
  assert.deepEqual(replies(`${CSI}?2026$p`), [`${CSI}?2026;2$y`]);
  assert.deepEqual(replies(`${CSI}?25$p`), [`${CSI}?25;1$y`]);
  assert.deepEqual(replies(`${CSI}?7$p`), [`${CSI}?7;1$y`]);
  assert.deepEqual(replies(`${CSI}?1049$p`, 80, 24, `${CSI}?1049h`), [`${CSI}?1049;1$y`]);
  assert.deepEqual(replies(`${CSI}?1006$p`, 80, 24, `${CSI}?1006h`), [`${CSI}?1006;1$y`]);
  assert.deepEqual(replies(`${CSI}?2004$p`), [`${CSI}?2004;2$y`]);
  assert.deepEqual(replies(`${CSI}?9999$p`), [`${CSI}?9999;0$y`]);
  for (const m of [1, 6, 12, 47, 66, 1000, 1002, 1003, 1004, 1005, 1015, 1016, 1047, 1048, 2027, 2031]) {
    assert.deepEqual(replies(`${CSI}?${m}$p`), [`${CSI}?${m};2$y`], `mode ${m}`);
  }
});

test('DECRQM for ANSI modes', () => {
  assert.deepEqual(replies(`${CSI}4$p`), [`${CSI}4;2$y`]);
  assert.deepEqual(replies(`${CSI}4$p`, 80, 24, `${CSI}4h`), [`${CSI}4;1$y`]);
  assert.deepEqual(replies(`${CSI}20$p`, 80, 24, `${CSI}20h`), [`${CSI}20;1$y`]);
  assert.deepEqual(replies(`${CSI}3$p`), [`${CSI}3;0$y`]);
});

test('OSC 10/11/12 color queries use the default colors and end with ST', () => {
  assert.deepEqual(replies(`${ESC}]10;?\x07`), [`${ESC}]10;rgb:d0d0/d0d0/d0d0${ST}`]);
  assert.deepEqual(replies(`${ESC}]11;?${ST}`), [`${ESC}]11;rgb:1010/1010/1010${ST}`]);
  assert.deepEqual(replies(`${ESC}]12;?${ST}`), [`${ESC}]12;rgb:d0d0/d0d0/d0d0${ST}`]);
  // One OSC can query the next colors too.
  assert.deepEqual(replies(`${ESC}]10;?;?${ST}`), [`${ESC}]10;rgb:d0d0/d0d0/d0d0${ST}`, `${ESC}]11;rgb:1010/1010/1010${ST}`]);
  // Setting a color is ignored.
  assert.deepEqual(replies(`${ESC}]10;#ffffff${ST}`), []);
});

test('OSC color queries follow the options', () => {
  const h = make(10, 2, { defaultFg: 0x123456, defaultBg: 0xabcdef, cursorColor: 0x010203 });
  h.em.write(`${ESC}]10;?\x07${ESC}]11;?\x07${ESC}]12;?\x07`);
  assert.deepEqual(h.replies, [
    `${ESC}]10;rgb:1212/3434/5656${ST}`,
    `${ESC}]11;rgb:abab/cdcd/efef${ST}`,
    `${ESC}]12;rgb:0101/0202/0303${ST}`,
  ]);
});

test('OSC 4 palette query', () => {
  assert.deepEqual(replies(`${ESC}]4;1;?${ST}`), [`${ESC}]4;1;rgb:cdcd/0000/0000${ST}`]);
  assert.deepEqual(replies(`${ESC}]4;196;?;232;?${ST}`), [`${ESC}]4;196;rgb:ffff/0000/0000${ST}`, `${ESC}]4;232;rgb:0808/0808/0808${ST}`]);
});

test('kitty keyboard: query gets no reply, push/pop/set are ignored', () => {
  assert.deepEqual(replies(`${CSI}?u`), []);
  assert.deepEqual(replies(`${CSI}>1u${CSI}<u${CSI}=1;1u${CSI}>4;2m`), []);
});

test('kitty keyboard pop must not restore the cursor (CSI u without prefix does)', () => {
  const h = make(10, 3);
  h.em.write(`${CSI}2;2H${CSI}s${CSI}3;5H${CSI}<u${CSI}>1u${CSI}=1u`);
  assert.deepEqual([h.em.cursor.x, h.em.cursor.y], [4, 2]);
  h.em.write(`${CSI}u`);
  assert.deepEqual([h.em.cursor.x, h.em.cursor.y], [1, 1]);
});

test('XTGETTCAP and DECRQSS', () => {
  assert.deepEqual(replies(`${ESC}P+q544e${ST}`), [`${ESC}P0+r${ST}`]);
  assert.deepEqual(replies(`${ESC}P$qm${ST}`), [`${ESC}P1$r0m${ST}`]);
  assert.deepEqual(replies(`${ESC}P$qr${ST}`, 80, 24), [`${ESC}P1$r1;24r${ST}`]);
  assert.deepEqual(replies(`${ESC}P$q q${ST}`), [`${ESC}P1$r1 q${ST}`]);
  assert.deepEqual(replies(`${ESC}P$qzz${ST}`), [`${ESC}P0$r${ST}`]);
});

test('window size reports', () => {
  assert.deepEqual(replies(`${CSI}18t`, 100, 30), [`${CSI}8;30;100t`]);
  assert.deepEqual(replies(`${CSI}14t`, 100, 30), [`${CSI}4;480;800t`]);
  assert.deepEqual(replies(`${CSI}16t`, 100, 30), [`${CSI}6;16;8t`]);
  assert.deepEqual(replies(`${CSI}22;0t${CSI}23;0t${CSI}8;10;10t${CSI}1t`), []);
  const h = make(10, 2, { cellWidthPx: 9, cellHeightPx: 19 });
  h.em.write(`${CSI}14t${CSI}16t`);
  assert.deepEqual(h.replies, [`${CSI}4;38;90t`, `${CSI}6;19;9t`]);
});

test('color scheme query (CSI ? 996 n) reports dark for the default background', () => {
  assert.deepEqual(replies(`${CSI}?996n`), [`${CSI}?997;1n`]);
  const h = make(10, 2, { defaultBg: 0xffffff });
  h.em.write(`${CSI}?996n`);
  assert.deepEqual(h.replies, [`${CSI}?997;2n`]);
});

test('silent sequences: no reply and no text', () => {
  const quiet = [
    `${ESC}_Gi=31337,s=1,v=1,a=q,t=d,f=24;AAAA${ST}`,
    `${ESC}]104${ST}`,
    `${ESC}]110\x07${ESC}]111\x07${ESC}]112\x07`,
    `${ESC}]7;file://host/tmp${ST}`,
    `${ESC}]52;c;aGVsbG8=\x07`,
    `${ESC}]66;w=1; ${ST}`,
    `${ESC}]99;i=opentui-notifications:p=?;${ST}`,
    `${ESC}]133;A\x07`,
    `${ESC}]1337;Capabilities${ST}`,
    `${ESC}]7501;?${ST}`,
    `${ESC}]7501;state=idle:app=opencode${ST}`,
    `${ESC}]22;pointer${ST}`,
    `${ESC}]1;icon\x07`,
    `${CSI}?1;2;3x`,
    `${CSI}>1;2;3;4;5y`,
    `${ESC}^privacy${ST}`,
    `${ESC}Xsos${ST}`,
    `${ESC}N${ESC}O`,
  ];
  for (const q of quiet) assert.deepEqual(replies(q), [], JSON.stringify(q));
});

test('OSC 8 hyperlinks keep the text and drop the link', () => {
  const h = make(20, 1);
  h.em.write(`${ESC}]8;;https://example.com${ST}link${ESC}]8;;${ST} after`);
  assert.equal(text(h.em), 'link after');
});

test('OSC 0 and 2 set the title; control characters are removed', () => {
  const h = make(10, 1);
  h.em.write(`${ESC}]0;OpenCode\x07`);
  assert.equal(h.em.title, 'OpenCode');
  h.em.write(`${ESC}]2;a\x01b${ST}`);
  assert.equal(h.em.title, 'ab');
  assert.equal(text(h.em), '');
});
