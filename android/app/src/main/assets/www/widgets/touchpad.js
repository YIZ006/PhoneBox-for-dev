import { API, PANEL_HEADERS, bridge, h, haptic, toast } from '../main.js';
import { W } from '../registry.js';

// ---------------------------------------------------------------- touchpad
// Zero-lag 60-120 Hz multi-touch trackpad over USB, Wi-Fi LAN or Tailscale.
// On Android, streams directly through MouseLink's persistent TCP_NODELAY WebSocket
// (bridge.mouseMove / bridge.mouseCmd) with zero per-packet HTTP round-trip waits.
// Falls back to HTTP POST only in desktop browser preview.

const SENS_STEPS = [1.0, 1.6, 2.4, 3.2];

function postMouseHttp(params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  return fetch(`${API}/mouse?${qs.toString()}`, {
    method: 'POST',
    cache: 'no-store',
    headers: PANEL_HEADERS,
  });
}

function sendAction(op, arg) {
  if (bridge?.mouseCmd) {
    const code = op === 'click' ? 'c' : op === 'dblclick' ? '2' : op === 'down' ? 'd' : op === 'up' ? 'u' : op === 'key' ? 'k' : op === 'text' ? 't' : '';
    if (code) {
      bridge.mouseCmd(`${code},${arg ?? ''}`);
      return;
    }
  }
  const params = op === 'key' ? { op, key: arg } : op === 'text' ? { op, text: arg } : { op, btn: arg || 'left' };
  postMouseHttp(params).catch(() => toast('PC no answer', 'err'));
}

