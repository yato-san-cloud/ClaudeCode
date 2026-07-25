// ステージ定義。グリッドは 72 x 104 セル固定。
//
// 素材の性質の差が、そのままパズルの解法になっている:
//   - 溶岩は「液体」。横に広がるので、窓(横穴)から排水溝へ逃がせる。
//   - お宝は「粉体」。横には流れないので、棚の上に積もったまま待ってくれる。
//   - 岩も粉体。ただし排水溝は溶岩とお宝しか飲まないので、岩は落とし穴の栓になる。
//
// 組み立てのお約束:
//   - 「棚」の上面 y は、その段の「窓」の下端 y と一致させる。
//     ずれていると溶岩が最後の一層を流し切れず、抜いた瞬間に残り火が直撃する。
//   - 部屋は上下左右を壁で閉じる。窓の高さに開いた面があると中身が漏れる。
//
// solution / traps は tools/verify.mjs による検証とゲーム内ヒントの両方で使う。
// wait: 'settle' は「場が落ち着くまで待つ」、数値はティック数。

export const GRID_W = 72;
export const GRID_H = 104;

/**
 * 仕切り壁の左側。細い縦穴だけ残して岩で埋める。
 * 全面を空洞にすると画面の半分以上がただの闇になって、絵として持たない。
 */
function drainShaft() {
  return [
    ['wall', 3, 3, 25, 99], // 左の岩盤 (x3..27)
    ['drain', 28, 95, 13, 6], // 縦穴の底の排水溝 (x28..40)
  ];
}

/** 全ステージ共通の外壁。 */
function frame() {
  return [
    ['wall', 0, 0, 72, 3],
    ['wall', 0, 101, 72, 3],
    ['wall', 0, 0, 3, 104],
    ['wall', 69, 0, 3, 104],
  ];
}

