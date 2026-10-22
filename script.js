'use strict';
/* =====================================================================
   CPU Pipeline Execution Simulator
   Part 1: Simulation engine (no DOM)   Part 2: Dashboard (DOM)
   The engine runs the pipeline cycle by cycle and records every cycle,
   so "Previous cycle" is just a look back at the recorded history.
   ===================================================================== */

/* ---------- Pipeline layouts (index of each important stage) ---------- */
const STAGE_CFG = {
  3: { names: ['IF', 'EX', 'WB'], read: 1, exReady: 1, loadReady: 1, mem: 1, wb: 2, br: 1 },
  4: { names: ['IF', 'ID', 'EX', 'WB'], read: 1, exReady: 2, loadReady: 2, mem: 2, wb: 3, br: 2 },
  5: { names: ['IF', 'ID', 'EX', 'MEM', 'WB'], read: 1, exReady: 2, loadReady: 3, mem: 3, wb: 4, br: 2 },
  6: { names: ['IF', 'ID', 'EX1', 'EX2', 'MEM', 'WB'], read: 1, exReady: 3, loadReady: 4, mem: 4, wb: 5, br: 3 },
  7: { names: ['IF1', 'IF2', 'ID', 'EX', 'MEM1', 'MEM2', 'WB'], read: 2, exReady: 3, loadReady: 5, mem: 4, wb: 6, br: 3 }
};
const STAGE_DESC = {
  IF: 'is being fetched from memory', ID: 'is being decoded and its registers are read',
  EX: 'is calculating in the ALU', MEM: 'is reading/writing data memory', WB: 'is writing its result to a register'
};

/* ---------- Instruction set ---------- */
const OPS = {
  ADD: { t: 'R', f: (a, b) => a + b }, SUB: { t: 'R', f: (a, b) => a - b },
  AND: { t: 'R', f: (a, b) => a & b }, OR: { t: 'R', f: (a, b) => a | b },
  XOR: { t: 'R', f: (a, b) => a ^ b }, MUL: { t: 'R', f: (a, b) => a * b },
  SLT: { t: 'R', f: (a, b) => (a < b ? 1 : 0) },
  ADDI: { t: 'I' }, LW: { t: 'L' }, SW: { t: 'S' }, BEQ: { t: 'B' }, BNE: { t: 'B' }, NOP: { t: 'N' }
};
const DEFAULT_OPS = ['ADD', 'SUB', 'AND', 'OR', 'ADDI', 'LW', 'SW', 'BEQ', 'BNE', 'NOP'];

