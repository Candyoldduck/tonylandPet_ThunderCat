import { createMeshAvatarImpl } from '../src/engine/createMeshAvatar.js';

const canvas = document.getElementById('canvas');
const bubbleEl = document.getElementById('bubble');
const menuEl = document.getElementById('menu');
const errorEl = document.getElementById('error');
const chipsEl = document.getElementById('motionChips');

const api = () => window.pywebview?.api;
const pywebviewReady = new Promise(resolve => {
  if (window.pywebview?.api) resolve();
  else window.addEventListener('pywebviewready', () => resolve(), { once: true });
});

const BASE_ASPECT = 490 / 320;
const POLL_MS = 55;

function log(kind, message) {
  try {
    api()?.log(`${kind}: ${message}`);
  } catch {
    /* ignore */
  }
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.add('show');
  document.documentElement.classList.add('ready');
  const ring = document.querySelector('#boot .ring');
  ring?.classList.add('paused');
  log('error', message);
}

function markReady() {
  document.documentElement.classList.add('ready');
}

window.addEventListener('error', event => showError(`${event.message}\n${event.filename}:${event.lineno}`));
window.addEventListener('unhandledrejection', event => showError(`未处理的异常：${event.reason?.message ?? event.reason}`));

const LABELS = {
  nod: '点头', tilt: '歪头', greet: '打招呼', giggle: '偷笑', shy: '害羞', wink: '眨眼',
  think: '思考', surprise: '惊讶', no: '摇头', sway: '摇摆', lookAround: '东张西望',
  glance: '瞟一眼', sigh: '叹气', doze: '犯困', stretch: '伸懒腰', lean: '凑近',
  hum: '哼歌', tap: '敲手指', readNote: '看笔记', waiting: '等你', spaceOut: '发呆', kick: '踢踢腿', stomp: '跺跺脚',
};

const CLICK_LINES = [
  '喵？', '怎么啦？', '摸摸头～', '今天也要打起精神喵！', '嗯？叫我吗？', '嗷呜～',
  '在的在的', '要一起玩吗？', '嘿嘿，被你发现啦', '轻一点摸啦～',
];
const DOUBLE_LINES = ['喵喵！', '别挠啦，好痒！', '嘿嘿～最喜欢你啦', '转转转！'];
const DRAG_LINES = ['哇啊——', '要带我去哪里呀', '飞起来啦～', '慢一点慢一点！'];
const PICK_LINES = ['呀！', '被拎起来啦～', '喵？', '要带我去哪呀'];
const LAND_LINES = ['哎哟！', '落地啦…', '喵！吓我一跳', '下次轻一点嘛'];
const SOFT_LAND_LINES = ['轻轻放下啦', '嗯？到了吗', '站稳了～'];
const BUMP_LINES = ['唔！', '撞到墙了…', '喵呜！'];

const CHIP_MOTIONS = ['nod', 'tilt', 'greet', 'giggle', 'shy', 'wink', 'think', 'surprise', 'kick', 'stomp'];
const SIZE_PRESETS = { small: [240, 368], medium: [320, 490], large: [400, 613] };

const HUB_MOODS = {
  happy: { motion: 'giggle', line: '嘿嘿，开心～' },
  sulky: { motion: 'tilt', line: '哼，不理你了' },
  sleepy: { motion: 'doze', line: '好困…' },
  smug: { motion: 'wink', line: '哼哼，厉害吧' },
};

const state = {
  avatar: null,
  rig: null,
  sleeping: false,
  followOn: true,
  idleOn: true,
  roamOn: true,
  topmost: true,
  dragging: false,
  walking: false,
  flinging: false,
  airborne: false,
  pollBusy: false,
  bubbleTimer: 0,
  clickTimer: 0,
  lastClickAt: 0,
  w: 320,
  h: 490,
  sizeName: 'medium',
  nextRoamAt: 0,
  maskTimer: 0,
  maskCols: 0,
  maskRows: 0,
  maskBusy: false,
  hub: null,
  hubNames: [],
  hubSig: '',
  hubLinked: false,
  hubEverLinked: false,
  nextPresenceBubbleAt: 0,
  packVersion: '',
  petAssetsVersion: '',
  lastAnnounceKey: '',
  lastAnnounceAt: 0,
};

