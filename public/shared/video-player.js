// Единый плеер для видеофайла и YouTube. Чистые функции экспортируются для тестов в Node.

export function shouldStop(current, to) {
  return to !== null && to !== undefined && current >= to - 0.05;
}

export function youtubeId(url) {
  const s = String(url ?? '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/);
  return m && /youtu/.test(s) ? m[1] : null;
}

export function mediaUrl(quizName, src) {
  const file = String(src ?? '').replace(/^media\//, '');
  return `/quizzes/${encodeURIComponent(quizName)}/media/${encodeURIComponent(file)}`;
}

let ytApi = null;
function loadYouTubeApi(timeoutMs = 6000) {
  if (globalThis.YT?.Player) return Promise.resolve(globalThis.YT);
  if (!ytApi) {
    ytApi = new Promise((resolve, reject) => {
      const prev = globalThis.onYouTubeIframeAPIReady;
      globalThis.onYouTubeIframeAPIReady = () => { prev?.(); resolve(globalThis.YT); };
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.onerror = () => reject(new Error('YouTubeUnavailable'));
      document.head.append(tag);
      setTimeout(() => reject(new Error('YouTubeTimeout')), timeoutMs);
    }).catch((e) => { ytApi = null; throw e; });
  }
  return ytApi;
}

/**
 * @param {HTMLElement} container
 * @param {{source:'file'|'youtube', src:string, start?:number, pauseAt?:number|null, end?:number|null}} media
 * @param {string} quizName
 * @param {{onPauseReached?:Function, onEnded?:Function, onError?:Function, controls?:boolean}} opts
 */
export async function createPlayer(container, media, quizName, opts = {}) {
  const { onPauseReached, onEnded, onError, onBlocked, controls = false } = opts;
  let target = null; // секунда, на которой надо остановиться
  let raf = 0;
  let destroyed = false;
  let impl;

  container.innerHTML = '';
  const holder = document.createElement('div');
  holder.className = 'vp';
  container.append(holder);

  if (media.source === 'youtube') {
    const id = youtubeId(media.src);
    if (!id) { onError?.(new Error('BadYouTubeUrl')); throw new Error('BadYouTubeUrl'); }
    let YT;
    try { YT = await loadYouTubeApi(); } catch (e) { onError?.(e); throw e; }
    const div = document.createElement('div');
    holder.append(div);
    impl = await new Promise((resolve, reject) => {
      // не дождались — убираем недогруженный плеер, чтобы он не остался висеть
      const timeout = setTimeout(() => { try { p.destroy(); } catch { /* нет */ } onError?.(new Error('YouTubeTimeout')); reject(new Error('YouTubeTimeout')); }, 10000);
      const p = new YT.Player(div, {
        videoId: id,
        width: '100%',
        height: '100%',
        playerVars: { controls: controls ? 1 : 0, rel: 0, modestbranding: 1, playsinline: 1, disablekb: 1, iv_load_policy: 3, fs: 0 },
        events: {
          onReady: () => {
            clearTimeout(timeout);
            resolve({
              play: () => {
                p.playVideo();
                // автозапуск со звуком заблокирован — плеер так и не начал играть
                setTimeout(() => { const st = p.getPlayerState?.(); if (!destroyed && (st === -1 || st === 5)) onBlocked?.(); }, 2500);
              },
              pause: () => p.pauseVideo(),
              seek: (t) => p.seekTo(Math.max(0, t), true),
              time: () => p.getCurrentTime?.() ?? 0,
              duration: () => p.getDuration?.() ?? 0,
              destroy: () => p.destroy(),
            });
          },
          onError: (e) => { clearTimeout(timeout); onError?.(new Error('YouTubeError ' + e.data)); reject(new Error('YouTubeError')); },
          onStateChange: (e) => { if (e.data === YT.PlayerState.ENDED) onEnded?.(); },
        },
      });
    });
  } else {
    const v = document.createElement('video');
    v.src = mediaUrl(quizName, media.src);
    v.preload = 'auto';
    v.playsInline = true;
    v.controls = controls;
    holder.append(v);
    v.addEventListener('ended', () => onEnded?.());
    v.addEventListener('error', () => { if (!destroyed) onError?.(new Error('VideoError')); });
    v.addEventListener('timeupdate', check);
    impl = {
      play: () => v.play().catch((e) => { if (e?.name === 'NotAllowedError') onBlocked?.(); }),
      pause: () => v.pause(),
      seek: (t) => { v.currentTime = Math.max(0, t); },
      time: () => v.currentTime,
      duration: () => v.duration || 0,
      destroy: () => { v.pause(); v.removeAttribute('src'); v.load(); },
      el: v,
    };
  }

  function check() {
    if (destroyed || target === null) return;
    if (shouldStop(impl.time(), target)) {
      const t = target;
      target = null;
      impl.pause();
      impl.seek(t);
      onPauseReached?.(t);
    }
  }
  // следим за временем только пока ждём точку остановки: без цели цикл не крутится
  function loop() {
    raf = 0;
    check();
    if (!destroyed && target !== null) raf = requestAnimationFrame(loop);
  }

  return {
    playSegment(from, to) {
      target = to ?? null;
      impl.seek(from ?? 0);
      impl.play();
      if (target !== null && !raf) raf = requestAnimationFrame(loop);
    },
    show(at) { target = null; impl.seek(at ?? 0); impl.pause(); },
    play: () => impl.play(),
    pause: () => impl.pause(),
    seek: (t) => impl.seek(t),
    seekBy: (d) => impl.seek(impl.time() + d),
    currentTime: () => impl.time(),
    duration: () => impl.duration(),
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      try { impl.destroy(); } catch { /* уже уничтожен */ }
      container.innerHTML = '';
    },
  };
}