/* ---------- Step 1: read the text and check it ---------- */
function parseProgram(text, enabled) {
  const errors = [], prog = [], labels = {}, raw = [];
  text.split('\n').forEach((ln, i) => {
    let s = ln.replace(/(#|;|\/\/).*$/, '').trim(), m;
    while ((m = s.match(/^([A-Za-z_]\w*)\s*:\s*(.*)$/))) {
      const L = m[1].toUpperCase();
      if (labels[L] !== undefined) errors.push(`Line ${i + 1}: label "${m[1]}" is defined twice.`);
      labels[L] = raw.length; s = m[2];
    }
    if (s) raw.push({ s, line: i + 1 });
  });
  if (!raw.length) errors.push('Please type at least one instruction.');
  if (raw.length > 40) errors.push('Please use 40 instructions or fewer.');
  raw.forEach(({ s, line }) => {
    const err = msg => errors.push(`Line ${line}: ${msg}`);
    const m = s.match(/^([A-Za-z]+)\s*(.*)$/);
    if (!m) return err(`I cannot understand "${s}".`);
    const op = m[1].toUpperCase(), def = OPS[op];
    if (!def) return err(`unknown instruction "${m[1]}". Known: ${Object.keys(OPS).join(', ')}.`);
    if (!enabled.has(op)) return err(`${op} is switched off in "Supported instructions".`);
    const a = m[2] ? m[2].split(',').map(x => x.trim()) : [];
    const need = n => { if (a.length !== n) { err(`${op} needs ${n} operand(s) but you wrote ${a.length}.`); return false; } return true; };
    const reg = x => { const r = /^R(\d+)$/i.exec(x || ''); if (!r || +r[1] > 15) { err(`"${x}" is not a valid register (use R0 to R15).`); return null; } return +r[1]; };
    const ins = { op, t: def.t, text: `${op} ${a.join(', ')}`.trim(), line, dest: null, src: [], f: def.f };
    if (def.t === 'R') {
      if (!need(3)) return;
      ins.rd = reg(a[0]); ins.rs = reg(a[1]); ins.rt = reg(a[2]); ins.dest = ins.rd; ins.src = [ins.rs, ins.rt];
    } else if (def.t === 'I') {
      if (!need(3)) return;
      ins.rt = reg(a[0]); ins.rs = reg(a[1]);
      if (!/^-?\d+$/.test(a[2])) err(`"${a[2]}" is not a whole number.`);
      ins.imm = +a[2]; ins.dest = ins.rt; ins.src = [ins.rs];
    } else if (def.t === 'L' || def.t === 'S') {
      if (!need(2)) return;
      ins.rt = reg(a[0]);
      const mm = /^(-?\d+)\s*\(\s*(R\d+)\s*\)$/i.exec(a[1]);
      if (!mm) return err('use the form offset(Rn), for example 4(R2).');
      ins.off = +mm[1]; ins.rs = reg(mm[2]);
      if (def.t === 'L') { ins.dest = ins.rt; ins.src = [ins.rs]; } else ins.src = [ins.rt, ins.rs];
    } else if (def.t === 'B') {
      if (!need(3)) return;
      ins.rs = reg(a[0]); ins.rt = reg(a[1]); ins.src = [ins.rs, ins.rt];
      const L = a[2].toUpperCase();
      if (labels[L] === undefined) err(`label "${a[2]}" does not exist.`); else ins.target = labels[L];
    } else need(0);
    prog.push(ins);
  });
  return { prog, errors };
}

/* ---------- Step 2: run the program normally to learn real values and branch results ---------- */
function runFunctional(prog) {
  const R = Array(16).fill(0), M = {}, stream = [];
  let pc = 0;
  while (pc < prog.length) {
    if (stream.length >= 300) throw new Error('The program ran more than 300 instructions. It may be an infinite loop; please check your branch.');
    const p = prog[pc]; let next = pc + 1, taken = false;
    const w = (r, v) => { if (r !== 0) R[r] = v | 0; };
    switch (p.t) {
      case 'R': w(p.rd, p.f(R[p.rs], R[p.rt])); break;
      case 'I': w(p.rt, R[p.rs] + p.imm); break;
      case 'L': w(p.rt, M[R[p.rs] + p.off] || 0); break;
      case 'S': M[R[p.rs] + p.off] = R[p.rt]; break;
      case 'B': taken = p.op === 'BEQ' ? R[p.rs] === R[p.rt] : R[p.rs] !== R[p.rt]; if (taken) next = p.target; break;
    }
    stream.push({ si: pc, taken }); pc = next;
  }
  return { stream, R, M };
}

/* ---------- Step 3: the pipeline simulation ---------- */
function simulate(prog, stream, cfg) {
  const S = STAGE_CFG[cfg.stages], K = S.names.length;
  const bub = why => ({ bub: true, why });          // an empty slot ("bubble")
  const insts = [], cycles = [], hz = [], hzMap = {}, stats = { data: 0, control: 0, structural: 0 };
  let sPtr = 0, dyn = 0, gN = 0, block = false, ghostPc = null, ctrlHz = null, c = 0;

  const mk = (si, ghost, sd) => {
    const p = prog[si];
    const i = { id: ghost ? 'X' + (++gN) : 'I' + (++dyn), ghost, si, op: p.op, t: p.t, text: p.text, target: p.target,
      dest: p.dest > 0 ? p.dest : null, src: (p.src || []).filter(r => r > 0), cells: {}, fetchC: c + 1 };
    if (sd) i.taken = sd.taken;
    insts.push(i); return i;
  };
  const addHz = (key, o) => { if (!hzMap[key]) { hzMap[key] = Object.assign({ stalls: [], fwd: false, ign: false }, o); hz.push(hzMap[key]); } return hzMap[key]; };

  // Decide what enters IF next cycle. memInst is set when a LW/SW will use the shared memory.
  const fetch = memInst => {
    const wants = ghostPc !== null ? ghostPc < prog.length : sPtr < stream.length;
    if (!wants) return bub('nothing left to fetch');
    if (block) { stats.control++; ctrlHz.stalls.push(c); return bub('fetch paused: waiting for branch result'); }
    if (memInst) {
      stats.structural++;
      const nid = 'I' + (dyn + 1);
      addHz('S' + memInst.id + nid, { type: 'Structural', c1: c + 1, a: memInst, b: { id: nid, text: prog[stream[sPtr].si].text } }).stalls.push(c);
      return bub(`structural hazard: memory busy with ${memInst.id}`);
    }
    if (ghostPc !== null) { stats.control++; ctrlHz.stalls.push(c); return mk(ghostPc++, true); }
    const sd = stream[sPtr++], i = mk(sd.si, false, sd);
    if (i.t === 'B') {
      const h = addHz('C' + i.id, { type: 'Control', c1: c + 1, a: i }); ctrlHz = h; i.hz = h;
      if (cfg.branch === 'stall') block = true;
      else { const pt = cfg.branch === 'taken'; h.pred = pt; i.mis = pt !== i.taken; if (i.mis) ghostPc = pt ? i.target : i.si + 1; }
    }
    return i;
  };

  let pipe = Array.from({ length: K }, () => bub('empty'));
  pipe[0] = fetch(null);

  while (true) {
    if (sPtr >= stream.length && ghostPc === null && pipe.every(x => x.bub)) break;
    if (++c > 1500) throw new Error('Simulation became too long (more than 1500 cycles).');
    const ev = [];
    pipe.forEach((x, s) => { if (!x.bub) { x.cells[c] = { s, held: x.last === s, ghost: x.ghost }; x.last = s; } });
    cycles.push({ pipe: pipe.slice(), ev });

    const w = pipe[S.wb];
    if (!w.bub && !w.ghost) w.doneC = c;

    // (a) data hazards: look at the instruction in the register-read stage
    let stall = false;
    const d = pipe[S.read];
    if (!d.bub && !d.ghost) {
      new Set(d.src).forEach(r => {
        let p = null, ps = 0;
        for (let s = S.read + 1; s < S.wb; s++) { const x = pipe[s]; if (!x.bub && !x.ghost && x.dest === r) { p = x; ps = s; break; } }
        if (!p) return;
        const ready = p.t === 'L' ? S.loadReady : S.exReady;
        const h = addHz(`D${d.id}|${p.id}|${r}`, { type: 'Data', c1: c, a: d, b: p, reg: r });
        if (cfg.forward && ps >= ready) { h.fwd = true; ev.push(`${d.id} needs R${r} from ${p.id}. Forwarding passes the value directly, so no waiting.`); }
        else if (cfg.autoStall) { stall = true; h.stalls.push(c); ev.push(`${d.id} needs R${r} but ${p.id} has not produced it yet. The pipeline STALLS: ${d.id} waits and a bubble is inserted.`); }
        else { h.ign = true; ev.push(`WARNING: ${d.id} reads R${r} too early (stall is OFF), so it uses an OLD value.`); }
      });
    }
    if (stall) stats.data++;

    // (b) control hazard: a branch reaches its resolve stage
    const b = pipe[S.br]; let flush = false;
    if (!b.bub && !b.ghost && b.t === 'B') {
      b.hz.resolved = c;
      if (cfg.branch === 'stall') block = false;
      if (b.mis) flush = true;
      ev.push(`Branch ${b.id} is resolved: it is ${b.taken ? 'TAKEN' : 'NOT taken'}. ` +
        (cfg.branch === 'stall' ? 'Fetching continues from the correct place next cycle.' : b.mis ? 'The guess was WRONG, so wrong-path instructions are flushed.' : 'The guess was right, so no time is lost.'));
    }

    // (c) move every instruction one step forward (or hold on a stall)
    let next;
    if (stall) {
      next = pipe.slice();
      for (let s = K - 1; s > S.read + 1; s--) next[s] = pipe[s - 1];
      next[S.read + 1] = bub('bubble from data stall');
    } else next = [null].concat(pipe.slice(0, K - 1));
    if (flush) {
      let n = 0;
      next.forEach((x, s) => { if (x && x.ghost) { n++; next[s] = bub('flushed wrong-path instruction'); } });
      ghostPc = null; if (n) ev.push(`${n} wrong-path instruction(s) are thrown away (flush).`);
    }

    // (d) fetch the next instruction (unless IF is holding because of a stall)
    if (!(stall && !pipe[0].bub)) {
      const m = next[S.mem];
      const useMem = cfg.sharedMem && ghostPc === null && m && !m.bub && !m.ghost && (m.t === 'L' || m.t === 'S');
      next[0] = fetch(useMem ? m : null);
    }
    pipe = next;
  }
  return { insts, cycles, hz, stats, total: cycles.length, n: stream.length, K, S, cfg };
}

/* ---------- Performance numbers ---------- */
function perf(sim, cur) {
  const { n, K, total: T } = sim, ideal = n + K - 1, np = n * K;
  return { n, K, T, ideal, np, stall: T - ideal, speed: np / T, eff: (np / T / K) * 100, cpi: T / n,
    done: sim.insts.filter(i => i.doneC && i.doneC <= cur).length };
}

/* ---------- Demo programs ---------- */
const DEMOS = [
  { name: '1. Normal execution', info: 'Five independent instructions. No hazards, so one instruction finishes every cycle once the pipeline is full.',
    code: 'ADDI R1, R0, 1\nADDI R2, R0, 2\nADDI R3, R0, 3\nADDI R4, R0, 4\nADDI R5, R0, 5',
    cfg: { stages: 5, forward: true, autoStall: true, sharedMem: false, branch: 'nottaken' } },
  { name: '2. Data hazard', info: 'Each instruction needs the result of the one before it. With forwarding OFF, the pipeline must stall until the value is written back.',
    code: 'ADDI R1, R0, 10\nADD  R2, R1, R1\nSUB  R3, R2, R1\nOR   R4, R3, R2',
    cfg: { stages: 5, forward: false, autoStall: true, sharedMem: false, branch: 'nottaken' } },
  { name: '3. Forwarding', info: 'ALU results are forwarded with no stall. The load-use pair (LW then ADD) still needs 1 stall cycle, because the data only exists after MEM.',
    code: 'ADDI R1, R0, 10\nADD  R2, R1, R1\nSW   R2, 0(R0)\nLW   R3, 0(R0)\nADD  R4, R3, R1',
    cfg: { stages: 5, forward: true, autoStall: true, sharedMem: false, branch: 'nottaken' } },
  { name: '4. Branch hazard', info: 'The branch is taken but we predicted "not taken", so two wrong-path instructions are fetched and flushed. Try the other branch modes!',
    code: 'ADDI R1, R0, 1\nADDI R2, R0, 1\nBEQ  R1, R2, skip\nADDI R3, R0, 99   # wrong path\nADDI R4, R0, 98   # wrong path\nskip: ADDI R5, R0, 5\nADD  R6, R5, R1',
    cfg: { stages: 5, forward: true, autoStall: true, sharedMem: false, branch: 'nottaken' } },
  { name: '5. Structural hazard', info: 'Instructions and data share one memory. When LW or SW is in MEM, the fetch of a new instruction must wait.',
    code: 'LW   R1, 0(R0)\nADDI R2, R0, 2\nADDI R3, R0, 3\nADDI R4, R0, 4\nSW   R2, 4(R0)\nADDI R5, R0, 5',
    cfg: { stages: 5, forward: true, autoStall: true, sharedMem: true, branch: 'nottaken' } }
];

/* ===================== Part 2: Dashboard ===================== */
if (typeof document !== 'undefined') {
  const $ = id => document.getElementById(id);
  const esc = t => String(t).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const key = n => n.replace(/\d/g, '');
  let sim = null, cur = 0, timer = null, final = null;

  function readCfg() {
    const stages = parseInt($('stages').value, 10);
    if (!STAGE_CFG[stages]) throw new Error('Pipeline stages must be a number from 3 to 7.');
    return { stages, forward: $('forward').checked, autoStall: $('autoStall').checked,
      sharedMem: $('sharedMem').checked, branch: $('branch').value };
  }
  function enabledOps() { return new Set([...document.querySelectorAll('#opsList input:checked')].map(x => x.value)); }
  function showErrors(list) { $('errors').innerHTML = list.map(e => `<p>${esc(e)}</p>`).join(''); }
  function setStatus(t) { $('status').textContent = t; }
  function stopTimer() { clearInterval(timer); timer = null; }

  // Build the simulation from the editor + configuration. Returns true on success.
  function build() {
    stopTimer(); showErrors([]);
    try {
      const cfg = readCfg();
      const { prog, errors } = parseProgram($('code').value, enabledOps());
      if (errors.length) { showErrors(errors); setStatus('Fix the errors in the instruction editor, then press Start.'); sim = null; cur = 0; render(); return false; }
      const run = runFunctional(prog);
      sim = simulate(prog, run.stream, cfg); final = run; cur = 1;
      return true;
    } catch (e) { showErrors([e.message]); setStatus('Could not build the simulation.'); sim = null; cur = 0; render(); return false; }
  }

  function invalidate() {
    stopTimer(); sim = null; cur = 0; showErrors([]);
    setStatus('Settings changed. Press Start to rebuild the simulation.'); render();
  }

  function tick() {
    if (cur < sim.total) { cur++; render(); }
    if (cur >= sim.total) { stopTimer(); render(); }
  }
  function play() {
    stopTimer();
    if (!sim || cur >= sim.total) { if (!build()) return; }
    timer = setInterval(tick, +$('speed').value); render();
  }

  /* ----- rendering ----- */
  function render() {
    const has = !!sim, playing = !!timer, end = has && cur >= sim.total;
    $('bPause').disabled = !playing;
    $('bResume').disabled = !(has && !playing && !end);
    $('bPrev').disabled = !(has && cur > 1);
    $('bNext').disabled = has && end;
    $('cycleLabel').textContent = has ? `Cycle ${cur} of ${sim.total}` : '';
    if (!has) {
      $('pipeView').innerHTML = ''; $('explain').innerHTML = '<li>Nothing running yet. Press <b>Start</b>.</li>';
      $('gridWrap').innerHTML = ''; $('hazards').innerHTML = ''; $('cards').innerHTML = ''; $('compare').innerHTML = '';
      return;
    }
    if (end) setStatus(`Finished: ${sim.n} instructions completed in ${sim.total} cycles.`);
    else setStatus(playing ? 'Running automatically...' : `Paused at cycle ${cur}. Use Next / Previous, or Resume.`);
    renderPipe(); renderGrid(); renderHazards(); renderPerf();
  }

  function renderPipe() {
    const names = sim.S.names, snap = sim.cycles[cur - 1];
    $('pipeView').innerHTML = snap.pipe.map((x, s) => {
      const k = key(names[s]);
      if (x.bub) return `<div class="stage bubble"><b>${names[s]}</b><span>${x.why === 'empty' ? 'empty' : 'bubble: ' + esc(x.why)}</span></div>`;
      const held = x.cells[cur] && x.cells[cur].held;
      return `<div class="stage st-${k} ${x.ghost ? 'ghost' : ''} ${held ? 'held' : ''}"><b>${names[s]}</b><span>${x.id}: ${esc(x.text)}</span></div>`;
    }).join('');
    const li = [];
    snap.pipe.forEach((x, s) => {
      if (x.bub) { if (x.why !== 'empty') li.push(`<li>${names[s]} holds an empty slot (bubble): ${esc(x.why)}.</li>`); return; }
      const held = x.cells[cur] && x.cells[cur].held;
      li.push(`<li><b>${x.id}</b> (${esc(x.op)}) ${STAGE_DESC[key(names[s])]}${x.ghost ? ' <b>[wrong path, will be flushed]</b>' : ''}${held ? ' <b>[waiting here: stalled]</b>' : ''}.</li>`);
    });
    snap.ev.forEach(e => li.push(`<li class="warn">${esc(e)}</li>`));
    const sh = snap.pipe.filter(x => !x.bub && !x.ghost).length;
    li.push(`<li>${sh} real instruction(s) are inside the pipeline at the same time.</li>`);
    $('explain').innerHTML = li.join('');
  }

  function renderGrid() {
    const T = sim.total, names = sim.S.names;
    let h = '<table class="grid"><thead><tr><th>Instruction</th>';
    for (let c = 1; c <= T; c++) h += `<th class="${c === cur ? 'now' : ''}">${c}</th>`;
    h += '</tr></thead><tbody>';
    sim.insts.filter(i => i.fetchC <= cur).forEach(i => {
      h += `<tr class="${i.ghost ? 'ghostrow' : ''}"><th>${i.id}: ${esc(i.text)}${i.ghost ? ' (wrong path)' : ''}</th>`;
      for (let c = 1; c <= T; c++) {
        const x = i.cells[c], now = c === cur ? ' now' : '';
        if (x && c <= cur) h += `<td class="${x.ghost ? 'flush' : x.held ? 'stall' : 'st-' + key(names[x.s])}${now}">${names[x.s]}</td>`;
        else h += `<td class="${now.trim()}"></td>`;
      }
      h += '</tr>';
    });
    $('gridWrap').innerHTML = h + '</tbody></table>';
  }

  function renderHazards() {
    const names = sim.S.names, list = sim.hz.filter(h => h.c1 <= cur);
    if (!list.length) { $('hazards').innerHTML = '<p class="hint">No hazards detected up to this cycle.</p>'; return; }
    $('hazards').innerHTML = list.map(h => {
      const st = h.stalls.filter(x => x <= cur).length;
      let title, who, cause, fix;
      if (h.type === 'Data') {
        title = `Data hazard (RAW) on R${h.reg}`;
        who = `${h.a.id} (${esc(h.a.text)}) needs R${h.reg} from ${h.b.id} (${esc(h.b.text)}).`;
        cause = 'The consumer wants to read a register before the older instruction has written it.';
        if (h.ign) fix = 'NOT fixed (automatic stall is OFF): the instruction reads an old value, so the result is wrong.';
        else if (h.fwd && h.stalls.length) fix = `Stalled ${h.stalls.length} cycle(s) until the result was ready, then forwarded.`;
        else if (h.fwd) fix = 'Solved by forwarding. No stall needed.';
        else fix = 'Solved by stalling until the producer writes the register in WB.';
      } else if (h.type === 'Control') {
        title = `Control hazard (branch ${h.a.id})`;
        who = `${h.a.id} (${esc(h.a.text)}) changes which instruction comes next.`;
        cause = `The branch result is not known until stage ${names[sim.S.br]}.`;
        if (sim.cfg.branch === 'stall') fix = `Solved by pausing fetch until the result is known (${st} lost cycle(s) so far).`;
        else if (!h.resolved || h.resolved > cur) fix = `Guess: ${h.pred ? 'taken' : 'not taken'}. Not resolved yet.`;
        else fix = h.a.mis ? `Guess "${h.pred ? 'taken' : 'not taken'}" was wrong. Wrong-path instructions flushed. Penalty: ${h.stalls.length} cycle(s).`
          : `Guess "${h.pred ? 'taken' : 'not taken'}" was right. Penalty: 0 cycles.`;
      } else {
        title = 'Structural hazard (shared memory)';
        who = `${h.a.id} (${esc(h.a.text)}) uses memory in MEM while ${h.b.id} (${esc(h.b.text)}) wants to be fetched.`;
        cause = 'Only one memory port exists, so fetch and data access cannot happen together.';
        fix = 'Solved by delaying the fetch by one cycle (a bubble enters IF).';
      }
      return `<div class="hz ${h.type}"><h4>${title}</h4><p><b>Instructions:</b> ${who}</p><p><b>Cause:</b> ${cause}</p><p><b>Stall cycles so far:</b> ${st}</p><p><b>Solution:</b> ${fix}</p></div>`;
    }).join('');
  }

  function renderPerf() {
    const p = perf(sim, cur), st = sim.stats;
    const card = (l, v, s) => `<div class="card"><small>${l}</small><strong>${v}</strong>${s ? `<small>${s}</small>` : ''}</div>`;
    $('cards').innerHTML =
      card('Completed instructions', `${p.done} / ${p.n}`, 'finished WB so far') +
      card('Total cycles', p.T, `now at cycle ${cur}`) +
      card('Stall cycles', p.stall, `data ${st.data}, control ${st.control}, structural ${st.structural}`) +
      card('Ideal cycles', p.ideal, `n + k - 1 = ${p.n} + ${p.K} - 1`) +
      card('Speedup', p.speed.toFixed(2) + 'x', 'vs non-pipelined') +
      card('Efficiency', p.eff.toFixed(1) + '%', `speedup / ${p.K} stages`);
    $('compare').innerHTML = `<table class="cmp"><thead><tr><th>Model</th><th>Cycles</th><th>How it is calculated</th><th>CPI</th></tr></thead><tbody>
      <tr><td>Non-pipelined</td><td>${p.np}</td><td>${p.n} instructions &times; ${p.K} stages</td><td>${p.K}</td></tr>
      <tr><td>Ideal pipeline</td><td>${p.ideal}</td><td>${p.n} + ${p.K} &minus; 1 (no hazards)</td><td>${(p.ideal / p.n).toFixed(2)}</td></tr>
      <tr><td>This pipeline</td><td>${p.T}</td><td>ideal + ${p.stall} stall cycle(s)</td><td>${p.cpi.toFixed(2)}</td></tr></tbody></table>
      <p class="hint">Final register values from a normal run: ${final.R.map((v, i) => v ? `R${i}=${v}` : '').filter(Boolean).join(', ') || 'all zero'}.
      Stall breakdown counts can overlap slightly; total stall cycles = total &minus; ideal.</p>`;
  }

  /* ----- wiring ----- */
  function loadDemo(i) {
    const d = DEMOS[i];
    $('code').value = d.code;
    $('stages').value = d.cfg.stages; $('forward').checked = d.cfg.forward; $('autoStall').checked = d.cfg.autoStall;
    $('sharedMem').checked = d.cfg.sharedMem; $('branch').value = d.cfg.branch;
    document.querySelectorAll('#opsList input').forEach(x => { x.checked = DEFAULT_OPS.includes(x.value); });
    document.querySelectorAll('.demo').forEach((b, j) => b.classList.toggle('active', i === j));
    $('demoInfo').textContent = d.info;
    stopTimer(); if (build()) { setStatus(`Demo loaded. Cycle 1 shown. Use Next cycle or Run automatically.`); render(); }
  }

  $('demoBtns').innerHTML = DEMOS.map((d, i) => `<button class="demo" data-i="${i}">${d.name}</button>`).join('');
  $('demoBtns').addEventListener('click', e => { if (e.target.dataset.i) loadDemo(+e.target.dataset.i); });
  $('opsList').innerHTML = Object.keys(OPS).map(o => `<label><input type="checkbox" value="${o}" ${DEFAULT_OPS.includes(o) ? 'checked' : ''}> ${o}</label>`).join('');

  $('bStart').onclick = () => { if (build()) { setStatus('Simulation built. You are at cycle 1.'); render(); } };
  $('bNext').onclick = () => { stopTimer(); if (!sim) { if (!build()) return; } else if (cur < sim.total) cur++; render(); };
  $('bPrev').onclick = () => { stopTimer(); if (sim && cur > 1) cur--; render(); };
  $('bAuto').onclick = () => { if (!sim || cur >= sim.total) { if (!build()) return; } play(); };
  $('bPause').onclick = () => { stopTimer(); render(); };
  $('bResume').onclick = () => { if (sim && cur < sim.total) play(); };
  $('bReset').onclick = () => { stopTimer(); sim = null; cur = 0; showErrors([]); setStatus('Reset. Edit the program or press Start.'); render(); };
  ['code', 'stages', 'forward', 'autoStall', 'sharedMem', 'branch'].forEach(id => $(id).addEventListener('input', invalidate));
  $('opsList').addEventListener('change', invalidate);
  $('speed').addEventListener('change', () => { if (timer) play(); });

  loadDemo(0);
}
if (typeof module !== 'undefined') module.exports = { parseProgram, runFunctional, simulate, perf, DEMOS, DEFAULT_OPS };