function showBubble(text, ms = 2400) {
  bubbleEl.textContent = text;
  bubbleEl.classList.add('show');
  clearTimeout(state.bubbleTimer);
  state.bubbleTimer = setTimeout(() => bubbleEl.classList.remove('show'), ms);
}

function play(id) {
  if (!state.avatar || !id) return;
  state.avatar.play(id);
}

function applyFollow(on) {
  state.followOn = on;
  if (!on) state.avatar?.setFollow(null);
  syncStates();
}

function applyIdle(on) {
  state.idleOn = on;
  state.avatar?.setAutoIdle(on && !state.sleeping);
  state.avatar?.setAutoMotion(on && !state.sleeping);
  syncStates();
  api()?.save({ follow: state.followOn, idle: state.idleOn });
}

function setSleeping(on) {
  if (!state.avatar || state.sleeping === on) return;
  state.sleeping = on;
  if (on) {
    api()?.stop_roam();
    state.walking = false;
    state.avatar.setWalk(false);
    state.avatar.setFollow(null);
    state.avatar.setAutoIdle(false);
    state.avatar.setAutoMotion(false);
    state.avatar.setParameters({ eyeLOpen: 0, eyeROpen: 0, mouthOpen: 0, eyeSmile: 0, blush: 0 });
    showBubble('呼… 呼… Zzz', 4000);
    closeMenu();
  } else {
    state.avatar.setParameters({});
    state.avatar.setAutoIdle(state.idleOn);
    state.avatar.setAutoMotion(state.idleOn);
    showBubble('喵！醒啦～');
  }
  syncStates();
}

function menuOpen() {
  return menuEl.classList.contains('show');
}

function syncStates() {
  const mark = (key, on, textOn = '开', textOff = '关') => {
    const el = menuEl.querySelector(`[data-state="${key}"]`);
    if (!el) return;
    el.textContent = on ? textOn : textOff;
    el.classList.toggle('on', on);
  };
  mark('follow', state.followOn);
  mark('idle', state.idleOn);
  mark('roam', state.roamOn);
  mark('topmost', state.topmost);
  const sleepBtn = menuEl.querySelector('[data-act="sleep"]');
  if (sleepBtn) sleepBtn.firstChild.textContent = state.sleeping ? '叫醒它' : '去睡觉';
  for (const btn of menuEl.querySelectorAll('[data-size]')) btn.classList.toggle('active', btn.dataset.size === state.sizeName);
}

function hubSpeak(text, ms = 2600, motion) {
  if (state.sleeping) return;
  if (motion) play(motion);
  showBubble(text, ms);
}

function renderHub() {
  const hub = state.hub;
  const row = menuEl.querySelector('[data-act="hub"]');
  if (!row) return;
  const linked = !!hub?.connected;
  const ann = hub?.last_announce;
  const hasAnn = !!(ann && (ann.title || ann.body));
  const sig = `${linked}|${hub?.online ?? 0}|${hub?.in_game ? 1 : 0}|${hasAnn ? `${ann.title}|${ann.body}` : ''}`;
  if (sig === state.hubSig) return;
  state.hubSig = sig;
  row.querySelector('[data-hub="dot"]').classList.toggle('on', linked);
  row.querySelector('[data-hub="text"]').textContent = linked ? 'tonyland 已连接' : '未连接 tonyland';
  row.querySelector('[data-hub="sub"]').textContent = linked
    ? `在线 ${hub.online ?? 0} 人${hub.in_game ? ' · 游戏中' : ''}`
    : '本地待机';
  const annState = menuEl.querySelector('[data-act="announce"] .state');
  if (annState) {
    annState.textContent = hasAnn ? '有' : '无';
    annState.classList.toggle('on', hasAnn);
  }
}

function updateHub(hub) {
  if (!hub) return;
  const wasLinked = state.hubLinked;
  state.hubLinked = !!hub.connected;
  state.hub = hub;
  state.hubNames = Array.isArray(hub.names) ? hub.names.slice() : [];
  if (!state.packVersion && hub.pack_version) state.packVersion = hub.pack_version;
  if (state.hubLinked && !wasLinked && !state.hubEverLinked) {
    state.hubEverLinked = true;
    if (!state.sleeping) showBubble('连上服务器啦～', 1800);
  }
  renderHub();
}