export const LEVELS = [
  {
    id: 1,
    name: 'はじまりの宝',
    need: 90,
    hint: '溶岩が流れ切るまで、棚は抜くな。',
    intro: 'お宝を勇者にとどけろ！',
    build: [
      ...frame(),
      // 仕切り壁。y40..49 が「窓」= 溶岩の逃げ道。
      ['wall', 41, 3, 4, 37],
      ['wall', 41, 50, 4, 51],
      // 右の縦坑。お宝が上、溶岩が下。溶岩の下には何もないので開始と同時に落ちる。
      ['gold', 45, 4, 24, 12],
      ['lava', 45, 20, 24, 13],
      ...drainShaft(),
      ['hero', 45, 88, 24, 13],
    ],
    pins: [
      { id: 1, x: 45, y: 16, w: 24, h: 3, dir: 'right', label: '①' },
      { id: 2, x: 45, y: 50, w: 24, h: 3, dir: 'left', label: '②' },
    ],
    solution: [{ pin: 2, wait: 'settle' }, { pin: 1, wait: 'settle' }],
    traps: [{ label: '棚を先に抜くと溶岩が直撃する', steps: [{ pin: 2, wait: 4 }] }],
  },

  {
    id: 2,
    name: '二段の門',
    need: 90,
    hint: '中段には逃げ道がない。上の棚を抜く前に溶岩を空にしろ。',
    intro: '棚は二段。どちらから抜く？',
    build: [
      ...frame(),
      // 窓は上段の棚の高さだけ。中段に落ちた溶岩は行き場がない。
      ['wall', 41, 3, 4, 29],
      ['wall', 41, 44, 4, 57],
      ['gold', 45, 4, 24, 12],
      ['lava', 45, 20, 24, 11],
      ...drainShaft(),
      ['hero', 45, 88, 24, 13],
    ],
    pins: [
      { id: 1, x: 45, y: 16, w: 24, h: 3, dir: 'right', label: '①' },
      { id: 2, x: 45, y: 44, w: 24, h: 3, dir: 'left', label: '②' },
      { id: 3, x: 45, y: 64, w: 24, h: 3, dir: 'right', label: '③' },
    ],
    solution: [
      { pin: 2, wait: 'settle' },
      { pin: 3, wait: 'settle' },
      { pin: 1, wait: 'settle' },
    ],
    traps: [
      { label: '両方の棚を先に抜くと直撃', steps: [{ pin: 3, wait: 2 }, { pin: 2, wait: 2 }] },
      {
        label: '上の棚を早く抜くと中段に溶岩が残り、③で落ちてくる',
        steps: [{ pin: 2, wait: 20 }, { pin: 3, wait: 400 }],
      },
    ],
  },

  {
    id: 3,
    name: '二重の貯蔵庫',
    need: 190,
    hint: '宝の下に溶岩。溶岩の床を先に抜いて、流し切ってから宝を落とせ。',
    intro: '宝の真下に、溶岩が詰まっている。',
    build: [
      ...frame(),
      ['wall', 41, 3, 4, 37],
      ['wall', 41, 50, 4, 51],
      // 宝と溶岩をそれぞれ別の床(ピン)で支える。順番を間違えると宝が溶岩に落ちて溶ける。
      ['gold', 45, 4, 24, 9],
      ['lava', 45, 17, 24, 12],
      ...drainShaft(),
      ['hero', 45, 88, 24, 13],
    ],
    pins: [
      { id: 1, x: 45, y: 13, w: 24, h: 3, dir: 'right', label: '①' },
      { id: 2, x: 45, y: 29, w: 24, h: 3, dir: 'left', label: '②' },
      { id: 3, x: 45, y: 50, w: 24, h: 3, dir: 'right', label: '③' },
    ],
    solution: [
      { pin: 2, wait: 'settle' },
      { pin: 3, wait: 'settle' },
      { pin: 1, wait: 'settle' },
    ],
    traps: [
      {
        label: '宝の床を先に抜くと宝が溶岩に落ちて溶ける',
        steps: [{ pin: 1, wait: 2 }, { pin: 2, wait: 'settle' }, { pin: 3, wait: 'settle' }],
      },
      {
        label: '棚を抜いてから溶岩の床を抜くと直撃',
        steps: [{ pin: 3, wait: 2 }, { pin: 2, wait: 2 }],
      },
    ],
  },

  {
    id: 4,
    name: '隠し部屋',
    need: 180,
    hint: '隠し部屋を開けないと宝が足りない。溶岩を流し切ってから棚を抜け。',
    intro: '宝が足りない。隠し部屋をこじ開けろ。',
    build: [
      ...frame(),
      // 上段の窓 y28..41、中段の窓 y52..63。段ごとに逃げ道がある。
      ['wall', 41, 3, 4, 25],
      ['wall', 41, 42, 4, 10],
      ['wall', 41, 64, 4, 37],
      // 宝の縦坑は右寄せ。隠し部屋の天井の真上に置くと、そこに砂山ができて回収できない。
      ['wall', 45, 3, 12, 15],
      ['gold', 57, 4, 12, 11],
      ['lava', 45, 20, 24, 10],
      ...drainShaft(),
      // 隠し部屋。中身は宝だけにしてある。同じ部屋に溶岩を同居させると、
      // 床のピンを抜いた瞬間に溶岩が宝を全部溶かしてしまう (ピンは 1 枚の矩形なので、
      // 抜けた跡が溶岩側と宝側をつなぐ通路になってしまい、仕切りようがない)。
      // 床のピンは側壁と同じ幅にして角から斜めに漏れるのを防ぎ、
      // 下端は下段の棚の上面 (y63) より上で止める。棚の上面に居座ると
      // 溶岩だまりを左右に分断してしまい、右側が窓にたどり着けなくなる。
      ['wall', 45, 45, 11, 2],
      ['wall', 45, 47, 2, 10],
      ['wall', 54, 47, 2, 10],
      ['gold', 47, 47, 7, 10],
      ['hero', 45, 88, 24, 13],
    ],
    pins: [
      { id: 1, x: 57, y: 15, w: 12, h: 3, dir: 'left', label: '①' },
      { id: 2, x: 45, y: 42, w: 24, h: 3, dir: 'left', label: '②' },
      { id: 3, x: 45, y: 57, w: 11, h: 3, dir: 'right', label: '③' },
      { id: 4, x: 45, y: 64, w: 24, h: 3, dir: 'left', label: '④' },
    ],
    // 宝のゲート(①)は最後。棚が残っているうちに落とすと、棚の上で砂山が横に広がり、
    // 勇者から外れた場所に積もって回収できなくなる。
    solution: [
      { pin: 2, wait: 'settle' },
      { pin: 3, wait: 'settle' },
      { pin: 4, wait: 'settle' },
      { pin: 1, wait: 'settle' },
    ],
    traps: [
      { label: '最下段を先に抜くと全部が勇者へ', steps: [{ pin: 4, wait: 2 }, { pin: 2, wait: 2 }] },
      {
        label: '隠し部屋を開けないと宝が足りない',
        steps: [{ pin: 2, wait: 'settle' }, { pin: 4, wait: 'settle' }, { pin: 1, wait: 'settle' }],
      },
    ],
  },

  {
    id: 5,
    name: '最後の門',
    need: 155,
    hint: '棚は三段。上から順に、溶岩を流し切ってから抜いていけ。',
    intro: '広告で見た、あのステージだ。',
    build: [
      ...frame(),
      // 三段構え。窓は y26..37 / y48..57 / y64..73 の三つ。
      ['wall', 41, 3, 4, 23],
      ['wall', 41, 38, 4, 10],
      ['wall', 41, 58, 4, 6],
      ['wall', 41, 74, 4, 27],
      ['wall', 45, 3, 12, 14],
      ['gold', 57, 4, 12, 10],
      ['lava', 45, 19, 24, 7],
      ...drainShaft(),
      // 中段の隠し部屋。ステージ4 と同じ理由で中身は宝だけ。
      ['wall', 45, 41, 11, 2],
      ['wall', 45, 43, 2, 8],
      ['wall', 54, 43, 2, 8],
      ['gold', 47, 43, 7, 8],
      ['hero', 45, 88, 24, 13],
    ],
    pins: [
      { id: 1, x: 57, y: 14, w: 12, h: 3, dir: 'left', label: '①' },
      { id: 2, x: 45, y: 38, w: 24, h: 3, dir: 'left', label: '②' },
      { id: 3, x: 45, y: 51, w: 11, h: 3, dir: 'right', label: '③' },
      { id: 4, x: 45, y: 58, w: 24, h: 3, dir: 'left', label: '④' },
      { id: 5, x: 45, y: 74, w: 24, h: 3, dir: 'right', label: '⑤' },
    ],
    solution: [
      { pin: 2, wait: 'settle' },
      { pin: 3, wait: 'settle' },
      { pin: 4, wait: 'settle' },
      { pin: 5, wait: 'settle' },
      { pin: 1, wait: 'settle' },
    ],
    traps: [
      {
        label: '下から抜くと全部が勇者へ',
        steps: [{ pin: 5, wait: 2 }, { pin: 4, wait: 2 }, { pin: 2, wait: 2 }],
      },
      {
        label: '隠し部屋を開けないと宝が足りない',
        steps: [
          { pin: 2, wait: 'settle' },
          { pin: 4, wait: 'settle' },
          { pin: 5, wait: 'settle' },
          { pin: 1, wait: 'settle' },
        ],
      },
    ],
  },
];

export const AD_LEVEL = LEVELS[0];