W.touchpad = {
  needs: [],
  create(box, { o }) {
    box.classList.add('tp');
    const storageKey = 'pb-tp-sens';
    let sens = Number(localStorage.getItem(storageKey)) || Number(o.sensitivity) || 1.6;
    const scrollScale = (Number(o.scrollSpeed) || 1.0) * 6;
    const natural = o.naturalScroll !== false;

    const head = h('div', 'tp-head');
    const title = h('span', 'tp-title', 'TOUCHPAD');
    const hint = h('span', 'tp-hint', '1f move/tap · 2f scroll/right');
    const sensBtn = h('button', 'tp-pill', `${sens.toFixed(1)}×`);
    sensBtn.type = 'button';
    const kbBtn = h('button', 'tp-pill', '⌨');
    kbBtn.type = 'button';
    head.append(title, hint, sensBtn, kbBtn);

    const pad = h('div', 'tp-pad');
    const glow = h('div', 'tp-glow');
    const badge = h('div', 'tp-badge');
    pad.append(glow, badge);

    // Optional inline quick-typing bar
    const kbBar = h('div', 'tp-kb');
    kbBar.hidden = true;
    const kbInput = h('input', 'tp-input');
    kbInput.type = 'text';
    kbInput.placeholder = 'Type text to PC…';
    kbInput.autocomplete = 'off';
    const kbSend = h('button', 'tp-kbtn primary', 'Send');
    kbSend.type = 'button';
    const quickKeys = [
      ['↵', 'enter'],
      ['⌫', 'backspace'],
      ['Esc', 'esc'],
      ['Alt+Tab', 'alt+tab'],
    ].map(([label, spec]) => {
      const b = h('button', 'tp-kbtn', label);
      b.type = 'button';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        haptic();
        sendAction('key', spec);
      });
      return b;
    });
    kbBar.append(kbInput, kbSend, ...quickKeys);

    // Bottom physical-style mouse buttons
    const bar = h('div', 'tp-bar');
    const btnL = h('button', 'tp-btn', 'Left');
    const btnDrag = h('button', 'tp-btn tp-drag', 'Drag');
    const btnMid = h('button', 'tp-btn tp-mid', 'Mid');
    const btnR = h('button', 'tp-btn', 'Right');
    for (const b of [btnL, btnDrag, btnMid, btnR]) b.type = 'button';
    bar.append(btnL, btnDrag, btnMid, btnR);
    if (o.showButtons === false) bar.hidden = true;

    box.append(head, kbBar, pad, bar);

    let alive = true;
    let dragLocked = false;
    let pendingDx = 0, pendingDy = 0, moving = false;
    let pendingSx = 0, pendingSy = 0, scrolling = false;
    let remX = 0, remY = 0, remSx = 0, remSy = 0;
    let badgeTimer = null;

    const showBadge = (text) => {
      badge.textContent = text;
      badge.classList.add('on');
      clearTimeout(badgeTimer);
      badgeTimer = setTimeout(() => badge.classList.remove('on'), 750);
    };

    const setDragLock = (on) => {
      if (dragLocked === on) return;
      dragLocked = on;
      btnDrag.classList.toggle('on', dragLocked);
      pad.classList.toggle('dragging', dragLocked);
      sendAction(dragLocked ? 'down' : 'up', 'left');
      showBadge(dragLocked ? 'DRAG LOCKED' : 'RELEASED');
    };

    const flushMoveHttp = () => {
      if (!alive || moving) return;
      const dx = Math.trunc(pendingDx);
      const dy = Math.trunc(pendingDy);
      if (!dx && !dy) return;
      pendingDx -= dx;
      pendingDy -= dy;
      moving = true;
      postMouseHttp({ op: 'move', dx, dy })
        .catch(() => {})
        .finally(() => {
          moving = false;
          if (alive && (Math.trunc(pendingDx) || Math.trunc(pendingDy))) flushMoveHttp();
        });
    };

    const flushScrollHttp = () => {
      if (!alive || scrolling) return;
      const dy = Math.trunc(pendingSy);
      const dx = Math.trunc(pendingSx);
      if (!dy && !dx) return;
      pendingSy -= dy;
      pendingSx -= dx;
      scrolling = true;
      postMouseHttp({ op: 'scroll', dy, dx })
        .catch(() => {})
        .finally(() => {
          scrolling = false;
          if (alive && (Math.trunc(pendingSy) || Math.trunc(pendingSx))) flushScrollHttp();
        });
    };

    const emitMove = (ix, iy) => {
      if (!ix && !iy) return;
      if (bridge?.mouseMove) {
        bridge.mouseMove(ix, iy);
      } else {
        pendingDx += ix;
        pendingDy += iy;
        flushMoveHttp();
      }
    };

    const emitScroll = (sy, sx) => {
      if (!sy && !sx) return;
      if (bridge?.mouseCmd) {
        bridge.mouseCmd(`s,${sy},${sx}`);
      } else {
        pendingSy += sy;
        pendingSx += sx;
        flushScrollHttp();
      }
    };

    sensBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      haptic();
      const idx = SENS_STEPS.findIndex((v) => Math.abs(v - sens) < 0.05);
      sens = SENS_STEPS[(idx + 1) % SENS_STEPS.length];
      try { localStorage.setItem(storageKey, String(sens)); } catch (_) {}
      sensBtn.textContent = `${sens.toFixed(1)}×`;
      showBadge(`Speed ${sens.toFixed(1)}×`);
    });

    kbBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      haptic();
      kbBar.hidden = !kbBar.hidden;
      kbBtn.classList.toggle('on', !kbBar.hidden);
      if (!kbBar.hidden) kbInput.focus();
    });

    const sendTyped = () => {
      const val = kbInput.value;
      if (!val) return;
      haptic();
      kbInput.value = '';
      sendAction('text', val);
    };
    kbSend.addEventListener('click', (e) => { e.stopPropagation(); sendTyped(); });
    kbInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); sendTyped(); }
    });

    btnL.addEventListener('click', (e) => {
      e.stopPropagation();
      haptic();
      if (dragLocked) { setDragLock(false); return; }
      sendAction('click', 'left');
      showBadge('LEFT CLICK');
    });
    btnDrag.addEventListener('click', (e) => {
      e.stopPropagation();
      haptic();
      setDragLock(!dragLocked);
    });
    btnMid.addEventListener('click', (e) => {
      e.stopPropagation();
      haptic();
      sendAction('click', 'middle');
      showBadge('MIDDLE CLICK');
    });
    btnR.addEventListener('click', (e) => {
      e.stopPropagation();
      haptic();
      sendAction('click', 'right');
      showBadge('RIGHT CLICK');
    });

    // Touch gesture tracking (prevents #pager horizontal swipe inside .tp-pad)
    let touchActive = false;
    let startTime = 0;
    let maxFingers = 0;
    let totalDist = 0;
    let lastX = 0, lastY = 0;
    let lastMidX = 0, lastMidY = 0;
    let lastMoveTime = 0;

    const placeGlow = (clientX, clientY) => {
      const r = pad.getBoundingClientRect();
      glow.style.transform = `translate(${clientX - r.left}px, ${clientY - r.top}px)`;
      glow.classList.add('on');
    };

    const stopEvt = (e) => {
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
    };

    pad.addEventListener('touchstart', (e) => {
      stopEvt(e);
      const count = e.touches.length;
      if (!touchActive) {
        touchActive = true;
        startTime = performance.now();
        maxFingers = count;
        totalDist = 0;
        remX = 0; remY = 0; remSx = 0; remSy = 0;
      } else {
        maxFingers = Math.max(maxFingers, count);
      }
      if (count === 1) {
        const t = e.touches[0];
        lastX = t.clientX;
        lastY = t.clientY;
        lastMoveTime = performance.now();
        placeGlow(t.clientX, t.clientY);
      } else if (count >= 2) {
        const t0 = e.touches[0], t1 = e.touches[1];
        lastMidX = (t0.clientX + t1.clientX) / 2;
        lastMidY = (t0.clientY + t1.clientY) / 2;
        placeGlow(lastMidX, lastMidY);
      }
    }, { passive: false });

    pad.addEventListener('touchmove', (e) => {
      stopEvt(e);
      if (!touchActive) return;
      const count = e.touches.length;
      maxFingers = Math.max(maxFingers, count);

      if (count === 1 && maxFingers === 1) {
        const t = e.touches[0];
        const rawDx = t.clientX - lastX;
        const rawDy = t.clientY - lastY;
        lastX = t.clientX;
        lastY = t.clientY;
        placeGlow(t.clientX, t.clientY);

        const now = performance.now();
        const dt = Math.max(4, now - lastMoveTime);
        lastMoveTime = now;
        const step = Math.hypot(rawDx, rawDy);
        totalDist += step;

        // Smooth velocity acceleration curve for precision + fast flicks
        const vel = step / dt;
        const accel = 1 + Math.min(vel * 1.15, 1.8);
        remX += rawDx * sens * accel;
        remY += rawDy * sens * accel;
        const ix = Math.trunc(remX);
        const iy = Math.trunc(remY);
        if (ix || iy) {
          remX -= ix;
          remY -= iy;
          emitMove(ix, iy);
        }
      } else if (count >= 2) {
        const t0 = e.touches[0], t1 = e.touches[1];
        const mx = (t0.clientX + t1.clientX) / 2;
        const my = (t0.clientY + t1.clientY) / 2;
        const rawDx = mx - lastMidX;
        const rawDy = my - lastMidY;
        lastMidX = mx;
        lastMidY = my;
        placeGlow(mx, my);
        totalDist += Math.hypot(rawDx, rawDy);

        const dir = natural ? 1 : -1;
        remSy += rawDy * scrollScale * dir;
        remSx += -rawDx * scrollScale * dir;
        const sy = Math.trunc(remSy);
        const sx = Math.trunc(remSx);
        if (Math.abs(sy) >= 20 || Math.abs(sx) >= 20) {
          remSy -= sy;
          remSx -= sx;
          emitScroll(sy, sx);
        }
      }
    }, { passive: false });

    const finishTouch = (e) => {
      stopEvt(e);
      if (e.touches.length > 0) {
        if (e.touches.length === 1) {
          lastX = e.touches[0].clientX;
          lastY = e.touches[0].clientY;
        }
        return;
      }
      glow.classList.remove('on');
      if (!touchActive) return;
      touchActive = false;
      const elapsed = performance.now() - startTime;
      if (elapsed < 260 && totalDist < 12) {
        haptic();
        if (maxFingers === 1) {
          if (dragLocked) {
            setDragLock(false);
          } else {
            sendAction('click', 'left');
            showBadge('CLICK');
          }
        } else if (maxFingers >= 2) {
          sendAction('click', 'right');
          showBadge('RIGHT CLICK');
        }
      }
    };

    pad.addEventListener('touchend', finishTouch, { passive: false });
    pad.addEventListener('touchcancel', finishTouch, { passive: false });

    // Desktop mouse fallback for live preview testing in Settings
    let mouseDown = false, mStart = 0, mDist = 0, mLastX = 0, mLastY = 0;
    pad.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      mouseDown = true; mStart = performance.now(); mDist = 0;
      mLastX = e.clientX; mLastY = e.clientY;
      placeGlow(e.clientX, e.clientY);
    });
    const onWinMove = (e) => {
      if (!mouseDown) return;
      const dx = e.clientX - mLastX, dy = e.clientY - mLastY;
      mLastX = e.clientX; mLastY = e.clientY;
      mDist += Math.hypot(dx, dy);
      placeGlow(e.clientX, e.clientY);
      emitMove(Math.round(dx * sens), Math.round(dy * sens));
    };
    const onWinUp = () => {
      if (!mouseDown) return;
      mouseDown = false;
      glow.classList.remove('on');
      if (performance.now() - mStart < 220 && mDist < 8) {
        sendAction('click', 'left');
        showBadge('CLICK');
      }
    };
    window.addEventListener('mousemove', onWinMove);
    window.addEventListener('mouseup', onWinUp);

    return {
      update() {},
      destroy() {
        alive = false;
        clearTimeout(badgeTimer);
        if (dragLocked) sendAction('up', 'left');
        window.removeEventListener('mousemove', onWinMove);
        window.removeEventListener('mouseup', onWinUp);
      },
    };
  },
};