function handleHubEvent(ev) {
  const d = ev?.data ?? {};
  switch (ev?.type) {
    case 'presence': {
      const names = Array.isArray(d.names) ? d.names.map(String) : [];
      const added = names.filter(name => !state.hubNames.includes(name));
      state.hubNames = names;
      if (added.length && performance.now() > state.nextPresenceBubbleAt) {
        state.nextPresenceBubbleAt = performance.now() + 30000;
        const who = added.length === 1 ? `${added[0]} 上线啦` : `${added.length} 人上线了`;
        hubSpeak(`${who}（在线 ${names.length} 人）`, 2600, 'greet');
      }
      break;
    }
    case 'game': {
      const player = d.player || '有人';
      const detail = d.detail ? `（${d.detail}）` : '';
      if (d.kind === 'death') hubSpeak(`${player} 倒下了${detail}… 嘿嘿`, 3200, 'giggle');
      else if (d.kind === 'advancement') hubSpeak(`${player} 拿到成就啦！`, 3000, 'greet');
      else if (d.kind === 'first_diamond') hubSpeak(`${player} 挖到第一颗钻石！`, 4000, 'surprise');
      else if (d.kind === 'disconnect') hubSpeak(`${player} 下线了`, 2600, 'sigh');
      break;
    }
    case 'announce': {
      const title = d.title || '公告';
      const body = d.body || '';
      const key = `${title}|${body}`;
      const now = performance.now();
      if (key === state.lastAnnounceKey && now - state.lastAnnounceAt < 60000) break;
      state.lastAnnounceKey = key;
      state.lastAnnounceAt = now;
      const important = d.level === 'important';
      hubSpeak(body ? `公告：${title}\n${body}` : `公告：${title}`, important ? 8000 : 5200,
        important ? 'surprise' : 'nod');
      break;
    }
    case 'mood': {
      const hit = HUB_MOODS[d.mood];
      if (!hit) break;
      const ttl = Number(d.ttl_ms);
      hubSpeak(hit.line, Math.min(6000, Math.max(1500, ttl || 8000)), hit.motion);
      break;
    }
    case 'config': {
      const pack = d.pack_version ? String(d.pack_version) : '';
      if (pack && state.packVersion && pack !== state.packVersion) {
        hubSpeak(`整合包更新到 ${pack} 啦`, 4200, 'surprise');
      }
      if (pack) state.packVersion = pack;
      const assets = d.pet_assets_version ? String(d.pet_assets_version) : '';
      if (assets && state.petAssetsVersion && assets !== state.petAssetsVersion) {
        hubSpeak(`我的资源包有新版本（${assets}）`, 4200, 'surprise');
      }
      if (assets) state.petAssetsVersion = assets;
      break;
    }
    default:
      break;
  }
}

function buildChips() {
  for (const id of CHIP_MOTIONS) {
    const btn = document.createElement('button');
    btn.textContent = LABELS[id] ?? id;
    btn.addEventListener('click', () => {
      play(id);
      showBubble(LABELS[id] + '～');
    });
    chipsEl.append(btn);
  }
  const random = document.createElement('button');
  random.textContent = '随机';
  random.addEventListener('click', () => {
    const ids = CHIP_MOTIONS.filter(id => id !== 'surprise');
    play(ids[Math.floor(Math.random() * ids.length)]);
    showBubble('喵～');
  });
  chipsEl.append(random);
}

function notifyMenuRect() {
  const bridge = api();
  if (!bridge) return;
  if (!menuOpen()) {
    bridge.set_menu_rect(null);
    return;
  }
  const r = menuEl.getBoundingClientRect();
  bridge.set_menu_rect([r.left, r.top, r.right, r.bottom]);
}

function openMenu(x, y) {
  menuEl.classList.add('show');
  const pad = 6;
  const rect = menuEl.getBoundingClientRect();
  const left = Math.max(pad, Math.min(x, innerWidth - rect.width - pad));
  const top = Math.max(pad, Math.min(y, innerHeight - rect.height - pad));
  menuEl.style.left = `${left}px`;
  menuEl.style.top = `${top}px`;
  notifyMenuRect();
}

function closeMenu() {
  if (!menuOpen()) return;
  menuEl.classList.remove('show');
  notifyMenuRect();
}

function synthClick(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return;
  el.dispatchEvent(new MouseEvent('click', {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0,
  }));
}

