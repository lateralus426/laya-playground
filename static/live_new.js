// Copy of live.js with Replay button added to controls
import demos from './demos/index.js';
import { Stage } from './dither.js';
import { STEP, MAX_RATE, answersFrom } from './sim.js';
import { h, bar, predict } from './ui.js';

const ROWS = ['state', 'action', 'timing'];
const TOUCH_ONLY = matchMedia('(hover: none) and (pointer: coarse)').matches;
const TONES = ['#0c0c0c', '#ffc609'];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const keys = new Set(), pressed = new Set(), stages = [];
let health = window.layaHealth ?? null;

class GameStage {
  constructor(mount, demo) {
    Object.assign(this, { demo, pilot: 'replay', paused: reducedMotion, ratio: 0, mode: null, run: undefined, epoch: 0, acc: 0, feedDirty: true, rowMin: {} });
    this.params = Object.fromEntries(demo.params.map(p => [p.id, p.value]));
    this.build(mount);
    this.stage = new Stage(this.el.canvas, { w: 768, h: 432, tones: TONES });
    this.width = this.el.canvas.clientWidth;
    this.start('replay');
    fetch(`static/data/run-${demo.id}.json`).then(r => r.ok ? r.json() : null).catch(() => null).then(run => { this.run = run; if (this.mode === 'replay' && run) this.start('replay'); });
    new IntersectionObserver(es => { this.ratio = es[0].isIntersecting ? es[0].intersectionRatio : 0; }, { threshold: [0, 0.25, 0.5, 0.75, 1] }).observe(mount);
    this.decide();
  }

  build(mount) {
    const el = this.el = {}, d = this.demo, dd = k => (el[k] = h('dd', {}, '—'));
    const pick = (values, on) => { const box = h('div', { class: 'seg', role: 'group' });
      box.append(...values.map(([v, label], i) => h('button', { class: i ? '' : 'on', onclick: e => { for (const b of box.children) b.classList.toggle('on', b === e.target); on(v); } }, label))); return box; };
    const canPlay = d.touch || !TOUCH_ONLY;
    el.canvas = h('canvas', { class: 'pixelated', tabindex: 0, 'aria-label': d.title + ' game stage', onpointerdown: () => { if (this.pilot === 'you') pressed.add('pointer'); } });
    el.score = h('b', {}, '0000'); el.best = h('b', {}, '0000'); el.crashes = h('b', {}, '000'); el.msg = h('span');
    el.pause = h('button', { onclick: () => { this.paused = !this.paused; } });
    el.replay = h('button', { class: 'on', onclick: () => {
      this.pilot = 'replay';
      el.pilot?.querySelectorAll('button').forEach(button => button.classList.remove('on'));
      el.replay.classList.add('on');
      this.start('replay');
    } }, 'REPLAY');
    el.banner = h('p', { class: 'banner' });
    el.pilot = canPlay && pick([['laya', 'LAYA PLAYS'], ['you', 'YOU PLAY']], v => {
      this.pilot = v === 'laya' ? 'live' : 'you';
      el.replay.classList.remove('on');
      el.canvas.focus({ preventScroll: true });
    });
    el.pilot?.querySelectorAll('button').forEach(button => button.classList.remove('on'));
    mount.append(
      h('div', {},
        h('div', { class: 'stage' }, el.canvas, el.banner,
          h('div', { class: 'hud' }, h('span', {}, 'SCORE ', el.score), h('span', {}, 'BEST ', el.best), h('span', { class: 'sp' }), h('span', {}, 'CRASHES ', el.crashes)),
          h('div', { class: 'stage-msg' }, el.msg)),
        h('div', { class: 'controls' }, el.pilot, el.pause, el.replay, h('span', { class: 'keys' }, canPlay ? d.keys : 'PLAY IT YOURSELF ON A KEYBOARD'))),
      h('dl', { class: 'feed' },
        h('dt', {}, 'SOURCE'), dd('source'), h('dt', {}, 'STATE SENT'), dd('state'), h('dt', {}, 'QUESTION'), dd('question'),
        h('dt', {}, 'ANSWER'), dd('bars'), h('dt', {}, 'ACTION'), dd('action'), h('dt', {}, 'TIMING'), dd('timing')));
  }

  ready() { return !!health && health.models[this.demo.checkpoint] === 'ready'; }
  wantMode() { return this.pilot; }

  start(mode) {
    this.mode = mode; this.epoch++; this.step = 0; this.ri = 0; this.pending = null; this.acc = 0;
    this.feed = null; this.feedDirty = true; this.stamps = []; this.count = 0; this.lat = { model: 0, rtt: 0 }; this.error = '';
    const seed = mode === 'replay' && this.run ? this.run.seed : (Math.random() * 2 ** 32) >>> 0;
    this.inst = this.demo.create(seed);
  }

  tick(input) {
    if (this.mode === 'replay') {
      const d = this.run.decisions;
      if (this.pending && d[this.ri][1] === this.step) {
        const rec = d[this.ri++], answers = answersFrom(this.pending, rec[2]);
        this.note(this.pending, answers, this.inst.act(answers, this.run.params, true), rec[3]);
        this.pending = null;
      }
      if (!this.pending && this.ri < d.length && d[this.ri][0] === this.step) this.pending = this.inst.observe();
    }
    this.inst.update(STEP, input); this.step++;
    if (this.mode === 'replay' && this.step >= this.run.steps) this.start('replay');
  }

