(() => {
  'use strict';

  // ============================================================
  //  CONSTANTS & DOM
  // ============================================================
  const W = 480, H = 720;
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');
  const $ = (id) => document.getElementById(id);

  const ui = {
    hud: $('hud'), menu: $('menu'), pause: $('pauseScreen'), over: $('gameOver'),
    score: $('score'), hi: $('hiscore'), lives: $('lives'), stageNum: $('stageNum'),
    health: $('healthFill'), weapon: $('weaponInfo'), finalScore: $('finalScore'),
    newRecord: $('newRecord'), menuHi: $('menuHi'), banner: $('banner'),
  };

  const HI_KEY = 'galaxyStriker.highScore';
  const MUTE_KEY = 'galaxyStriker.muted';
  const COMBO_WINDOW = 2.2;
  const MAX_WEAPON = 3, MAX_BOMBS = 3, START_BOMBS = 2;
  const PLAYER_SPEED = 380, FIRE_DELAY = 0.16;
  const MAX_PARTICLES = 400;

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : v; }
      catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, String(value)); } catch (e) { /* storage blocked */ }
    },
  };
  const loadHigh = () => parseInt(store.get(HI_KEY, '0'), 10) || 0;
  let muted = store.get(MUTE_KEY, '0') === '1';

  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const overlaps = (ax, ay, aw, ah, bx, by, bw, bh) =>
    Math.abs(ax - bx) < (aw + bw) / 2 && Math.abs(ay - by) < (ah + bh) / 2;

  // ============================================================
  //  AUDIO (Web Audio synth, no external files)
  // ============================================================
  let actx = null, master = null;

  function ensureAudio() {
    if (!actx) {
      try {
        actx = new (window.AudioContext || window.webkitAudioContext)();
        master = actx.createGain();
        master.gain.value = muted ? 0 : 0.9;
        master.connect(actx.destination);
      } catch (e) { actx = null; }
    }
    if (actx && actx.state === 'suspended') actx.resume();
  }

  function setMuted(m) {
    muted = m;
    store.set(MUTE_KEY, m ? '1' : '0');
    if (master) master.gain.value = m ? 0 : 0.9;
  }

  function tone(freq, dur, type = 'square', vol = 0.08, slide = 0, delay = 0) {
    if (!actx) return;
    const t = actx.currentTime + delay;
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  function noise(dur, vol = 0.15) {
    if (!actx) return;
    const len = Math.floor(actx.sampleRate * dur);
    const buf = actx.createBuffer(1, len, actx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = actx.createBufferSource();
    const g = actx.createGain();
    src.buffer = buf;
    g.gain.value = vol;
    src.connect(g);
    g.connect(master);
    src.start();
  }

  const SFX = {
    shoot: () => tone(880, 0.07, 'square', 0.03, -500),
    enemyShoot: () => tone(300, 0.1, 'sawtooth', 0.025, -150),
    hit: () => tone(180, 0.07, 'triangle', 0.07, -80),
    explode: (big) => noise(big ? 0.7 : 0.3, big ? 0.35 : 0.18),
    power: () => { tone(520, 0.1, 'triangle', 0.12); tone(780, 0.15, 'triangle', 0.12, 0, 0.09); },
    hurt: () => { tone(120, 0.35, 'sawtooth', 0.14, -60); noise(0.2, 0.1); },
    graze: () => tone(1400, 0.05, 'sine', 0.04),
    combo: (m) => tone(440 + m * 80, 0.12, 'triangle', 0.08),
    bomb: () => { noise(0.9, 0.4); tone(90, 0.6, 'sawtooth', 0.2, 180); },
    warn: () => {
      tone(220, 0.15, 'square', 0.06);
      tone(220, 0.15, 'square', 0.06, 0, 0.25);
      tone(220, 0.15, 'square', 0.06, 0, 0.5);
    },
    beam: () => tone(110, 0.5, 'sawtooth', 0.12, -40),
    levelUp: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.18, 'square', 0.07, 0, i * 0.11)),
    gameOver: () => [400, 320, 240, 160].forEach((f, i) => tone(f, 0.3, 'sawtooth', 0.1, 0, i * 0.25)),
  };

  // ============================================================
  //  DEFINITIONS
  // ============================================================
  const ENEMY = {
    scout:    { w: 32, h: 30, hp: 1,  speed: 150, score: 100, color: '#ff5c7a', fireMin: 1.8, fireMax: 2.8, drop: 0.12, bulletSpeed: 260 },
    weaver:   { w: 38, h: 34, hp: 3,  speed: 110, score: 250, color: '#ffb347', fireMin: 1.4, fireMax: 2.2, drop: 0.22, bulletSpeed: 230 },
    tank:     { w: 58, h: 50, hp: 10, speed: 60,  score: 600, color: '#b66dff', fireMin: 1.2, fireMax: 1.6, drop: 0.40, bulletSpeed: 200 },
    kamikaze: { w: 28, h: 28, hp: 2,  speed: 0,   score: 180, color: '#ff3cac', drop: 0.15, noFire: true },
  };

  const PU = {
    W: { color: '#66a8ff', label: 'W' },
    S: { color: '#5ff3ff', label: 'S' },
    H: { color: '#6dff8a', label: '+' },
    L: { color: '#ff7ad9', label: '1UP' },
    B: { color: '#ffb703', label: 'B' },
  };

  const KEY_MAP = {
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'up', KeyW: 'up',
    ArrowDown: 'down', KeyS: 'down',
    Space: 'fire',
  };

  // ============================================================
  //  STATE
  // ============================================================
  let state = 'menu';                // menu | playing | paused | over
  let time = 0, shake = 0, flash = 0;
  let score = 0, highScore = loadHigh();
  let stage = 1, stageDone = 0, stageGoal = 0, spawned = 0, spawnTimer = 0, bannerTimer = 0;
  let combo = { count: 0, timer: 0, mult: 1, best: 1 };
  let stats = { kills: 0, graze: 0, bombs: 0 };

  let bullets = [], enemyBullets = [], enemies = [], powerups = [];
  let particles = [], texts = [], rings = [], stars = [];
  let boss = null, beam = null;
  let bgCanvas = null;

  const player = {
    x: W / 2, y: H - 100, w: 40, h: 46,
    cool: 0, weapon: 1, health: 100, lives: 3, invuln: 0, shield: 0, bombs: START_BOMBS,
  };
  const input = { left: false, right: false, up: false, down: false, fire: false };
  const touch = { active: false, x: W / 2, y: H - 100, lastTap: 0, tapX: 0, tapY: 0 };

  // ============================================================
  //  INPUT
  // ============================================================
  window.addEventListener('keydown', (e) => {
    ensureAudio();
    const action = KEY_MAP[e.code];
    if (action) {
      input[action] = true;
      e.preventDefault();
    }
    if (e.repeat) return;

    switch (e.code) {
      case 'Enter':
      case 'NumpadEnter':
      case 'Space':
        if (state === 'menu' || state === 'over') startGame();
        break;
      case 'KeyP':
      case 'Escape':
        togglePause();
        break;
      case 'KeyR':
        if (state === 'over' || state === 'paused') startGame();
        break;
      case 'KeyB':
        useBomb();
        break;
      case 'KeyM':
        setMuted(!muted);
        break;
    }
  });

  window.addEventListener('keyup', (e) => {
    const action = KEY_MAP[e.code];
    if (action) input[action] = false;
  });

  function toGameCoords(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height };
  }

  canvas.addEventListener('pointerdown', (e) => {
    ensureAudio();
    if (state !== 'playing') return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);

    const p = toGameCoords(e);
    const now = performance.now();
    // Double-tap = bomb
    if (now - touch.lastTap < 300 && Math.hypot(p.x - touch.tapX, p.y - touch.tapY) < 60) {
      useBomb();
      touch.lastTap = 0;
    } else {
      touch.lastTap = now;
      touch.tapX = p.x;
      touch.tapY = p.y;
    }

    touch.active = true;
    touch.x = p.x;
    touch.y = p.y;
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!touch.active) return;
    const p = toGameCoords(e);
    touch.x = p.x;
    touch.y = p.y;
  });

  const endTouch = () => { touch.active = false; };
  canvas.addEventListener('pointerup', endTouch);
  canvas.addEventListener('pointercancel', endTouch);
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  function autoPause() { if (state === 'playing') togglePause(); }
  document.addEventListener('visibilitychange', () => { if (document.hidden) autoPause(); });
  window.addEventListener('blur', autoPause);

  $('startBtn').onclick = startGame;
  $('restartBtn').onclick = startGame;
  $('resumeBtn').onclick = togglePause;
  $('pauseBtn').onclick = togglePause;
  $('menuBtn').onclick = showMenu;
  $('menuBtn2').onclick = showMenu;

  const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  $('controlsHint').textContent = isTouch
    ? 'Drag to move • Double-tap for BOMB'
    : 'Arrows/WASD move • Space fire • B bomb • P pause • M mute';

  // ============================================================
  //  SCREEN / FLOW
  // ============================================================
  function showMenu() {
    state = 'menu';
    input.left = input.right = input.up = input.down = input.fire = false;
    ui.menu.classList.remove('hidden');
    ui.pause.classList.add('hidden');
    ui.over.classList.add('hidden');
    ui.hud.classList.add('hidden');
    ui.menuHi.textContent = loadHigh();
  }

  function startGame() {
    if (state === 'playing') return;
    ensureAudio();
    resetGame();
    state = 'playing';
    ui.menu.classList.add('hidden');
    ui.pause.classList.add('hidden');
    ui.over.classList.add('hidden');
    ui.hud.classList.remove('hidden');
  }

  function togglePause() {
    if (state === 'playing') {
      state = 'paused';
      input.left = input.right = input.up = input.down = input.fire = false;
      touch.active = false;
      ui.pause.classList.remove('hidden');
    } else if (state === 'paused') {
      state = 'playing';
      ui.pause.classList.add('hidden');
    }
  }

  function renderStats() {
    let el = $('statsLine');
    if (!el) {
      el = document.createElement('p');
      el.id = 'statsLine';
      el.className = 'final';
      el.style.fontSize = '14px';
      el.style.color = '#9fc9e0';
      ui.over.insertBefore(el, $('restartBtn'));
    }
    el.textContent = `Kills ${stats.kills}  •  Best combo x${combo.best}  •  Grazes ${stats.graze}`;
  }

  function gameOver() {
    state = 'over';
    SFX.gameOver();
    const stored = loadHigh();
    const isRecord = score > 0 && score > stored;
    if (isRecord) store.set(HI_KEY, score);
    highScore = Math.max(stored, score);
    ui.finalScore.textContent = score;
    ui.newRecord.classList.toggle('hidden', !isRecord);
    renderStats();
    ui.over.classList.remove('hidden');
    ui.hud.classList.add('hidden');
  }

  function resetGame() {
    bullets = []; enemyBullets = []; enemies = []; powerups = [];
    particles = []; texts = []; rings = [];
    boss = null; beam = null;
    shake = 0; flash = 0; score = 0;
    combo = { count: 0, timer: 0, mult: 1, best: 1 };
    stats = { kills: 0, graze: 0, bombs: 0 };
    Object.assign(player, {
      x: W / 2, y: H - 100, cool: 0, weapon: 1, health: 100,
      lives: 3, invuln: 1.2, shield: 0, bombs: START_BOMBS,
    });
    touch.active = false;
    beginStage(1);
    showBanner('STAGE 1', 2);
  }

  function beginStage(n) {
    stage = n;
    stageDone = 0;
    spawned = 0;
    stageGoal = 14 + n * 4;
    spawnTimer = 1.0;
  }

  function nextStage(message) {
    beginStage(stage + 1);
    showBanner(message || ('STAGE ' + stage), 2.2);
    SFX.levelUp();
  }

  function showBanner(text, dur) {
    ui.banner.textContent = text;
    ui.banner.classList.add('show');
    bannerTimer = dur;
  }

  // ============================================================
  //  BACKGROUND & STARS (pre-rendered for performance)
  // ============================================================
  function buildBackground() {
    bgCanvas = document.createElement('canvas');
    bgCanvas.width = W;
    bgCanvas.height = H;
    const g = bgCanvas.getContext('2d');

    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#04020f');
    grad.addColorStop(0.6, '#0a0e2e');
    grad.addColorStop(1, '#1a0d3d');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);

    const nebulae = [
      [120, 200, 'rgba(123,92,255,0.18)', 160],
      [380, 480, 'rgba(46,240,255,0.12)', 200],
      [200, 620, 'rgba(255,71,140,0.10)', 180],
    ];
    for (const [x, y, c, r] of nebulae) {
      const rg = g.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, c);
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rg;
      g.fillRect(0, 0, W, H);
    }
  }

  function initStars() {
    stars = [];
    for (let i = 0; i < 120; i++) {
      stars.push({ x: Math.random() * W, y: Math.random() * H, z: rand(0.2, 1) });
    }
  }

  function updateStars(dt) {
    const k = state === 'playing' ? 1 : 0.35;
    for (const s of stars) {
      s.y += s.z * 140 * k * dt;
      if (s.y > H) { s.y = 0; s.x = Math.random() * W; }
    }
  }

  function drawStars() {
    for (const s of stars) {
      ctx.fillStyle = 'rgba(200,230,255,' + (0.25 + s.z * 0.7).toFixed(2) + ')';
      const size = 0.8 + s.z * 1.6;
      ctx.fillRect(s.x, s.y, size, size);
    }
  }

  // ============================================================
  //  PLAYER
  // ============================================================
  function updatePlayer(dt) {
    const p = player;
    if (touch.active) {
      const tx = touch.x, ty = touch.y - 70;
      p.x += (tx - p.x) * Math.min(1, dt * 14);
      p.y += (ty - p.y) * Math.min(1, dt * 14);
    } else {
      let dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      let dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
      if (dx && dy) { dx *= Math.SQRT1_2; dy *= Math.SQRT1_2; }
      p.x += dx * PLAYER_SPEED * dt;
      p.y += dy * PLAYER_SPEED * dt;
    }
    p.x = clamp(p.x, p.w / 2, W - p.w / 2);
    p.y = clamp(p.y, 70, H - p.h / 2 - 10);
  }

  function firePlayer() {
    const p = player;
    const lv = p.weapon;
    const offsets = lv === 1 ? [0] : lv === 2 ? [-10, 10] : [-16, 0, 16];
    for (const ox of offsets) {
      bullets.push({
        x: p.x + ox, y: p.y - 22, w: 5, h: 16,
        vx: lv === 3 ? ox * 3 : 0, vy: -620, dmg: 1,
        color: lv === 3 ? '#ffe066' : '#7ff7ff', dead: false,
      });
    }
    p.cool = lv >= 3 ? FIRE_DELAY * 0.8 : FIRE_DELAY;
    SFX.shoot();
  }

  function hurtPlayer(dmg) {
    const p = player;
    if (state !== 'playing' || p.invuln > 0) return;

    if (p.shield > 0) {
      p.shield = 0;
      p.invuln = 0.8;
      explode(p.x, p.y, '#5ff3ff', 20, 200, 3);
      addRing(p.x, p.y, '#5ff3ff', 70, 0.35);
      SFX.hit();
      return;
    }

    p.health -= dmg;
    p.invuln = 1.0;
    shake = 10;
    flash = 0.2;
    resetCombo();
    SFX.hurt();
    if (p.health > 0) return;

    // Ship destroyed
    p.lives--;
    explode(p.x, p.y, '#2ef0ff', 50, 260, 4);
    addRing(p.x, p.y, '#2ef0ff', 160, 0.6);
    SFX.explode(true);
    if (p.lives <= 0) {
      p.lives = 0;
      gameOver();
      return;
    }
    // Respawn
    p.health = 100;
    p.weapon = Math.max(1, p.weapon - 1);
    p.invuln = 2.5;
    p.x = W / 2;
    p.y = H - 100;
    enemyBullets = [];
    beam = null;
  }

  function collectPowerup(pu) {
    const p = player;
    SFX.power();
    switch (pu.kind) {
      case 'W': p.weapon = Math.min(MAX_WEAPON, p.weapon + 1); addText(p.x, p.y - 40, 'WEAPON UP!', '#66a8ff'); break;
      case 'S': p.shield = 8; addText(p.x, p.y - 40, 'SHIELD!', '#5ff3ff'); break;
      case 'H': p.health = Math.min(100, p.health + 35); addText(p.x, p.y - 40, '+35 HP', '#6dff8a'); break;
      case 'L': p.lives++; addText(p.x, p.y - 40, 'EXTRA LIFE!', '#ff7ad9'); break;
      case 'B': p.bombs = Math.min(MAX_BOMBS, p.bombs + 1); addText(p.x, p.y - 40, 'BOMB +1', '#ffb703'); break;
    }
  }

  function drawPlayer() {
    const p = player;
    if (p.invuln > 0 && Math.floor(p.invuln * 12) % 2 === 0) return; // blink

    ctx.save();
    ctx.translate(p.x, p.y);

    // Engine flame
    const flame = 8 + Math.random() * 8;
    ctx.fillStyle = 'rgba(255,160,40,0.9)';
    ctx.beginPath();
    ctx.moveTo(-6, 18); ctx.lineTo(0, 18 + flame); ctx.lineTo(6, 18);
    ctx.fill();

    // Hull
    ctx.fillStyle = '#2ef0ff';
    ctx.beginPath();
    ctx.moveTo(0, -26);
    ctx.lineTo(22, 18);
    ctx.lineTo(8, 12);
    ctx.lineTo(0, 18);
    ctx.lineTo(-8, 12);
    ctx.lineTo(-22, 18);
    ctx.closePath();
    ctx.fill();

    // Cockpit
    ctx.fillStyle = '#c8fbff';
    ctx.beginPath();
    ctx.moveTo(0, -18); ctx.lineTo(6, 8); ctx.lineTo(0, 12); ctx.lineTo(-6, 8);
    ctx.closePath();
    ctx.fill();

    // Shield ring (pulsing)
    if (p.shield > 0) {
      ctx.strokeStyle = 'rgba(80,220,255,' + (0.5 + 0.3 * Math.sin(time * 10)).toFixed(2) + ')';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, 34, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawPlayerIfVisible() {
    if (state === 'playing' || state === 'paused') drawPlayer();
  }

  // ============================================================
  //  BULLETS
  // ============================================================
  function makeEnemyBullet(x, y, vx, vy, r, color) {
    enemyBullets.push({ x, y, vx, vy, r, color, dead: false, grazed: false });
  }

  function fireStraight(x, y, speed) {
    makeEnemyBullet(x, y, 0, speed, 5, '#ff6b8a');
  }

  function fireAimed(x, y, speed) {
    const dx = player.x - x, dy = player.y - y;
    const len = Math.hypot(dx, dy) || 1;
    makeEnemyBullet(x, y, dx / len * speed, dy / len * speed, 6, '#ffd27a');
  }

  function fireSpread(x, y, count, speed, spread) {
    for (let i = 0; i < count; i++) {
      const a = Math.PI / 2 + (i - (count - 1) / 2) * spread;
      makeEnemyBullet(x, y, Math.cos(a) * speed, Math.sin(a) * speed, 5, '#ff8f5c');
    }
  }

  function fireRing(x, y, count, speed) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      makeEnemyBullet(x, y, Math.cos(a) * speed, Math.sin(a) * speed, 5, '#c37bff');
    }
  }

  function drawBullets() {
    for (const b of bullets) {
      ctx.fillStyle = b.color;
      ctx.fillRect(b.x - b.w / 2, b.y - b.h / 2, b.w, b.h);
    }
  }

  function drawEnemyBullets() {
    for (const b of enemyBullets) {
      ctx.fillStyle = b.color;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ============================================================
  //  ENEMIES (AI)
  // ============================================================
  function spawnEnemy(kind, x) {
    const def = ENEMY[kind];
    const e = {
      kind, x: x !== undefined ? x : rand(40, W - 40), y: -40,
      w: def.w, h: def.h, hp: def.hp, maxHp: def.hp,
      color: def.color, score: def.score, drop: def.drop,
      t: rand(0, 6), baseX: 0, vx: 0, vy: 0, flash: 0,
      fireT: def.noFire ? Infinity : rand(def.fireMin, def.fireMax),
      dead: false,
    };
    e.baseX = e.x;
    enemies.push(e);
  }

  function updateEnemy(e, dt) {
    const def = ENEMY[e.kind];
    e.t += dt;
    e.flash = Math.max(0, e.flash - dt);

    if (e.kind === 'scout') {
      // Straight dive with wobble
      e.y += def.speed * dt;
      e.x += Math.sin(e.t * 3) * 40 * dt;
    } else if (e.kind === 'weaver') {
      // Sine-wave weaving
      e.y += def.speed * dt;
      e.x = e.baseX + Math.sin(e.t * 2.2) * 90;
    } else if (e.kind === 'tank') {
      // Slow armored unit that tracks the player horizontally
      e.y += def.speed * dt;
      e.x += Math.sign(player.x - e.x) * 50 * dt;
    } else if (e.kind === 'kamikaze') {
      // Winds up for a moment, then homes in on the player
      const dx = player.x - e.x, dy = player.y - e.y;
      const len = Math.hypot(dx, dy) || 1;
      const sp = e.t < 1.0 ? 60 : 280;
      const k = Math.min(1, dt * 3);
      e.vx = lerp(e.vx, dx / len * sp, k);
      e.vy = lerp(e.vy, dy / len * sp, k);
      e.x += e.vx * dt;
      e.y += e.vy * dt;
    }
    e.x = clamp(e.x, e.w / 2, W - e.w / 2);

    // Shooting AI (scales with stage)
    if (!def.noFire) {
      e.fireT -= dt;
      if (e.fireT <= 0 && e.y > 0 && e.y < H * 0.7) {
        const diff = Math.max(0.6, 1 - stage * 0.03);
        e.fireT = rand(def.fireMin, def.fireMax) * diff;
        if (e.kind === 'tank') fireAimed(e.x, e.y + e.h / 2, def.bulletSpeed + 40);
        else fireStraight(e.x, e.y + e.h / 2, def.bulletSpeed);
        SFX.enemyShoot();
      }
    }
  }

  function drawEnemies() {
    for (const e of enemies) {
      const c = e.flash > 0 ? '#ffffff' : e.color;
      ctx.save();
      ctx.translate(e.x, e.y);
      ctx.fillStyle = c;

      if (e.kind === 'scout') {
        ctx.beginPath();
        ctx.moveTo(0, 15); ctx.lineTo(16, -12); ctx.lineTo(0, -5); ctx.lineTo(-16, -12);
        ctx.closePath();
        ctx.fill();
      } else if (e.kind === 'weaver') {
        ctx.beginPath();
        ctx.arc(0, 0, 16, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#1a0f00';
        ctx.beginPath();
        ctx.arc(0, 0, 6, 0, Math.PI * 2);
        ctx.fill();
      } else if (e.kind === 'tank') {
        ctx.fillRect(-26, -22, 52, 44);
        ctx.fillStyle = '#1b1030';
        ctx.fillRect(-18, -8, 36, 14);
        ctx.fillStyle = '#ffd166';
        ctx.fillRect(-12, -4, 24, 4);
      } else {
        // Kamikaze: sharp dart with a glowing core
        ctx.beginPath();
        ctx.moveTo(0, 15); ctx.lineTo(15, -12); ctx.lineTo(0, -4); ctx.lineTo(-15, -12);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(0, -2, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Health bar for tough enemies
      if (e.maxHp > 1) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(-e.w / 2, -e.h / 2 - 8, e.w, 4);
        ctx.fillStyle = '#6dff8a';
        ctx.fillRect(-e.w / 2, -e.h / 2 - 8, e.w * clamp(e.hp / e.maxHp, 0, 1), 4);
      }
      ctx.restore();
    }
  }

  function destroyEnemy(e, scoring) {
    if (e.dead) return;
    e.dead = true;
    stageDone++;
    if (scoring) {
      registerKill(e);
      if (Math.random() < e.drop) dropPowerup(e.x, e.y);
    }
    const big = e.kind === 'tank';
    explode(e.x, e.y, e.color, big ? 42 : 20, big ? 240 : 170, big ? 6 : 4);
    addRing(e.x, e.y, e.color, big ? 80 : 40, 0.4);
    SFX.explode(big);
    shake = Math.max(shake, big ? 8 : 3);
  }

  // ============================================================
  //  COMBO & SCORE
  // ============================================================
  function registerKill(e) {
    combo.count++;
    combo.timer = COMBO_WINDOW;
    combo.mult = Math.min(5, 1 + Math.floor(combo.count / 5));
    combo.best = Math.max(combo.best, combo.mult);
    stats.kills++;
    addScore(e.score * combo.mult, e.x, e.y);
    if (combo.count % 5 === 0 && combo.mult > 1) {
      SFX.combo(combo.mult);
      addText(W / 2, 140, 'COMBO x' + combo.mult + '!', '#ff7ad9');
    }
  }

  function resetCombo() {
    combo.count = 0;
    combo.mult = 1;
    combo.timer = 0;
  }

  function addScore(n, x, y) {
    score += n;
    if (score > highScore) highScore = score;
    addText(x, y, '+' + n, '#ffe066');
  }

  // ============================================================
  //  BOMB (screen-clearing shockwave)
  // ============================================================
  function useBomb() {
    if (state !== 'playing' || player.bombs <= 0) return;
    player.bombs--;
    stats.bombs++;
    enemyBullets = [];

    for (const e of enemies) {
      if (e.dead) continue;
      e.hp -= 6;
      e.flash = 0.1;
      if (e.hp <= 0) destroyEnemy(e, true);
    }
    if (boss) {
      boss.hp -= 30;
      boss.flash = 0.15;
      if (boss.hp <= 0) destroyBoss();
    }

    addRing(player.x, player.y, '#ffb703', W, 0.7);
    addRing(player.x, player.y, '#ffffff', W * 0.6, 0.45);
    player.invuln = Math.max(player.invuln, 1.2);
    shake = 22;
    flash = 0.35;
    SFX.bomb();
    addText(W / 2, H / 2 - 60, 'BOMB!', '#ffb703');
  }

  // ============================================================
  //  BOSS (4 attacks, 3 phases, telegraphed laser)
  // ============================================================
  function spawnBoss() {
    const maxHp = 80 + stage * 25;
    boss = { x: W / 2, y: -150, w: 180, h: 116, hp: maxHp, maxHp, t: 0, atk: -1, atkT: 1.5, phase: 1, flash: 0 };
    beam = null;
    showBanner('WARNING: BOSS', 2.5);
    SFX.warn();
  }

  function updateBoss(dt) {
    const b = boss;
    b.t += dt;
    b.flash = Math.max(0, b.flash - dt);

    if (b.y < 120) { b.y += 100 * dt; return; }   // entrance

    const ratio = b.hp / b.maxHp;
    const phase = ratio < 0.25 ? 3 : ratio < 0.5 ? 2 : 1;
    if (phase !== b.phase) {
      b.phase = phase;
      showBanner(phase === 3 ? 'BOSS ENRAGED!' : 'BOSS PHASE 2', 1.8);
      shake = 14;
      flash = 0.25;
      addRing(b.x, b.y, '#ff3366', 140, 0.6);
    }

    const speed = phase === 1 ? 0.8 : phase === 2 ? 1.3 : 1.8;
    b.x = W / 2 + Math.sin(b.t * speed) * (W / 2 - 100);

    b.atkT -= dt;
    if (b.atkT <= 0 && !beam) {
      b.atk = (b.atk + 1) % 4;
      b.atkT = phase === 1 ? 2.4 : phase === 2 ? 1.9 : 1.4;
      const fx = b.x, fy = b.y + b.h / 2;
      switch (b.atk) {
        case 0: fireSpread(fx, fy, phase === 1 ? 5 : 7, 250, 0.22); SFX.enemyShoot(); break;
        case 1:
          fireAimed(fx - 30, fy, 300);
          fireAimed(fx, fy, 300);
          fireAimed(fx + 30, fy, 300);
          SFX.enemyShoot();
          break;
        case 2: fireRing(fx, fy, phase === 3 ? 14 : 9, 190); SFX.enemyShoot(); break;
        case 3:
          beam = { x: b.x, t: 0, warn: 0.9, dur: 0.5, fired: false };
          SFX.warn();
          break;
      }
    }
  }

  function updateBeam(dt) {
    beam.t += dt;
    if (!beam.fired && beam.t >= beam.warn) {
      beam.fired = true;
      SFX.beam();
      shake = Math.max(shake, 6);
    }
    if (beam.fired && Math.abs(player.x - beam.x) < 26 + player.w * 0.35) {
      hurtPlayer(15);
    }
    if (beam.t >= beam.warn + beam.dur) beam = null;
  }

  function destroyBoss() {
    const b = boss;
    boss = null;
    beam = null;
    for (let i = 0; i < 14; i++) {
      explode(
        b.x + rand(-b.w / 2, b.w / 2),
        b.y + rand(-b.h / 2, b.h / 2),
        i % 2 ? '#ff8a3d' : '#ffe066', 14, 260, 6
      );
    }
    addRing(b.x, b.y, '#ffe066', 220, 0.9);
    addRing(b.x, b.y, '#ff3366', 150, 0.6);
    SFX.explode(true);
    shake = 24;
    flash = 0.4;
    stats.kills++;
    addScore(2000 + stage * 500, b.x, b.y);
    for (let i = -1; i <= 1; i++) dropPowerup(b.x + i * 50, b.y);
    enemyBullets = [];
    nextStage('BOSS DEFEATED!');
  }

  function drawBoss() {
    const b = boss;
    if (!b) return;

    const base = b.phase === 3 ? '#ff1f4b' : b.phase === 2 ? '#ff3366' : '#ff8a3d';
    const main = b.flash > 0 ? '#ffffff' : base;

    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.fillStyle = main;
    ctx.beginPath();
    ctx.moveTo(0, b.h / 2);
    ctx.lineTo(b.w / 2, -b.h / 4);
    ctx.lineTo(b.w / 3, -b.h / 2);
    ctx.lineTo(-b.w / 3, -b.h / 2);
    ctx.lineTo(-b.w / 2, -b.h / 4);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#1b0a1f';
    ctx.beginPath();
    ctx.arc(0, -4, 20, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = b.phase >= 2 ? '#ffff66' : '#66ffff';
    ctx.beginPath();
    ctx.arc(0, -4, 8 + Math.sin(time * 6) * 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Boss HP bar (bottom)
    const barW = W - 60;
    const ratio = clamp(b.hp / b.maxHp, 0, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(30, H - 26, barW, 10);
    ctx.fillStyle = base;
    ctx.fillRect(30, H - 26, barW * ratio, 10);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px Arial';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('BOSS  PHASE ' + b.phase, 30, H - 30);
  }

  function drawBeam() {
    if (!beam || !boss) return;
    const top = boss.y + boss.h / 2;
    if (!beam.fired) {
      // Telegraph: pulsing dashed warning line
      const a = 0.3 + 0.4 * Math.abs(Math.sin(time * 18));
      ctx.save();
      ctx.strokeStyle = 'rgba(255,80,80,' + a.toFixed(2) + ')';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 8]);
      ctx.beginPath();
      ctx.moveTo(beam.x, top);
      ctx.lineTo(beam.x, H);
      ctx.stroke();
      ctx.restore();
    } else {
      // Active beam
      const w = 26;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(255,60,120,0.35)';
      ctx.fillRect(beam.x - w, top, w * 2, H - top);
      ctx.fillStyle = 'rgba(255,220,240,0.9)';
      ctx.fillRect(beam.x - 5, top, 10, H - top);
      ctx.restore();
    }
  }

  // ============================================================
  //  POWER-UPS
  // ============================================================
  function dropPowerup(x, y) {
    const r = Math.random();
    const kind = r < 0.34 ? 'W' : r < 0.55 ? 'H' : r < 0.70 ? 'S' : r < 0.86 ? 'B' : 'L';
    powerups.push({ kind, x, y, vy: 90, t: 0, dead: false });
  }

  function drawPowerups() {
    for (const p of powerups) {
      const def = PU[p.kind];
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(Math.sin(p.t * 3) * 0.3);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeStyle = def.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = def.color;
      ctx.font = 'bold ' + (def.label.length > 1 ? 9 : 14) + 'px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(def.label, 0, 1);
      ctx.restore();
    }
  }

  // ============================================================
  //  EFFECTS (particles, rings, floating text)
  // ============================================================
  function explode(x, y, color, count, speed, size) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(speed * 0.3, speed);
      const life = rand(0.4, 0.9);
      particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life, max: life, color, size: rand(size * 0.5, size),
      });
    }
    if (particles.length > MAX_PARTICLES) particles.splice(0, particles.length - MAX_PARTICLES);
  }

  function addRing(x, y, color, maxR, life) {
    rings.push({ x, y, color, max: maxR, life, total: life, r: 0 });
  }

  function addText(x, y, text, color) {
    texts.push({ x, y, text, color, life: 1 });
  }

  function updateEffects(dt) {
    const drag = Math.pow(0.98, dt * 60);
    for (const p of particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= drag;
      p.vy *= drag;
      p.life -= dt;
    }
    particles = particles.filter((p) => p.life > 0);

    for (const r of rings) {
      r.life -= dt;
      r.r = r.max * (1 - Math.max(0, r.life) / r.total);
    }
    rings = rings.filter((r) => r.life > 0);

    for (const t of texts) {
      t.y -= 40 * dt;
      t.life -= dt * 0.9;
    }
    texts = texts.filter((t) => t.life > 0);
  }

  function drawParticles() {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.restore();
  }

  function drawRings() {
    ctx.save();
    ctx.lineWidth = 3;
    for (const r of rings) {
      ctx.globalAlpha = Math.max(0, r.life / r.total);
      ctx.strokeStyle = r.color;
      ctx.beginPath();
      ctx.arc(r.x, r.y, Math.max(1, r.r), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawTexts() {
    ctx.font = 'bold 14px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const t of texts) {
      ctx.globalAlpha = clamp(t.life, 0, 1);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.globalAlpha = 1;
  }

  function drawComboBadge() {
    if (state !== 'playing' || combo.count < 2) return;
    const pulse = 1 + Math.sin(time * 12) * 0.04;
    const color = combo.mult >= 5 ? '#ff7ad9' : combo.mult >= 3 ? '#ffe066' : '#9fe9ff';
    ctx.save();
    ctx.translate(W / 2, 96);
    ctx.scale(pulse, pulse);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 18px Arial';
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    ctx.fillText('COMBO x' + combo.mult, 0, 0);
    ctx.shadowBlur = 0;
    ctx.font = '11px Arial';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(combo.count + ' hits', 0, 18);
    // Combo timer bar
    const frac = clamp(combo.timer / COMBO_WINDOW, 0, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(-50, 28, 100, 3);
    ctx.fillStyle = color;
    ctx.fillRect(-50, 28, 100 * frac, 3);
    ctx.restore();
  }

  // ============================================================
  //  SPAWNING & PROGRESSION
  // ============================================================
  function updateSpawner(dt) {
    if (boss || spawned >= stageGoal) return;
    spawnTimer -= dt;
    if (spawnTimer > 0) return;
    spawnTimer = Math.max(0.3, 1.25 - stage * 0.07) * rand(0.8, 1.2);

    // Occasional scout formation
    if (stage >= 2 && Math.random() < 0.18) {
      const n = Math.min(4, stageGoal - spawned);
      for (let i = 0; i < n; i++) spawnEnemy('scout', W * (i + 1) / (n + 1));
      spawned += n;
      return;
    }

    // Weighted pool: scouts most common, new types unlock with stages
    const pool = ['scout', 'scout'];
    if (stage >= 2) pool.push('weaver');
    if (stage >= 3) pool.push('tank');
    if (stage >= 4) pool.push('kamikaze');
    spawnEnemy(pool[Math.floor(Math.random() * pool.length)]);
    spawned++;
  }

  function checkStageProgress() {
    if (boss || stageDone < stageGoal) return;
    if (stage % 5 === 0) spawnBoss();   // every 5th stage ends in a boss
    else nextStage();
  }

  // ============================================================
  //  COLLISIONS
  // ============================================================
  function handleCollisions() {
    // Player bullets -> enemies
    for (const b of bullets) {
      if (b.dead) continue;
      for (const e of enemies) {
        if (e.dead) continue;
        if (overlaps(b.x, b.y, b.w, b.h, e.x, e.y, e.w, e.h)) {
          b.dead = true;
          e.hp -= b.dmg;
          e.flash = 0.07;
          if (e.hp <= 0) destroyEnemy(e, true);
          else { explode(b.x, b.y, '#ffffff', 3, 80, 2); SFX.hit(); }
          break;
        }
      }
    }

    // Player bullets -> boss
    if (boss) {
      for (const b of bullets) {
        if (b.dead || !boss) continue;
        if (overlaps(b.x, b.y, b.w, b.h, boss.x, boss.y, boss.w, boss.h)) {
          b.dead = true;
          boss.hp -= b.dmg;
          boss.flash = 0.06;
          explode(b.x, b.y, '#ffe066', 3, 80, 2);
          if (boss.hp <= 0) { destroyBoss(); break; }
        }
      }
    }

    // Enemy bullets -> player (with graze bonus)
    for (const b of enemyBullets) {
      if (b.dead) continue;
      const dx = b.x - player.x, dy = b.y - player.y;
      const d2 = dx * dx + dy * dy;
      if (!b.grazed && d2 < 34 * 34 && d2 > 16 * 16) {
        b.grazed = true;
        stats.graze++;
        score += 5;
        if (score > highScore) highScore = score;
        explode(b.x, b.y, '#7ff7ff', 2, 50, 2);
        SFX.graze();
      }
      if (overlaps(b.x, b.y, b.r * 2, b.r * 2, player.x, player.y, player.w * 0.7, player.h * 0.7)) {
        b.dead = true;
        hurtPlayer(10);
      }
    }

    // Enemy ramming the player
    for (const e of enemies) {
      if (!e.dead && overlaps(e.x, e.y, e.w, e.h, player.x, player.y, player.w * 0.8, player.h * 0.8)) {
        destroyEnemy(e, false);
        hurtPlayer(25);
      }
    }

    // Boss body contact
    if (boss && overlaps(boss.x, boss.y, boss.w, boss.h, player.x, player.y, player.w, player.h)) {
      hurtPlayer(20);
    }

    // Power-up pickup
    for (const p of powerups) {
      if (!p.dead && overlaps(p.x, p.y, 28, 28, player.x, player.y, player.w, player.h)) {
        p.dead = true;
        collectPowerup(p);
      }
    }
  }

  function cleanup() {
    bullets = bullets.filter((b) => !b.dead && b.y > -30);
    enemyBullets = enemyBullets.filter((b) => !b.dead && b.y < H + 30 && b.x > -30 && b.x < W + 30);
    enemies = enemies.filter((e) => {
      if (e.dead) return false;
      if (e.y > H + 60) { stageDone++; return false; }   // escaped = handled
      return true;
    });
    powerups = powerups.filter((p) => !p.dead && p.y < H + 30);
  }

  // ============================================================
  //  UPDATE LOOP
  // ============================================================
  function update(dt) {
    updatePlayer(dt);
    player.cool -= dt;
    player.invuln = Math.max(0, player.invuln - dt);
    player.shield = Math.max(0, player.shield - dt);

    if ((input.fire || touch.active) && player.cool <= 0) firePlayer();

    for (const b of bullets) { b.x += b.vx * dt; b.y += b.vy * dt; }
    for (const b of enemyBullets) { b.x += b.vx * dt; b.y += b.vy * dt; }
    for (const e of enemies) updateEnemy(e, dt);
    if (boss) updateBoss(dt);
    if (beam) updateBeam(dt);
    updateSpawner(dt);
    for (const p of powerups) { p.y += p.vy * dt; p.t += dt; }

    // Combo decay
    if (combo.count > 0) {
      combo.timer -= dt;
      if (combo.timer <= 0) resetCombo();
    }

    handleCollisions();
    cleanup();
    updateEffects(dt);

    if (state !== 'playing') return;   // player may have died this frame
    checkStageProgress();

    if (bannerTimer > 0) {
      bannerTimer -= dt;
      if (bannerTimer <= 0) ui.banner.classList.remove('show');
    }
    shake = Math.max(0, shake - dt * 30);
    flash = Math.max(0, flash - dt);
  }

  // ============================================================
  //  HUD (DOM) — only touches DOM when value changes
  // ============================================================
  function setText(el, value) {
    const s = String(value);
    if (el.textContent !== s) el.textContent = s;
  }

  let lastHealthTier = -1;
  function updateHUD() {
    setText(ui.score, score);
    setText(ui.hi, highScore);
    setText(ui.lives, Math.max(0, player.lives));
    setText(ui.stageNum, stage);

    const hp = clamp(player.health, 0, 100);
    ui.health.style.width = hp + '%';
    const tier = hp > 50 ? 0 : hp > 25 ? 1 : 2;
    if (tier !== lastHealthTier) {
      lastHealthTier = tier;
      ui.health.style.background = tier === 0
        ? 'linear-gradient(90deg,#3dff8a,#9bffc4)'
        : tier === 1
          ? 'linear-gradient(90deg,#ffb347,#ffd166)'
          : 'linear-gradient(90deg,#ff5c7a,#ff8fa3)';
    }

    let info = 'LV ' + player.weapon + '   •   BOMBS ' + player.bombs;
    if (player.shield > 0) info += '   •   SHIELD ' + Math.ceil(player.shield) + 's';
    setText(ui.weapon, info);
  }

  // ============================================================
  //  RENDER
  // ============================================================
  function render() {
    ctx.save();
    if (shake > 0) ctx.translate(rand(-shake, shake) * 0.5, rand(-shake, shake) * 0.5);

    ctx.drawImage(bgCanvas, -30, -30, W + 60, H + 60);
    drawStars();
    drawPowerups();
    drawEnemies();
    drawBoss();
    drawBeam();
    drawEnemyBullets();
    drawBullets();
    drawPlayerIfVisible();
    drawRings();
    drawParticles();
    drawTexts();
    drawComboBadge();

    if (flash > 0) {
      ctx.fillStyle = 'rgba(255,255,255,' + (flash * 0.8).toFixed(2) + ')';
      ctx.fillRect(-30, -30, W + 60, H + 60);
    }
    ctx.restore();
  }

  // ============================================================
  //  MAIN LOOP (delta-time based, frame-rate independent)
  // ============================================================
  let last = performance.now();

  function loop(now) {
    const dt = Math.min(0.033, Math.max(0, (now - last) / 1000));
    last = now;
    time += dt;

    updateStars(dt);
    if (state === 'playing') update(dt);
    else if (state === 'over') updateEffects(dt);   // let explosions finish on game over

    updateHUD();
    render();
    requestAnimationFrame(loop);
  }

  // ============================================================
  //  INIT
  // ============================================================
  buildBackground();
  initStars();
  showMenu();
  requestAnimationFrame(loop);
})();