function zoomBy(delta) {
  if (!delta || !state.w || state.sleeping) return;
  const factor = Math.min(1.22, Math.max(0.82, Math.pow(1.0014, delta)));
  let w = Math.round(state.w * factor);
  w = Math.max(200, Math.min(460, w));
  if (Math.abs(w - state.w) < 2) return;
  const h = Math.round(w * BASE_ASPECT);
  state.w = w;
  state.h = h;
  state.sizeName = null;
  closeMenu();
  api()?.set_size(w, h);
  syncStates();
}

function nearestSizeName(w) {
  for (const [key, [pw]] of Object.entries(SIZE_PRESETS)) {
    if (Math.abs(w - pw) < 14) return key;
  }
  return null;
}

function handleNative(ev) {
  if (!ev) return;
  switch (ev.type) {
    case 'down':
      if (!ev.menu) closeMenu();
      break;
    case 'click':
      if (ev.menu) synthClick(ev.x, ev.y);
      else {
        closeMenu();
        handleClick();
      }
      break;
    case 'rclick':
      if (menuOpen()) closeMenu();
      else openMenu(ev.x, ev.y);
      break;
    case 'wheel':
      if (ev.menu) menuEl.scrollTop -= ev.delta * 0.5;
      else zoomBy(ev.delta);
      break;
    case 'dragend':
      closeMenu();
      api()?.save({});
      if (Math.random() < 0.55) showBubble(DRAG_LINES[Math.floor(Math.random() * DRAG_LINES.length)], 1600);
      break;
    case 'land': {
      // the shell's floor contact: the engine owns the crouch and the spring back, this only
      // adds the yelp - and a quiet place-down gets a much smaller one than a drop
      const v = ev.v ?? 0;
      state.avatar?.land(v);
      if (!state.sleeping && v > 0.5 && Math.random() < 0.6) {
        showBubble(LAND_LINES[Math.floor(Math.random() * LAND_LINES.length)], 1500);
      } else if (!state.sleeping && v > 0.16 && Math.random() < 0.22) {
        showBubble(SOFT_LAND_LINES[Math.floor(Math.random() * SOFT_LAND_LINES.length)], 1200);
      }
      break;
    }
    case 'bump':
      // off a screen edge: it is shoved sideways and has to keep its balance
      state.avatar?.bump(ev.v ?? 0, ev.dir ?? 0);
      if (!state.sleeping && (ev.v ?? 0) > 0.3 && Math.random() < 0.45) {
        showBubble(BUMP_LINES[Math.floor(Math.random() * BUMP_LINES.length)], 1200);
      }
      break;
    case 'closemenu':
      closeMenu();
      break;
    default:
      break;
  }
}

function applyFollowCursor(cursor) {
  if (!state.avatar || !cursor || !state.followOn || state.sleeping || state.walking
    || state.dragging || state.flinging) return;
  const nx = (cursor.x - innerWidth / 2) / (innerWidth * 0.72);
  const ny = (cursor.y - innerHeight * 0.38) / (innerHeight * 0.8);
  state.avatar.setFollow(nx, ny, 0.92);
}

async function pollLoop() {
  if (state.pollBusy) return;
  const bridge = api();
  if (!bridge) return;
  state.pollBusy = true;
  try {
    const res = await bridge.poll();
    if (!res) return;
    applyFollowCursor(res.cursor);
    for (const ev of res.events ?? []) handleNative(ev);
    for (const ev of res.hub_events ?? []) handleHubEvent(ev);
    updateHub(res.hub);
    if (!!res.walking !== state.walking) {
      state.walking = !!res.walking;
      state.avatar?.setWalk(state.walking && !state.sleeping);
    }
    const wasDragging = state.dragging;
    state.dragging = !!res.dragging;
    // while carried, the drag lean owns the pose; cursor-follow resumes after the drop
    if (state.dragging && !wasDragging) {
      state.avatar?.setFollow(null);
      if (!state.sleeping && Math.random() < 0.45) showBubble(PICK_LINES[Math.floor(Math.random() * PICK_LINES.length)], 1400);
    }
    const vel = res.drag_vel;
    state.avatar?.setDrag(state.dragging, vel?.[0] ?? 0, vel?.[1] ?? 0);
    // after a setDrag that started the hold: catching it mid-air is a softer version of the
    // same grab beat, so the lift does not double up
    if (state.dragging && !wasDragging) state.avatar?.pickUp(state.airborne ? 0.6 : 1);
    // let go and the window keeps moving on its own: fall, slide, bounce
    state.flinging = !!res.flinging;
    state.airborne = !!res.airborne;
    const fly = res.flight;
    state.avatar?.setFlight(state.flinging, state.airborne, fly?.[0] ?? 0, fly?.[1] ?? 0);
  } catch {
    /* bridge busy; next tick retries */
  } finally {
    state.pollBusy = false;
  }
}

