import { API, D, PANEL_HEADERS, bridge, h, haptic, toast } from '../main.js';
import { W } from '../registry.js';

// ---------------------------------------------------------------- phone-mic
// Turns the Android phone into a live 48 kHz mono PC microphone over USB, Wi-Fi or Tailscale.
// Routes into a Windows Virtual Audio Cable ("CABLE Input") so Discord, Zoom, OBS and games
// see the phone as a standard system microphone ("CABLE Output").

const PM_SVG = {
  mic: '<path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/>',
  micOff: '<line x1="2" y1="2" x2="22" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-1"/><path d="M5 10v1a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v2a3 3 0 0 0 5.12 2.12"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/>',
  speaker: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
  pin: '<rect x="3" y="3" width="18" height="18" rx="4"/><rect x="10" y="10" width="9" height="7" rx="2" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
};

function pmSvg(name, cls = 'pm-ico') {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PM_SVG[name] || ''}</svg>`;
  return tpl.content.firstElementChild;
}

function setBtnContent(el, svgName, text) {
  el.replaceChildren(pmSvg(svgName), h('span', null, text));
}

const listeners = new Set();
window.onPhoneMicState = (st) => {
  try { window.dispatchEvent(new CustomEvent('phonebox:micstate', { detail: st })); } catch (_) {}
  for (const fn of listeners) {
    try { fn(st); } catch (_) {}
  }
};

async function fetchMicStatus() {
  const r = await fetch(`${API}/mic/status`, { cache: 'no-store', headers: PANEL_HEADERS });
  return r.ok ? await r.json() : null;
}

async function postMicConfig(params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) qs.set(k, String(v));
  }
  const r = await fetch(`${API}/mic/config?${qs.toString()}`, {
    method: 'POST',
    cache: 'no-store',
    headers: PANEL_HEADERS,
  });
  return r.ok ? await r.json() : null;
}

W['phone-mic'] = {
  needs: ['tick', 'push'],
  create(box) {
    box.classList.add('pm');

    const head = h('div', 'pm-head');
    const title = h('span', 'pm-title', 'PHONE MIC');
    const headRight = h('div', 'pm-head-right');
    const ovBtn = h('button', 'pm-ov-btn');
    ovBtn.type = 'button';
    ovBtn.title = 'Hiện nút nổi Mic & Mouse ngoài app';
    setBtnContent(ovBtn, 'pin', 'Nổi');
    const statusPill = h('span', 'pm-status', 'OFF');
    headRight.append(ovBtn, statusPill);
    head.append(title, headRight);

    const body = h('div', 'pm-body');

    // Left: big mic power + 2x2 chips
    const left = h('div', 'pm-left');
    const powerBtn = h('button', 'pm-power', pmSvg('mic', 'pm-power-ico'));
    powerBtn.type = 'button';
    const powerLabel = h('div', 'pm-plabel', 'Tap to start');
    const subRow = h('div', 'pm-subrow');
    const muteBtn = h('button', 'pm-chip', 'Mute');
    const modeBtn = h('button', 'pm-chip on', 'Noise Cancel');
    const spkBtn = h('button', 'pm-chip spk');
    setBtnContent(spkBtn, 'speaker', 'Loa PC');
    const agVoiceBtn = h('button', 'pm-chip ag-voice');
    setBtnContent(agVoiceBtn, 'sparkles', 'Voice AG');
    muteBtn.type = 'button';
    modeBtn.type = 'button';
    spkBtn.type = 'button';
    agVoiceBtn.type = 'button';
    subRow.append(muteBtn, modeBtn, spkBtn, agVoiceBtn);
    left.append(powerBtn, powerLabel, subRow);

    // Right: VU meter + output device selector + gain slider + tip
    const right = h('div', 'pm-right');

    const meterWrap = h('div', 'pm-meter-wrap');
    const meterLabel = h('div', 'pm-row-label', h('span', null, 'Input level'), h('b', 'pm-lvl-val', '0%'));
    const meter = h('div', 'pm-meter');
    const meterFill = h('div', 'pm-meter-fill');
    meter.append(meterFill);
    meterWrap.append(meterLabel, meter);

    const devWrap = h('div', 'pm-field');
    const devLabel = h('label', 'pm-row-label', h('span', null, 'PC Output Device'));
    const devSelect = h('select', 'pm-select');
    devWrap.append(devLabel, devSelect);

    const gainWrap = h('div', 'pm-field');
    const gainVal = h('b', null, '100%');
    const gainLabel = h('div', 'pm-row-label', h('span', null, 'Mic Gain'), gainVal);
    const gainInput = h('input', 'pm-range');
    gainInput.type = 'range';
    gainInput.min = '50';
    gainInput.max = '250';
    gainInput.step = '5';
    gainInput.value = '100';
    gainWrap.append(gainLabel, gainInput);

    const tip = h('div', 'pm-tip', '48 kHz PCM · USB / Wi-Fi / Tailscale');
    right.append(meterWrap, devWrap, gainWrap, tip);

    body.append(left, right);
    box.append(head, body);

    let alive = true;
    let voiceMode = true;
    let phoneState = { running: false, muted: false, voiceMode: true, level: 0, error: '', speakerOn: false, speakerLive: false, speakerError: '', overlayPinned: false, canOverlay: false };
    let pcState = null;
    let lastPoll = 0;
    let devSig = '';

    const readPhoneState = () => {
      if (!bridge?.micState) return;
      try { phoneState = JSON.parse(bridge.micState()) || phoneState; } catch (_) {}
    };

    const render = () => {
      const on = !!phoneState.running;
      const muted = !!phoneState.muted;
      const spkOn = !!phoneState.speakerOn;
      const spkLive = !!phoneState.speakerLive;
      const pinned = !!phoneState.overlayPinned;

      powerBtn.classList.toggle('live', on && !muted);
      powerBtn.classList.toggle('muted', on && muted);
      powerBtn.replaceChildren(pmSvg(on && muted ? 'micOff' : 'mic', 'pm-power-ico'));
      powerLabel.textContent = on ? (muted ? 'MUTED' : 'LIVE · 48 kHz') : 'Tap to start';
      statusPill.textContent = on && spkOn ? '2-WAY' : on ? (muted ? 'MUTED' : 'LIVE') : spkOn ? 'SPEAKER' : 'OFF';
      statusPill.classList.toggle('live', (on && !muted) || spkLive);
      statusPill.classList.toggle('muted', on && muted && !spkLive);

      ovBtn.hidden = !bridge?.overlaySet;
      ovBtn.classList.toggle('on', pinned);
      setBtnContent(ovBtn, 'pin', pinned ? 'Đang nổi' : 'Nổi');

      muteBtn.disabled = !on;
      muteBtn.classList.toggle('on', on && muted);
      muteBtn.textContent = muted ? 'Unmute' : 'Mute';

      modeBtn.classList.toggle('on', voiceMode);
      modeBtn.textContent = voiceMode ? 'Noise Cancel' : 'Raw Mic';

      spkBtn.classList.toggle('on', spkOn);
      spkBtn.classList.toggle('live', spkLive);
      setBtnContent(spkBtn, 'speaker', spkOn ? (spkLive ? 'Loa: LIVE' : 'Đang nối…') : 'Loa PC');

      const agPush = D.push?.ag_chat;
      const agActive = !!(agPush?.voiceActive ?? agPush?.data?.voiceActive);
      agVoiceBtn.classList.toggle('on', agActive);
      setBtnContent(agVoiceBtn, 'sparkles', agActive ? 'Voice ON' : 'Voice AG');

      const lvl = on && !muted ? Math.max(0, Math.min(100, phoneState.level || pcState?.level || 0)) : 0;
      meterFill.style.width = `${lvl}%`;
      meterLabel.querySelector('.pm-lvl-val').textContent = `${lvl}%`;

      const err = phoneState.error || phoneState.speakerError;
      if (err) {
        tip.textContent = `⚠ ${err}`;
        tip.classList.add('warn');
      } else if (pcState && !pcState.hasVirtualCable) {
        tip.textContent = 'Tip: Install free VB-Cable on PC → pick "CABLE Input" here & "CABLE Output" as mic in Discord/Windows.';
        tip.classList.remove('warn');
      } else if (pcState?.deviceName) {
        tip.textContent = spkLive ? `2 chiều · Mic → ${pcState.deviceName} · Loa PC → ĐT` : `Routing to: ${pcState.deviceName}`;
        tip.classList.remove('warn');
      }
    };

    const syncDevices = (st) => {
      pcState = st;
      if (!st) return;
      const devs = st.devices || [];
      const sig = JSON.stringify([devs, st.deviceId]);
      if (sig !== devSig) {
        devSig = sig;
        devSelect.replaceChildren(...devs.map((d) => {
          const opt = h('option', null, (d.isVirtual ? '★ ' : '') + d.name);
          opt.value = d.id;
          if (d.id === st.deviceId) opt.selected = true;
          return opt;
        }));
      }
      if (typeof st.gain === 'number') {
        const pct = Math.round(st.gain * 100);
        if (document.activeElement !== gainInput) gainInput.value = String(pct);
        gainVal.textContent = `${pct}%`;
      }
      render();
    };

    const pollPc = async () => {
      lastPoll = Date.now();
      try {
        const st = await fetchMicStatus();
        if (alive && st) syncDevices(st);
      } catch (_) {}
    };

    const onPhoneUpdate = (st) => {
      if (!alive || !st) return;
      phoneState = st;
      if (typeof st.voiceMode === 'boolean') voiceMode = st.voiceMode;
      render();
    };
    listeners.add(onPhoneUpdate);

    powerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      haptic();
      if (!bridge?.micStart) {
        toast('Phone Mic requires the PhoneBox Android app', 'err');
        return;
      }
      if (phoneState.running) {
        bridge.micStop();
      } else {
        bridge.micStart(voiceMode);
      }
    });

    ovBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      haptic();
      if (!bridge?.overlaySet) {
        toast('Cần cập nhật PhoneBox APK', 'err');
        return;
      }
      const next = !phoneState.overlayPinned;
      const can = bridge.canOverlay ? bridge.canOverlay() : !!phoneState.canOverlay;
      bridge.overlaySet(next);
      if (next && !can) {
        toast('Hãy cấp quyền Hiển thị trên ứng dụng khác');
      } else {
        toast(next ? 'Đã ghim — nút nổi Mic & Mouse sẽ hiện khi bạn thoát ra ngoài app' : 'Đã tắt nút nổi ngoài app');
      }
    });

    muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!phoneState.running || !bridge?.micMute) return;
      haptic();
      bridge.micMute(!phoneState.muted);
    });

    modeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      haptic();
      voiceMode = !voiceMode;
      render();
      if (phoneState.running && bridge?.micStart) {
        bridge.micStart(voiceMode);
      }
    });

    spkBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      haptic();
      if (!bridge?.speakerSet) {
        toast('Cần cập nhật PhoneBox APK để bật Loa PC 2 chiều', 'err');
        return;
      }
      bridge.speakerSet(!phoneState.speakerOn);
    });

    agVoiceBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      haptic();
      if (!phoneState.running && bridge?.micStart) {
        bridge.micStart(voiceMode);
      }
      agVoiceBtn.disabled = true;
      try {
        const r = await fetch(`${API}/ag/voice`, { method: 'POST', headers: PANEL_HEADERS });
        if (r.ok) {
          const j = await r.json();
          toast(j.voiceActive ? 'Đang bật Antigravity Voice…' : 'Đã gửi lệnh Voice Mode (Ctrl+M)');
        } else {
          toast('Không gửi được lệnh Voice tới PC');
        }
      } catch (_) {
        toast('Lỗi kết nối PC Agent');
      } finally {
        setTimeout(() => { agVoiceBtn.disabled = false; }, 600);
      }
    });

    devSelect.addEventListener('change', (e) => {
      e.stopPropagation();
      postMicConfig({ deviceId: devSelect.value }).then((st) => st && syncDevices(st)).catch(() => toast('Failed to switch output', 'err'));
    });

    let gainTimer = null;
    gainInput.addEventListener('input', (e) => {
      e.stopPropagation();
      const pct = Number(gainInput.value);
      gainVal.textContent = `${pct}%`;
      clearTimeout(gainTimer);
      gainTimer = setTimeout(() => {
        postMicConfig({ gain: (pct / 100).toFixed(2) }).catch(() => {});
      }, 90);
    });

    readPhoneState();
    render();
    pollPc();

    return {
      update(kind) {
        if (!alive) return;
        if (kind === 'push') render();
        else if (Date.now() - lastPoll > 4000) pollPc();
      },
      destroy() {
        alive = false;
        clearTimeout(gainTimer);
        listeners.delete(onPhoneUpdate);
      },
    };
  },
};


function makeBrandTitle(iconId, fallbackGlyph, labelText) {
  const wrap = h('span', 'ag-title');
  const glyph = h('span', 'ag-title-glyph', fallbackGlyph);
  const text = h('span', null, labelText);
  wrap.append(glyph, text);
  if (iconId) {
    const img = new Image();
    img.className = 'ag-title-icon';
    img.alt = '';
    img.onload = () => { glyph.replaceWith(img); };
    img.src = `${API}/shortcuts/icon?id=${encodeURIComponent(iconId)}`;
  }
  return wrap;
}

// ---------------------------------------------------------------- ag-chat
// Live Antigravity voice & chat stream right inside the Phone Mic tab.
// Reads PushStore["ag_chat"] (live SSE push from AntigravityChatWatcher) with fallback poll to /api/ag/chat.
// Provides one-touch Toggle Antigravity Voice Mode & live conversation transcript.
W['ag-chat'] = {
  needs: ['push', 'tick'],
  create(box, { o }) {
    box.classList.add('ag');

    const head = h('div', 'ag-head');
    const titleText = String(o.title || 'ANTIGRAVITY LIVE').replace(/^✨\s*/, '');
    const title = makeBrandTitle('antigravity', pmSvg('sparkles', 'ag-title-svg'), titleText);
    const actions = h('div', 'ag-head-actions');
    const voiceToggleBtn = h('button', 'ag-voice-btn');
    setBtnContent(voiceToggleBtn, 'mic', 'Bật Voice');
    voiceToggleBtn.type = 'button';
    const badge = h('span', 'ag-badge', 'OFF');
    actions.append(voiceToggleBtn, badge);
    head.append(title, actions);

    // Session bar & Project selector
    const sessionBar = h('div', 'ag-session-bar');
    const sessionBtn = h('button', 'ag-session-btn');
    sessionBtn.type = 'button';
    const projBadge = h('span', 'ag-session-proj-badge', 'General');
    const sessionTitle = h('span', 'ag-session-title', 'Đang tải phiên…');
    const sessionChevron = h('span', 'ag-session-chevron', '▾');
    sessionBtn.append(projBadge, sessionTitle, sessionChevron);
    sessionBar.append(sessionBtn);

    const banner = h('div', 'ag-banner', 'Chạm "Bật Voice" để trò chuyện với Antigravity AI bằng giọng nói');

    const list = h('div', 'ag-list');
    list.addEventListener('pointerdown', (e) => e.stopPropagation(), { passive: true });
    list.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    list.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });

    // Modal Picker Sheet for Projects & Conversations
    const picker = h('div', 'ag-picker hidden');
    const pickerHead = h('div', 'ag-picker-head');
    const pickerTitle = h('span', 'ag-picker-title', 'Chọn phiên & dự án');
    const pickerClose = h('button', 'ag-picker-close', '✕');
    pickerClose.type = 'button';
    pickerHead.append(pickerTitle, pickerClose);

    const filterRow = h('div', 'ag-filter-row');
    const convoList = h('div', 'ag-convo-list');
    convoList.addEventListener('pointerdown', (e) => e.stopPropagation(), { passive: true });
    convoList.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    convoList.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });
    picker.append(pickerHead, filterRow, convoList);

    box.append(head, sessionBar, banner, list, picker);

    let alive = true;
    let lastSig = '';
    let lastPoll = 0;
    let convoData = { currentConvId: '', currentTitle: '', currentProject: '', isAuto: true, projects: [], conversations: [] };
    let activeFilter = 'Tất cả';

    const updateSessionBtn = (t, p) => {
      if (t) sessionTitle.textContent = t;
      else if (convoData.currentTitle) sessionTitle.textContent = convoData.currentTitle;
      if (p) projBadge.textContent = p;
      else if (convoData.currentProject) projBadge.textContent = convoData.currentProject;
    };

    const renderPicker = () => {
      const projs = convoData.projects && convoData.projects.length ? convoData.projects : ['Tất cả'];
      filterRow.replaceChildren(...projs.map((p) => {
        const chip = h('button', 'ag-filter-chip' + (p === activeFilter ? ' on' : ''), p);
        chip.type = 'button';
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          haptic();
          activeFilter = p;
          renderPicker();
        });
        return chip;
      }));

      const items = [];

      // Auto tracking row
      const autoItem = h('div', 'ag-convo-item' + (convoData.isAuto ? ' active' : ''));
      autoItem.addEventListener('click', (e) => {
        e.stopPropagation();
        selectConversation('auto');
      });
      const autoBody = h('div', 'ag-convo-item-body',
        h('div', 'ag-convo-name ag-convo-auto', pmSvg('zap', 'pm-ico'), h('span', null, 'Tự động theo dõi phiên gần nhất (Auto)')),
        h('div', 'ag-convo-meta', 'Luôn cập nhật theo phiên vừa được sửa đổi trên Antigravity')
      );
      autoItem.append(autoBody);
      if (convoData.isAuto) autoItem.append(h('span', 'ag-convo-check', '✓'));
      items.push(autoItem);

      // Filtered list
      const convos = (convoData.conversations || []).filter((c) => {
        if (activeFilter === 'Tất cả') return true;
        return (c.projectName || 'General').toLowerCase() === activeFilter.toLowerCase();
      });

      for (const c of convos) {
        const it = h('div', 'ag-convo-item' + (!convoData.isAuto && c.isActive ? ' active' : ''));
        it.addEventListener('click', (e) => {
          e.stopPropagation();
          selectConversation(c.id);
        });

        const top = h('div', 'ag-convo-top',
          h('span', 'ag-convo-tag', c.projectName || 'General'),
          h('div', 'ag-convo-name', c.title || 'Untitled')
        );

        let dateStr = '';
        try {
          const d = new Date(c.lastModified);
          dateStr = `${d.getDate()}/${d.getMonth() + 1} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        } catch (_) {}

        const meta = h('div', 'ag-convo-meta',
          dateStr ? h('span', null, dateStr) : null,
          c.stepCount ? h('span', null, `${c.stepCount} bước`) : null
        );

        const body = h('div', 'ag-convo-item-body', top, meta);
        it.append(body);
        if (!convoData.isAuto && c.isActive) it.append(h('span', 'ag-convo-check', '✓'));
        items.push(it);
      }

      convoList.replaceChildren(...items);
    };

    const loadConversations = async () => {
      try {
        const r = await fetch(`${API}/ag/conversations`, { cache: 'no-store', headers: PANEL_HEADERS });
        if (r.ok) {
          convoData = await r.json();
          renderPicker();
          updateSessionBtn();
        }
      } catch (_) {}
    };

    const selectConversation = async (id) => {
      haptic();
      picker.classList.add('hidden');
      sessionBar.classList.remove('open');
      try {
        const r = await fetch(`${API}/ag/select?convId=${encodeURIComponent(id)}`, { method: 'POST', headers: PANEL_HEADERS });
        if (r.ok) {
          convoData = await r.json();
          updateSessionBtn();
          toast(id === 'auto' ? 'Đã bật theo dõi tự động' : `Đã chọn: ${convoData.currentTitle || id.slice(0, 8)}`);
          pollApi();
        }
      } catch (_) {
        toast('Lỗi khi đổi phiên làm việc');
      }
    };

    sessionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      haptic();
      const open = !picker.classList.toggle('hidden');
      sessionBar.classList.toggle('open', open);
      if (open) {
        loadConversations();
      }
    });

    pickerClose.addEventListener('click', (e) => {
      e.stopPropagation();
      picker.classList.add('hidden');
      sessionBar.classList.remove('open');
    });

    const toggleVoice = async () => {
      haptic();
      try {
        const st = bridge?.micState ? JSON.parse(bridge.micState()) : null;
        if (st && !st.running && bridge?.micStart) bridge.micStart(true);
      } catch (_) {}
      voiceToggleBtn.disabled = true;
      try {
        const r = await fetch(`${API}/ag/voice`, { method: 'POST', headers: PANEL_HEADERS });
        if (r.ok) {
          const j = await r.json();
          toast(j.voiceActive ? 'Đang bật Antigravity Voice…' : 'Đã gửi lệnh Voice Mode (Ctrl+M)');
        } else {
          toast('Không gửi được lệnh Voice');
        }
      } catch (_) {
        toast('Lỗi kết nối PC Agent');
      } finally {
        setTimeout(() => { voiceToggleBtn.disabled = false; }, 600);
      }
    };

    voiceToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleVoice();
    });

    const renderMessages = (msgs, updatedAt, voiceActive) => {
      if (!alive) return;
      const isVoice = !!voiceActive;

      if (isVoice) {
        badge.textContent = 'VOICE ON';
        badge.classList.add('on');
        setBtnContent(voiceToggleBtn, 'stop', 'Dừng Voice');
        voiceToggleBtn.classList.add('live');
        banner.textContent = 'Đang kết nối Antigravity Voice qua micro điện thoại (VB-CABLE)';
        banner.classList.add('live');
      } else {
        badge.textContent = 'OFF';
        badge.classList.remove('on');
        setBtnContent(voiceToggleBtn, 'mic', 'Bật Voice');
        voiceToggleBtn.classList.remove('live');
        banner.textContent = 'Chạm "Bật Voice" để trò chuyện với Antigravity AI bằng giọng nói';
        banner.classList.remove('live');
      }

      const arr = Array.isArray(msgs) ? msgs : [];
      const sig = `${updatedAt || 0}:${isVoice}:${arr.length}:${arr.length ? arr[arr.length - 1].text?.length : 0}`;
      if (sig === lastSig) return;
      lastSig = sig;

      if (!arr.length) {
        list.replaceChildren(h('div', 'ag-empty', 'Chưa có cuộc trò chuyện giọng nói mới. Bật Voice Mode và nói vào micro điện thoại…'));
        return;
      }

      const nearBottom = (list.scrollHeight - list.scrollTop - list.clientHeight) < 80 || list.childElementCount === 0;

      list.replaceChildren(...arr.map((m) => {
        const isAi = m.role === 'ai';
        const row = h('div', 'ag-msg ' + (isAi ? 'ai' : 'user'));
        const meta = h('div', 'ag-meta',
          h('span', 'ag-who', isAi ? 'Antigravity' : 'Bạn'),
          m.time ? h('span', 'ag-time', m.time) : null
        );
        const body = h('div', 'ag-text', m.text || '');
        row.append(meta, body);
        return row;
      }));

      if (nearBottom) {
        requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
      }
    };

    const readPush = () => {
      const item = D.push?.ag_chat;
      if (!item) return false;
      const payload = item.data || item;
      const msgs = payload.messages || item.messages;
      const voiceActive = payload.voiceActive ?? item.voiceActive ?? false;
      const title = payload.title || item.title;
      const proj = payload.projectName || item.projectName;
      if (title || proj) updateSessionBtn(title, proj);
      if (Array.isArray(msgs)) {
        renderMessages(msgs, payload.updatedAt || item.at, voiceActive);
        return true;
      }
      return false;
    };

    const pollApi = async () => {
      lastPoll = Date.now();
      try {
        const r = await fetch(`${API}/ag/chat`, { cache: 'no-store', headers: PANEL_HEADERS });
        if (!r.ok || !alive) return;
        const j = await r.json();
        if (j) {
          if (j.title || j.projectName) updateSessionBtn(j.title, j.projectName);
          if (Array.isArray(j.messages)) renderMessages(j.messages, j.updatedAt, j.voiceActive);
        }
      } catch (_) {}
    };

    loadConversations();
    if (!readPush()) pollApi();

    return {
      update(kind) {
        if (!alive) return;
        if (kind === 'push') {
          readPush();
        } else if (Date.now() - lastPoll > 3500) {
          if (!readPush()) pollApi();
        }
      },
      destroy() {
        alive = false;
      },
    };
  },
};