  note(obs, answers, action, ms, rtt) {
    const k = this.count++ ? 0.12 : 1;
    this.lat.model += (ms - this.lat.model) * k; if (rtt != null) this.lat.rtt += (rtt - this.lat.rtt) * k;
    this.stamps.push(this.step); while (this.stamps[0] < this.step - 1 / STEP) this.stamps.shift();
    this.feed = { obs, answers, action }; this.feedDirty = true;
  }

  async decide() {
    for (;;) {
      if (this.mode !== 'live' || !this.active || this.paused || this.inst.dead || document.hidden) { await sleep(80); continue; }
      const mine = this.epoch, obs = this.inst.observe(), t0 = performance.now();
      let res;
      try { res = await predict({ state: obs.state, questions: obs.questions, model: this.demo.checkpoint }); this.error = ''; }
      catch (e) { this.error = e.message; this.feedDirty = true; await sleep(1000); continue; }
      const rtt = performance.now() - t0;
      if (mine !== this.epoch) continue;
      this.note(obs, res.answers, this.inst.act(res.answers, this.params, !this.paused), res.latency_ms, rtt);
      if (rtt < 1000 / MAX_RATE) await sleep(1000 / MAX_RATE - rtt);
    }
  }

  frame(dt, active) {
    this.active = active;
    const want = this.wantMode();
    if (want !== this.mode) this.start(want);
    const playable = this.mode !== 'replay' || this.run;
    if (active && !this.paused && playable) {
      this.acc += dt;
      const input = this.mode === 'you' ? this.demo.input(keys, pressed) : {};
      let stepped = false;
      while (this.acc >= STEP) { this.tick(input); this.acc -= STEP; stepped = true; for (const k in input) input[k] = false; }
      if (stepped) pressed.clear();
    }
    if (!active && this.drawn) return;
    this.drawn = true;
    const { el, inst } = this;
    inst.draw(this.stage.ctx, this.stage.w, this.stage.h); this.stage.present();
    el.score.textContent = String(inst.score).padStart(4, '0');
    el.best.textContent = String(inst.best).padStart(4, '0');
    el.crashes.textContent = String(inst.crashes).padStart(3, '0');
    el.pause.textContent = this.paused ? (this.step ? 'RESUME' : 'START') : 'PAUSE';
    el.msg.textContent = this.paused ? 'PAUSED' : inst.dead ? 'CRASH' : this.error ? 'MODEL UNREACHABLE'
      : !playable ? (this.run === null ? 'RUNS WITH THE LOCAL MODEL' : 'LOADING') : '';
    this.renderBanner();
    if (this.feedDirty) this.renderFeed();
  }

  renderBanner() {
    const local = health !== false && health !== null, text = this.mode === 'live' ? 'Live. The model on this machine is playing.'
      : this.mode === 'you' ? 'You are playing. Same physics, no model.'
      : local ? 'Recorded run. The model is loading and will take over shortly.'
      : 'Recorded run: real decisions, replayed.';
    if (this.bannerText === text) return;
    this.bannerText = text;
    this.el.banner.replaceChildren(text, ...(this.mode === 'replay' && !local ? [' ', h('a', { class: 'nw', href: './#run-it' }, 'Run it locally'), ' to watch it play live.'] : []));
    this.el.banner.classList.toggle('live', this.mode === 'live');
  }

  renderFeed() {
    this.feedDirty = false;
    const { el, run } = this;
    el.source.textContent = this.mode === 'live' ? `live model · ${this.demo.checkpoint} checkpoint`
      : this.mode === 'you' ? 'you are playing · the model is idle'
      : run ? `recorded run · ${run.machine} · ${run.recorded.replace(/-/g, '\u2011')}` : '—';
    if (!this.feed) { for (const k of ['state', 'question', 'action', 'timing']) el[k].textContent = '—'; return el.bars.replaceChildren(); }
    const { obs, answers, action } = this.feed, [qid, q] = Object.entries(obs.questions)[0], a = answers[qid];
    el.state.textContent = typeof obs.state === 'string' ? obs.state : JSON.stringify(obs.state);
    el.question.textContent = q.instructions;
    el.bars.replaceChildren(...Object.entries(a.probabilities).map(([k, p]) => bar(k, p, k === a.choice)));
    el.action.replaceChildren(h('b', {}, action.label), h('span', { class: 'why' }, action.why));
    el.timing.textContent = `${this.lat.model.toFixed(1)} ms per decision · ${this.stamps.length} decisions a second · ${this.count} so far`;
    for (const k of ROWS) { const tall = el[k].offsetHeight; if (tall > (this.rowMin[k] || 0)) el[k].style.minHeight = (this.rowMin[k] = tall) + 'px'; }
  }
}

let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (document.hidden) return;
  const top = stages.reduce((a, s) => (s.ratio > (a ? a.ratio : 0) ? s : a), null);
  for (const s of stages) s.frame(dt, s === top);
}

addEventListener('laya:health', e => { health = e.detail; });
addEventListener('resize', () => stages.forEach(s => {
  const w = s.el.canvas.clientWidth; if (w === s.width) return;
  s.width = w; s.stage.layout(); s.drawn = false;
  s.rowMin = {}; for (const k of ROWS) s.el[k].style.minHeight = ''; s.feedDirty = true;
}));
for (const mount of document.querySelectorAll('.game-mount')) {
  const demo = demos.find(d => d.id === mount.dataset.demo);
  if (demo) stages.push(new GameStage(mount, demo));
}
requestAnimationFrame(loop);