async function maybeRoam() {
  if (!state.avatar || state.sleeping || !state.roamOn || state.walking || state.dragging
    || state.flinging || state.airborne) return;
  if (menuOpen()) return;
  if (performance.now() < state.nextRoamAt) return;
  state.nextRoamAt = performance.now() + 15000 + Math.random() * 17000;
  // pinned against a screen edge: the shell has nowhere to go, try again soon
  const started = await api()?.roam();
  if (!started) state.nextRoamAt = performance.now() + 4000;
}

async function buildHitMask(rig) {
  const bridge = api();
  if (!bridge || !rig || state.maskBusy) return;
  const img = rig.image;
  const view = rig.view ?? {};
  const padTop = view.padTop ?? 0;
  const padSide = view.padSide ?? 0;
  const cssW = innerWidth;
  const cssH = innerHeight;
  const cols = 96;
  const rows = Math.max(24, Math.round(cols * cssH / cssW));
  if (cols === state.maskCols && rows === state.maskRows) return;
  state.maskBusy = true;
  try {
    // same fit as the renderer: bottom-anchored, with view padding
    const s = Math.min(cssW / (img.width * (1 + 2 * padSide)), cssH / (img.height * (1 + padTop)));
    const ox = (cssW - img.width * s) / 2;
    const oy = cssH - img.height * s;
    const load = src => new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = src;
    });
    // the limbs move, so the mask is drawn with all of them: a raised hand must still be
    // something you can grab
    const limbDefs = [...(rig.legs ?? []), ...(rig.arms ?? []), ...(rig.sleeves ?? [])];
    // the limb loads must be spread into Promise.all: nested in an array they resolve as plain
    // arrays of pending promises, and drawImage then gets a Promise instead of an image
    const [base, ...limbs] = await Promise.all([
      load('./projects/leitingmiao/built/base.png'),
      ...limbDefs.map(leg => load(`./projects/leitingmiao/built/${leg.name}.png`)),
    ]);
    const off = document.createElement('canvas');
    off.width = cols;
    off.height = rows;
    const g = off.getContext('2d', { willReadFrequently: true });
    const place = (image, x, y, w, h) => g.drawImage(image, x, y, w, h,
      ox * cols / cssW, oy * rows / cssH,
      w * s * cols / cssW, h * s * rows / cssH);
    place(base, 0, 0, img.width, img.height);
    limbDefs.forEach((leg, i) => {
      const [rx, ry, rw, rh] = leg.rect;
      place(limbs[i], rx, ry, rw, rh);
    });
    const data = g.getImageData(0, 0, cols, rows).data;
    const src = new Uint8Array(cols * rows);
    for (let i = 0; i < src.length; i++) src[i] = data[i * 4 + 3] > 12 ? 1 : 0;
    // grow 2 cells so the outline and the animated sway stay clickable
    const bits = new Uint8Array(cols * rows);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (!src[y * cols + x]) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy >= 0 && yy < rows && xx >= 0 && xx < cols) bits[yy * cols + xx] = 1;
          }
        }
      }
    }
    await bridge.set_mask(cols, rows, Array.from(bits).join(''));
    state.maskCols = cols;
    state.maskRows = rows;
    log('info', `hit mask ${cols}x${rows}`);
  } finally {
    state.maskBusy = false;
  }
}