// ---------------------------------------------------------------- codex-chat
// Clean Codex session & quota viewer (optional widget, matching ag-chat layout without owning phone-mic).
W['codex-chat'] = {
  needs: ['push', 'tick', 'quotas'],
  create(box, { o }) {
    box.classList.add('ag', 'cx');

    const head = h('div', 'ag-head');
    const title = makeBrandTitle('codex', '◎', o.title || 'CODEX LIVE');
    const status = h('span', 'ag-badge', 'IDLE');
    head.append(title, status);

    const quota = h('div', 'cx-quota', h('span', 'cx-quota-empty', 'Đang tải hạn mức Codex…'));

    const sessionBar = h('div', 'ag-session-bar');
    const sessionBtn = h('button', 'ag-session-btn');
    sessionBtn.type = 'button';
    const project = h('span', 'ag-session-proj-badge', 'General');
    const session = h('span', 'ag-session-title', 'Đang tải phiên Codex…');
    sessionBtn.append(project, session, h('span', 'ag-session-chevron', '▾'));
    sessionBar.append(sessionBtn);

    const list = h('div', 'ag-list');
    list.addEventListener('pointerdown', (e) => e.stopPropagation(), { passive: true });
    list.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    list.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });

    const picker = h('div', 'ag-picker hidden');
    const pickerHead = h('div', 'ag-picker-head');
    const pickerTitle = h('span', 'ag-picker-title', 'Chọn phiên & dự án Codex');
    const close = h('button', 'ag-picker-close', '✕');
    close.type = 'button';
    pickerHead.append(pickerTitle, close);

    const filterRow = h('div', 'ag-filter-row');
    const conversations = h('div', 'ag-convo-list');
    conversations.addEventListener('pointerdown', (e) => e.stopPropagation(), { passive: true });
    conversations.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    conversations.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });
    picker.append(pickerHead, filterRow, conversations);

    box.append(head, quota, sessionBar, list, picker);

    let alive = true;
    let lastSig = '';
    let lastPoll = 0;
    let activeFilter = 'Tất cả';
    let convData = { currentConvId: '', currentTitle: '', currentProject: 'General', isAuto: true, projects: ['Tất cả'], conversations: [] };

    const setSession = (data) => {
      convData = { ...convData, ...(data || {}) };
      session.textContent = convData.currentTitle || 'Chọn phiên Codex';
      project.textContent = convData.currentProject || 'General';
    };

    const renderQuota = () => {
      const p = (D.quotas?.providers || []).find((item) => item.id === 'codex');
      if (!p) {
        quota.replaceChildren(h('span', 'cx-quota-empty', D.quotas ? 'Không có dữ liệu hạn mức Codex' : 'Đang tải hạn mức Codex…'));
        return;
      }
      const items = (p.limits || []).slice(0, 2).map((limit) => {
        const pct = Math.max(0, Math.min(100, Math.round(Number(limit.percent) || 0)));
        const fill = h('span', 'cx-limit-fill');
        fill.style.width = `${pct}%`;
        return h('div', 'cx-limit',
          h('div', 'cx-limit-head', h('span', null, limit.label || 'Limit'), h('b', null, `${pct}%`)),
          h('div', 'cx-limit-track', fill),
          h('small', null, `${Math.max(0, 100 - pct)}% còn lại${limit.resetsAt ? ` · reset ${new Date(limit.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`));
      });
      const meta = [p.plan, p.codex?.model, p.codex?.totalTokens != null ? `${Math.round(p.codex.totalTokens / 1000)}k tokens` : p.extra]
        .filter(Boolean).join(' · ');
      quota.replaceChildren(
        h('div', 'cx-quota-title', 'HẠN MỨC CODEX', h('span', null, meta)),
        ...(items.length ? items : [h('span', 'cx-quota-empty', p.error || 'Chưa có limit trong phiên gần đây')])
      );
    };

    const renderPicker = () => {
      const projs = Array.isArray(convData.projects) && convData.projects.length ? convData.projects : ['Tất cả'];
      filterRow.replaceChildren(...projs.map((p) => {
        const chip = h('button', 'ag-filter-chip' + (p === activeFilter ? ' on' : ''), p);
        chip.type = 'button';
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          haptic();
          activeFilter = p;
          renderPicker();
        });
        return chip;
      }));

      const auto = h('div', 'ag-convo-item' + (convData.isAuto ? ' active' : ''));
      auto.append(
        h('div', 'ag-convo-item-body',
          h('div', 'ag-convo-name ag-convo-auto', pmSvg('zap', 'pm-ico'), h('span', null, 'Tự động theo dõi phiên mới nhất (Auto)')),
          h('div', 'ag-convo-meta', 'Theo dõi phiên Codex vừa hoạt động gần nhất'))
      );
      if (convData.isAuto) auto.append(h('span', 'ag-convo-check', '✓'));
      auto.onclick = (e) => { e.stopPropagation(); select('auto'); };

      const filtered = (convData.conversations || []).filter((c) => {
        if (activeFilter === 'Tất cả') return true;
        return (c.projectName || 'General').toLowerCase() === activeFilter.toLowerCase();
      });

      const rows = [auto];
      for (const c of filtered) {
        let dateStr = '';
        try {
          const d = new Date(c.lastModified);
          if (!Number.isNaN(d.getTime())) {
            dateStr = `${d.getDate()}/${d.getMonth() + 1} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          }
        } catch (_) {}
        const row = h('div', 'ag-convo-item' + (!convData.isAuto && c.isActive ? ' active' : ''));
        row.append(
          h('div', 'ag-convo-item-body',
            h('div', 'ag-convo-top', h('span', 'ag-convo-tag', c.projectName || 'General'), h('div', 'ag-convo-name', c.title || 'Untitled')),
            h('div', 'ag-convo-meta', dateStr ? h('span', null, dateStr) : null, c.stepCount ? h('span', null, `${c.stepCount} tin nhắn`) : null))
        );
        if (!convData.isAuto && c.isActive) row.append(h('span', 'ag-convo-check', '✓'));
        row.onclick = (e) => { e.stopPropagation(); select(c.id); };
        rows.push(row);
      }
      conversations.replaceChildren(...rows);
    };

    const loadConversations = async () => {
      try {
        const r = await fetch(`${API}/codex/conversations`, { cache: 'no-store', headers: PANEL_HEADERS });
        if (r.ok && alive) { setSession(await r.json()); renderPicker(); }
      } catch (_) {}
    };

    const select = async (id) => {
      picker.classList.add('hidden');
      sessionBar.classList.remove('open');
      haptic();
      try {
        const r = await fetch(`${API}/codex/select?convId=${encodeURIComponent(id)}`, { method: 'POST', headers: PANEL_HEADERS });
        if (r.ok) {
          setSession(await r.json());
          toast(id === 'auto' ? 'Đang theo dõi phiên Codex mới nhất' : 'Đã đổi phiên Codex');
          poll();
        }
      } catch (_) { toast('Không đổi được phiên Codex', 'err'); }
    };

    sessionBtn.onclick = (e) => {
      e.stopPropagation();
      haptic();
      const open = !picker.classList.toggle('hidden');
      sessionBar.classList.toggle('open', open);
      if (open) loadConversations();
    };
    close.onclick = (e) => {
      e.stopPropagation();
      picker.classList.add('hidden');
      sessionBar.classList.remove('open');
    };

    const renderMessages = (data) => {
      if (!data || !alive) return;
      const live = !!data.active;
      status.textContent = live ? 'LIVE' : 'IDLE';
      status.classList.toggle('on', live);
      if (data.title || data.projectName) {
        setSession({
          currentTitle: data.title || convData.currentTitle,
          currentProject: data.projectName || convData.currentProject,
        });
      }
      const msgs = Array.isArray(data.messages) ? data.messages : [];
      const sig = `${data.updatedAt || 0}:${live}:${msgs.length}:${msgs.at(-1)?.text?.length || 0}`;
      if (sig === lastSig) return;
      lastSig = sig;
      if (!msgs.length) {
        list.replaceChildren(h('div', 'ag-empty', 'Chưa có nội dung Codex. Mở hoặc chạy một phiên Codex trên PC để bắt đầu.'));
        return;
      }
      const nearBottom = list.childElementCount === 0 || list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      list.replaceChildren(...msgs.map((m) => {
        const ai = m.role === 'ai';
        return h('div', 'ag-msg ' + (ai ? 'ai' : 'user'),
          h('div', 'ag-meta', h('span', 'ag-who', ai ? '◎ Codex' : 'Bạn'), m.time ? h('span', 'ag-time', m.time) : null),
          h('div', 'ag-text', m.text || ''));
      }));
      if (nearBottom) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
    };

    const readPush = () => {
      const item = D.push?.codex_chat;
      const data = item?.data || item;
      if (!data?.messages) return false;
      renderMessages(data);
      return true;
    };

    const poll = async () => {
      lastPoll = Date.now();
      try {
        const r = await fetch(`${API}/codex/chat`, { cache: 'no-store', headers: PANEL_HEADERS });
        if (r.ok && alive) renderMessages(await r.json());
      } catch (_) {}
    };

    renderQuota();
    loadConversations();
    if (!readPush()) poll();

    return {
      update(kind) {
        if (!alive) return;
        if (kind === 'quotas') renderQuota();
        if (kind === 'push') readPush();
        if (kind === 'tick' && Date.now() - lastPoll > 3500 && !readPush()) poll();
      },
      destroy() { alive = false; },
    };
  },
};