function bindMenu() {
  menuEl.addEventListener('click', async event => {
    const sizeBtn = event.target.closest('[data-size]');
    if (sizeBtn) {
      const [w, h] = SIZE_PRESETS[sizeBtn.dataset.size] ?? SIZE_PRESETS.medium;
      state.sizeName = sizeBtn.dataset.size;
      state.w = w;
      state.h = h;
      await api()?.set_size(w, h);
      closeMenu();
      syncStates();
      return;
    }
    const btn = event.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'follow') {
      applyFollow(!state.followOn);
      api()?.save({ follow: state.followOn, idle: state.idleOn, roam: state.roamOn });
    } else if (act === 'idle') {
      applyIdle(!state.idleOn);
    } else if (act === 'roam') {
      state.roamOn = !state.roamOn;
      if (!state.roamOn) api()?.stop_roam();
      api()?.save({ follow: state.followOn, idle: state.idleOn, roam: state.roamOn });
      syncStates();
    } else if (act === 'topmost') {
      state.topmost = !state.topmost;
      await api()?.set_topmost(state.topmost);
      syncStates();
    } else if (act === 'hub') {
      const hub = state.hub;
      if (hub?.connected) {
        const names = hub.names ?? [];
        showBubble(names.length ? `在线（${hub.online}）：${names.join('、')}` : `在线 ${hub.online} 人`, 4200);
      } else {
        showBubble('启动器没开，我自己待机～', 2400);
      }
    } else if (act === 'announce') {
      const ann = state.hub?.last_announce;
      if (ann?.title || ann?.body) {
        if (!state.sleeping) play('nod');
        showBubble(`公告：${ann.title ?? ''}${ann.body ? `\n${ann.body}` : ''}`, 8000);
      } else {
        showBubble('暂时没有公告', 2200);
      }
    } else if (act === 'sleep') {
      setSleeping(!state.sleeping);
    } else if (act === 'reset') {
      await api()?.reset_position();
      showBubble('回到老位置啦');
    } else if (act === 'quit') {
      await api()?.save({ follow: state.followOn, idle: state.idleOn, roam: state.roamOn });
      api()?.quit();
      return;
    }
    if (act !== 'sleep') closeMenu();
  });
}

function handleClick() {
  if (state.sleeping) {
    setSleeping(false);
    return;
  }
  const now = performance.now();
  if (now - state.lastClickAt < 300) {
    clearTimeout(state.clickTimer);
    state.lastClickAt = 0;
    showBubble(DOUBLE_LINES[Math.floor(Math.random() * DOUBLE_LINES.length)]);
    play(Math.random() < 0.5 ? 'giggle' : 'surprise');
    return;
  }
  state.lastClickAt = now;
  clearTimeout(state.clickTimer);
  state.clickTimer = setTimeout(() => {
    showBubble(CLICK_LINES[Math.floor(Math.random() * CLICK_LINES.length)]);
    const pool = ['nod', 'tilt', 'giggle', 'wink', 'shy', 'greet'];
    play(pool[Math.floor(Math.random() * pool.length)]);
  }, 280);
}

async function main() {
  buildChips();
  bindMenu();

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => buildHitMask(state.rig), 350);
  });

  let response;
  try {
    response = await fetch('./projects/leitingmiao/rig.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`rig.json 加载失败（${response.status}）`);
  } catch (error) {
    showError(`模型数据加载失败：${error?.message ?? error}`);
    await pywebviewReady;
    await api()?.ready({ w: innerWidth, h: innerHeight });
    markReady();
    return;
  }

  const rig = await response.json();
  state.rig = rig;
  const avatar = await createMeshAvatarImpl(canvas, {
    rig,
    assetsBase: './projects/leitingmiao/built/',
  });
  avatar.setAutoIdle(true);
  avatar.setAutoMotion(true);
  state.avatar = avatar;
  state.w = innerWidth;
  state.h = innerHeight;
  state.sizeName = 'medium';

  await pywebviewReady;
  const saved = await api()?.ready({ w: innerWidth, h: innerHeight });
  if (saved) {
    state.followOn = saved.follow !== false;
    state.idleOn = saved.idle !== false;
    state.roamOn = saved.roam !== false;
    state.topmost = saved.topmost !== false;
    state.w = saved.w ?? innerWidth;
    state.h = saved.h ?? innerHeight;
    state.sizeName = nearestSizeName(state.w) ?? 'medium';
    if (!state.idleOn) {
      avatar.setAutoIdle(false);
      avatar.setAutoMotion(false);
    }
  }
  markReady();
  syncStates();
  setTimeout(() => buildHitMask(rig), 300);
  setInterval(pollLoop, POLL_MS);
  setInterval(maybeRoam, 3000);
  state.nextRoamAt = performance.now() + 9000;
  log('info', 'ready');
  setTimeout(() => {
    if (!state.sleeping) showBubble('喵～我在这里！', 2200);
  }, 600);
}

main().catch(error => showError(`桌宠启动失败：${error?.message ?? error}`));
