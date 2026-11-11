// Scripted Werewolf seat for the make.fun werewolf-agent-01 env.
// Every answer is a pure function of the game's view, the game number and MAKEFUN_TRIAL_SEED.
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

type Role = 'werewolf' | 'seer' | 'doctor' | 'villager';

interface LogEntry {
  seq: number;
  day: number;
  kind: string;
  seat?: number | null;
  target?: number | null;
  text?: string;
  died?: number | null;
  role?: Role | null;
  round?: number;
  order?: number[];
  tally?: { seat: number; votes: number }[];
}

interface Player { seat: number; name: string; alive: boolean; role: Role | null }

interface View {
  day: number;
  phase: string;
  you: { seat: number; name: string; role: Role; alive: boolean; partner: { seat: number; name: string; alive: boolean } | null };
  players: Player[];
  seerResults: { night: number; seat: number; werewolf: boolean }[] | null;
  lastProtect: { night: number; seat: number | null } | null;
  wolfVotes: { night: number; seat: number; target: number | null }[] | null;
  log: LogEntry[];
  outcome: unknown;
}

interface Pending { game: number; decision: string; options?: number[]; max_chars?: number; view: View }

type Act = { target: number | null } | { text: string } | { pass: true };

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? 'http://store:8080').replace(/\/+$/, '');
const SEED = process.env.MAKEFUN_TRIAL_SEED ?? '0';
const TRACE = process.env.BOT_TRACE ?? '';
const MAX_SAY = 480;

// ---------------------------------------------------------------- randomness keyed on the decision

function rnd(...keys: (string | number)[]): number {
  const h = createHash('sha256').update(`${SEED}|${keys.join('|')}`).digest();
  return h.readUInt32BE(0) / 4294967296;
}

function pick<T>(xs: T[], ...keys: (string | number)[]): T {
  return xs[Math.floor(rnd(...keys) * xs.length) % xs.length];
}

// ---------------------------------------------------------------- reading the table talk

interface Speech {
  day: number;
  round: number;
  seat: number;
  text: string;
  accuses: number[];
  defends: number[];
  seerClaim: boolean;
  docClaim: boolean;
  results: { seat: number; wolf: boolean }[];
}

const ACCUSE_RE = /\b(suspicious|suspect\w*|sus|wolf|wolves|werewolf|lying|liar|lie|exile|eliminate|deflect\w*|red flag|scum|vote (?:for|out|to exile|against)|voting (?:for|out)|push(?:ing)?|evasive|vague|defensive|dodg\w*|fake|counter-?claim\w*)\b/i;
const DEFEND_RE = /\b(trust\w*|clean|innocent|not a (?:were)?wolf|isn't a (?:were)?wolf|village-aligned|confirmed village|believe|credible|town|cleared|protect)\b/i;
const SEER_CLAIM_RE = /\b(?:i am|i'm|im)\s+(?:the\s+|actually\s+the\s+|the real\s+)?seer\b|\bseer here\b|\bi(?:'m| am) claiming seer\b|\bi (?:inspected|checked|investigated)\b|\bmy (?:inspection|check|result)s?\b|\bclaim(?:ing)? (?:the )?seer\b/i;
const DOC_CLAIM_RE = /\b(?:i am|i'm|im)\s+(?:the\s+|actually\s+the\s+)?doctor\b|\bdoctor here\b|\bi protected\b|\bclaim(?:ing)? (?:the )?doctor\b/i;
const CLEAN_RE = /\b(not a (?:were)?wolf|not (?:a |the )?werewolf|clean|innocent|a villager|is village|came back (?:as )?(?:village|clean|good)|is good|not wolf)\b/i;
const WOLF_RE = /\b(werewolf|wolf)\b/i;

function splitSentences(t: string): string[] {
  return t.split(/(?<=[.!?;])\s+/).filter((s) => s.length > 0);
}

function mentionsIn(sentence: string, names: Map<string, number>, self: number): number[] {
  const found: { seat: number; at: number }[] = [];
  for (const m of sentence.matchAll(/\bseats?\s*#?\s*([1-8])\b/gi)) found.push({ seat: Number(m[1]), at: m.index ?? 0 });
  for (const m of sentence.matchAll(/\bseats? [1-8](?:,? (?:and|or|&) |, )([1-8])\b/gi)) found.push({ seat: Number(m[1]), at: (m.index ?? 0) + 1 });
  for (const [name, seat] of names) {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    for (const m of sentence.matchAll(re)) found.push({ seat, at: m.index ?? 0 });
  }
  found.sort((a, b) => a.at - b.at);
  const out: number[] = [];
  for (const f of found) if (f.seat !== self && !out.includes(f.seat)) out.push(f.seat);
  return out;
}

function readSpeech(e: LogEntry, names: Map<string, number>): Speech {
  const seat = e.seat as number;
  const text = e.text ?? '';
  const s: Speech = { day: e.day, round: e.round ?? 1, seat, text, accuses: [], defends: [], seerClaim: SEER_CLAIM_RE.test(text), docClaim: DOC_CLAIM_RE.test(text), results: [] };
  for (const sent of splitSentences(text)) {
    const ms = mentionsIn(sent, names, seat);
    if (ms.length === 0) continue;
    const clean = CLEAN_RE.test(sent);
    const accuse = ACCUSE_RE.test(sent);
    if (s.seerClaim && (clean || WOLF_RE.test(sent))) {
      // A seer claimant's results: the first seat named in a sentence that reads like a result.
      const first = ms[0];
      if (!s.results.some((r) => r.seat === first)) s.results.push({ seat: first, wolf: !clean });
    }
    if (clean || (DEFEND_RE.test(sent) && !accuse)) {
      for (const m of ms) if (!s.defends.includes(m)) s.defends.push(m);
    } else if (accuse) {
      for (const m of ms) if (!s.accuses.includes(m)) s.accuses.push(m);
    }
  }
  return s;
}

// ---------------------------------------------------------------- the state of one game, from one view

interface Claim { seat: number; firstSeq: number; results: Map<number, boolean>; day: number }

class Game {
  v: View;
  game: number;
  me: number;
  role: Role;
  partner: number | null;
  names: Map<string, number>;
  alive: Set<number>;
  revealed: Map<number, Role>;
  speeches: Speech[] = [];
  votes: Map<number, { seat: number; target: number | null }[]> = new Map();
  exiles: { day: number; seat: number | null; role: Role | null }[] = [];
  nightDeaths: { day: number; seat: number | null; role: Role | null }[] = [];
  seerClaims: Map<number, Claim> = new Map();
  docClaims: Map<number, number> = new Map();
  myResults: Map<number, boolean> = new Map();

  constructor(game: number, v: View) {
    this.v = v;
    this.game = game;
    this.me = v.you.seat;
    this.role = v.you.role;
    this.partner = v.you.partner ? v.you.partner.seat : null;
    this.names = new Map();
    for (const p of v.players) if (p.name.length >= 2) this.names.set(p.name, p.seat);
    this.alive = new Set(v.players.filter((p) => p.alive).map((p) => p.seat));
    this.revealed = new Map();
    for (const p of v.players) if (p.role) this.revealed.set(p.seat, p.role);
    for (const r of v.seerResults ?? []) this.myResults.set(r.seat, r.werewolf);
    for (const e of v.log) {
      if (e.kind === 'speech') {
        const s = readSpeech(e, this.names);
        this.speeches.push(s);
        if (s.seerClaim && !this.docClaims.has(s.seat)) {
          let c = this.seerClaims.get(s.seat);
          if (!c) {
            c = { seat: s.seat, firstSeq: e.seq, results: new Map(), day: e.day };
            this.seerClaims.set(s.seat, c);
          }
          for (const r of s.results) c.results.set(r.seat, r.wolf);
        } else if (s.docClaim && !this.seerClaims.has(s.seat) && !this.docClaims.has(s.seat)) {
          this.docClaims.set(s.seat, e.seq);
        }
      } else if (e.kind === 'vote') {
        const list = this.votes.get(e.day) ?? [];
        list.push({ seat: e.seat as number, target: e.target ?? null });
        this.votes.set(e.day, list);
      } else if (e.kind === 'exile') {
        this.exiles.push({ day: e.day, seat: e.seat ?? null, role: e.role ?? null });
      } else if (e.kind === 'dawn') {
        this.nightDeaths.push({ day: e.day, seat: e.died ?? null, role: e.role ?? null });
      }
    }
  }

  name(s: number): string {
    return this.v.players.find((p) => p.seat === s)?.name ?? '?';
  }
  tag(s: number): string {
    return `seat ${s} (${this.name(s)})`;
  }
  living(): number[] {
    return [...this.alive].sort((a, b) => a - b);
  }
  others(): number[] {
    return this.living().filter((s) => s !== this.me);
  }
  isWolfTeam(s: number): boolean {
    return this.role === 'werewolf' && (s === this.me || s === this.partner);
  }
  key(...k: (string | number)[]): (string | number)[] {
    return [this.game, this.v.day, this.v.phase, ...k];
  }

  /** Whether a seer claim is broken by the revealed roles. */
  claimBroken(c: Claim): boolean {
    const r = this.revealed.get(c.seat);
    if (r && r !== 'seer') return true;
    for (const [s, wolf] of c.results) {
      const role = this.revealed.get(s);
      if (role && (role === 'werewolf') !== wolf) return true;
    }
    return false;
  }
  /** A claim the moderator confirmed: the claimant died as the seer. */
  claimProven(c: Claim): boolean {
    return this.revealed.get(c.seat) === 'seer';
  }
  liveSeerClaims(): Claim[] {
    return [...this.seerClaims.values()].filter((c) => this.alive.has(c.seat) && !this.claimBroken(c)).sort((a, b) => a.firstSeq - b.firstSeq);
  }

  /** Accusations aimed at a seat by others (recent days weigh more). */
  heat(target: number, exclude: number[] = []): number {
    let h = 0;
    for (const s of this.speeches) {
      if (s.seat === target || exclude.includes(s.seat) || !this.alive.has(s.seat) && this.revealed.get(s.seat) === 'werewolf') continue;
      const w = s.day === this.v.day ? 1 : s.day === this.v.day - 1 ? 0.6 : 0.3;
      if (s.accuses.includes(target)) h += w;
      if (s.defends.includes(target)) h -= 0.5 * w;
    }
    const today = this.votes.get(this.v.day) ?? [];
    const prev = this.votes.get(this.v.day - 1) ?? [];
    for (const vt of prev) if (vt.target === target && !exclude.includes(vt.seat)) h += 0.4;
    for (const vt of today) if (vt.target === target && !exclude.includes(vt.seat)) h += 0.8;
    return h;
  }

  /** Village-side suspicion of each living seat, from what this seat knows. Higher is more wolf-like. */
  suspicion(): Map<number, number> {
    const sc = new Map<number, number>();
    for (const s of this.others()) sc.set(s, 0);
    const add = (s: number, x: number) => {
      if (sc.has(s)) sc.set(s, (sc.get(s) as number) + x);
    };
    // My own inspections.
    for (const [s, wolf] of this.myResults) add(s, wolf ? 1000 : -1000);
    // Seer claims.
    const claims = [...this.seerClaims.values()].filter((c) => c.seat !== this.me);
    for (const c of claims) {
      if (this.claimProven(c)) {
        for (const [s, wolf] of c.results) add(s, wolf ? 500 : -300);
        continue;
      }
      if (this.claimBroken(c)) {
        add(c.seat, 400);
        continue;
      }
      if (this.role === 'seer') {
        add(c.seat, 600);
        continue;
      }
    }
    const live = this.liveSeerClaims().filter((c) => c.seat !== this.me);
    if (this.role !== 'seer') {
      if (live.length === 1) {
        const c = live[0];
        add(c.seat, -30);
        for (const [s, wolf] of c.results) add(s, wolf ? 60 : -25);
      } else if (live.length >= 2) {
        for (const c of live) {
          for (const [s, wolf] of c.results) add(s, wolf ? 12 : -5);
          // A claim made after the claimant was called a wolf by another claimant reads as a counter.
          for (const o of live) if (o !== c && o.results.get(c.seat) === true && o.firstSeq < c.firstSeq) add(c.seat, 25);
        }
        // A proven seer died: everyone else claiming seer lied.
      }
    }
    if ([...this.seerClaims.values()].some((c) => this.claimProven(c))) {
      for (const c of live) add(c.seat, 300);
    }
    // Doctor claims: mildly trusted unless broken.
    for (const [s] of this.docClaims) add(s, this.revealed.has(s) ? 0 : -8);
    // Exiles and the votes behind them.
    for (const x of this.exiles) {
      if (x.seat === null) continue;
      const vs = this.votes.get(x.day) ?? [];
      if (x.role === 'werewolf') {
        for (const vt of vs) {
          if (vt.target === x.seat) add(vt.seat, -6);
          else add(vt.seat, 5);
        }
        for (const s of this.speeches) {
          if (s.defends.includes(x.seat)) add(s.seat, 10);
          if (s.accuses.includes(x.seat) && s.day <= x.day) add(s.seat, -6);
        }
      } else {
        vs.forEach((vt, i) => {
          if (vt.target === x.seat) add(vt.seat, i < 3 ? 4 : 2);
        });
        for (const s of this.speeches) if (s.accuses.includes(x.seat) && s.day <= x.day) add(s.seat, 2);
      }
    }
    // Night victims were village; whom they accused was likely a reason to kill them.
    for (const d of this.nightDeaths) {
      if (d.seat === null) continue;
      for (const s of this.speeches) {
        if (s.seat !== d.seat) continue;
        for (const a of s.accuses) add(a, 4);
      }
      for (const s of this.speeches) if (s.accuses.includes(d.seat)) add(s.seat, 2);
    }
    // The crowd's heat, a weak signal that helps votes consolidate.
    for (const s of this.others()) add(s, 1.5 * this.heat(s));
    // Passing a lot is a mild tell.
    for (const s of this.speeches) void s;
    for (const e of this.v.log) if (e.kind === 'pass' && e.seat !== this.me) add(e.seat as number, 0.7);
    // Small seeded jitter for ties.
    for (const s of this.others()) add(s, rnd(this.game, 'jit', this.v.day, s) * 0.5);
    return sc;
  }
}

function ranked(sc: Map<number, number>): number[] {
  return [...sc.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map((x) => x[0]);
}

function trace(x: unknown): void {
  if (TRACE) {
    try {
      appendFileSync(TRACE, `${JSON.stringify(x)}\n`);
    } catch {
      /* tracing is best effort */
    }
  }
}

// ---------------------------------------------------------------- night decisions

function chooseKill(g: Game, options: number[]): number | null {
  if (options.length === 0) return null;
  const n = g.v.day;
  const votes = (g.v.wolfVotes ?? []).filter((w) => w.night === n && w.seat !== g.me);
  const partnerPick = votes.length > 0 ? votes[0].target : null;
  if (partnerPick !== null && options.includes(partnerPick)) return partnerPick;
  const sc = new Map<number, number>();
  const prevNight = (g.v.wolfVotes ?? []).filter((w) => w.night === n - 1 && w.target !== null);
  const prevTargets = new Set(prevNight.map((w) => w.target));
  const prevDawn = g.nightDeaths.find((d) => d.day === n - 1);
  const blocked = prevTargets.size === 1 && prevDawn && prevDawn.seat === null ? [...prevTargets][0] : null;
  const live = g.liveSeerClaims();
  for (const s of options) {
    let x = rnd(g.game, 'kill', n, s) * 3;
    if (s === blocked) x += 150;
    if (live.some((c) => c.seat === s)) x += 100;
    if (g.docClaims.has(s)) x += 50;
    for (const sp of g.speeches) {
      if (sp.seat !== s) continue;
      const w = sp.day >= n - 1 ? 1 : 0.5;
      if (sp.accuses.includes(g.me)) x += 12 * w;
      if (g.partner !== null && sp.accuses.includes(g.partner)) x += 12 * w;
    }
    for (const [, list] of g.votes) for (const vt of list) if (vt.seat === s && (vt.target === g.me || vt.target === g.partner)) x += 5;
    // Keep the village's favourite suspect alive: it is tomorrow's exile.
    x -= 6 * Math.min(4, g.heat(s, [g.me, g.partner ?? 0]));
    for (const c of g.seerClaims.values()) if (c.results.get(s) === false) x += 8;
    sc.set(s, x);
  }
  return ranked(sc)[0];
}

function chooseProtect(g: Game, options: number[]): number | null {
  if (options.length === 0) return null;
  const n = g.v.day;
  const sus = g.suspicion();
  const live = g.liveSeerClaims();
  const sc = new Map<number, number>();
  for (const s of options) {
    let x = rnd(g.game, 'protect', n, s) * 4;
    if (live.length > 0 && live[0].seat === s) x += 100;
    else if (live.some((c) => c.seat === s)) x += 40;
    x -= Math.max(0, sus.get(s) ?? 0) * 0.8;
    // Strong voices draw the kill.
    for (const sp of g.speeches) if (sp.seat === s && sp.day >= n - 1) x += 1.5 * sp.accuses.length;
    sc.set(s, x);
  }
  return ranked(sc)[0];
}

function chooseInspect(g: Game, options: number[]): number | null {
  const fresh = options.filter((s) => !g.myResults.has(s));
  const pool = fresh.length > 0 ? fresh : options;
  if (pool.length === 0) return null;
  const sus = g.suspicion();
  const sc = new Map<number, number>();
  for (const s of pool) {
    let x = rnd(g.game, 'inspect', g.v.day, s) * 4 + (sus.get(s) ?? 0);
    if (g.seerClaims.has(s)) x -= 30; // a rival claimant is a liar already
    if (g.docClaims.has(s)) x -= 6;
    for (const sp of g.speeches) if (sp.seat === s) x += 0.8 * sp.accuses.length;
    sc.set(s, x);
  }
  return ranked(sc)[0];
}

// ---------------------------------------------------------------- day votes

function tallyToday(g: Game): Map<number, number> {
  const t = new Map<number, number>();
  for (const vt of g.votes.get(g.v.day) ?? []) if (vt.target !== null) t.set(vt.target, (t.get(vt.target) ?? 0) + 1);
  return t;
}

function villageVote(g: Game, options: number[]): number | null {
  const sus = g.suspicion();
  const order = ranked(sus).filter((s) => options.includes(s));
  if (order.length === 0) return options[0] ?? null;
  const top = order[0];
  const topScore = sus.get(top) ?? 0;
  const t = tallyToday(g);
  // Join the leading wagon when it is on one of my near-top suspects, so the vote does not split.
  let lead: number | null = null;
  let leadVotes = 0;
  for (const [s, c] of t) if (c > leadVotes || (c === leadVotes && lead !== null && s < lead)) { lead = s; leadVotes = c; }
  if (lead !== null && lead !== top && options.includes(lead) && leadVotes >= 2 && topScore < 200) {
    const ls = sus.get(lead) ?? 0;
    const topVotes = t.get(top) ?? 0;
    if (ls >= topScore - 6 && ls > -20 && leadVotes > topVotes) return lead;
  }
  return top;
}

function wolfPushTarget(g: Game): number | null {
  const village = g.others().filter((s) => !g.isWolfTeam(s));
  if (village.length === 0) return null;
  const sc = new Map<number, number>();
  const live = g.liveSeerClaims();
  for (const s of village) {
    let x = 2 * g.heat(s, [g.me, g.partner ?? 0]) + rnd(g.game, 'push', g.v.day, s) * 1.5;
    // A seer claimant who named my side must go.
    const c = g.seerClaims.get(s);
    if (c && (c.results.get(g.me) === true || (g.partner !== null && c.results.get(g.partner) === true))) x += 8;
    else if (live.some((k) => k.seat === s)) x -= 3;
    for (const sp of g.speeches) {
      if (sp.seat !== s) continue;
      if (sp.accuses.includes(g.me)) x += 1.5;
      if (g.partner !== null && sp.accuses.includes(g.partner)) x += 1.5;
    }
    for (const c2 of g.seerClaims.values()) if (c2.results.get(s) === false && !g.isWolfTeam(c2.seat)) x -= 3;
    sc.set(s, x);
  }
  // Stay with yesterday's line when it still stands, for consistency.
  const mine = g.speeches.filter((sp) => sp.seat === g.me && sp.day === g.v.day);
  for (const sp of mine) for (const a of sp.accuses) if (sc.has(a)) sc.set(a, (sc.get(a) as number) + 3);
  return ranked(sc)[0];
}

function wolfVote(g: Game, options: number[]): number | null {
  const t = tallyToday(g);
  const order = g.v.log.filter((e) => e.kind === 'voting' && e.day === g.v.day).pop()?.order ?? g.living();
  const cast = (g.votes.get(g.v.day) ?? []).length;
  const myIdx = order.indexOf(g.me);
  const remaining = order.slice(myIdx + 1).filter((s) => !g.isWolfTeam(s)).length;
  const p = g.partner !== null && g.alive.has(g.partner) ? g.partner : null;
  const pv = p !== null ? t.get(p) ?? 0 : 0;
  let best: number | null = null;
  let bestV = 0;
  for (const [s, c] of t) {
    if (g.isWolfTeam(s) || !options.includes(s)) continue;
    if (c > bestV || (c === bestV && best !== null && s < best)) { best = s; bestV = c; }
  }
  void cast;
  // Partner already doomed: join to look clean.
  if (p !== null && options.includes(p) && pv > bestV + remaining + 1) return p;
  if (best !== null && bestV >= 1) return best;
  const push = wolfPushTarget(g);
  return push !== null && options.includes(push) ? push : options.find((s) => !g.isWolfTeam(s)) ?? null;
}

// ---------------------------------------------------------------- statements

function seatsWord(g: Game, xs: number[]): string {
  return xs.map((s) => g.tag(s)).join(', ');
}

function reasonAgainst(g: Game, s: number, k: string): string {
  const reasons: string[] = [];
  const said = g.speeches.filter((sp) => sp.seat === s);
  const passes = g.v.log.filter((e) => e.kind === 'pass' && e.seat === s).length;
  for (const x of g.exiles) {
    if (x.seat === null || x.role === 'werewolf') continue;
    const vs = g.votes.get(x.day) ?? [];
    if (vs.some((vt) => vt.seat === s && vt.target === x.seat)) reasons.push(`voted to exile ${g.tag(x.seat)} on day ${x.day}, who turned out to be a ${x.role}`);
  }
  for (const x of g.exiles) {
    if (x.seat === null || x.role !== 'werewolf') continue;
    const vs = g.votes.get(x.day) ?? [];
    const v = vs.find((vt) => vt.seat === s);
    if (v && v.target !== x.seat) reasons.push(`did not vote for the werewolf ${g.tag(x.seat)} on day ${x.day}`);
  }
  for (const sp of said) {
    const tgt = sp.accuses.find((a) => !g.isWolfTeam(a) && a !== g.me);
    if (tgt !== undefined && g.revealed.get(tgt) && g.revealed.get(tgt) !== 'werewolf') {
      reasons.push(`pushed hard on ${g.tag(tgt)}, a ${g.revealed.get(tgt)}`);
      break;
    }
  }
  if (passes > 0) reasons.push(passes > 1 ? `passed ${passes} times instead of helping` : 'passed instead of giving a read');
  if (said.length > 0 && said.every((sp) => sp.accuses.length === 0)) reasons.push('has not named a single suspect, just general talk');
  if (said.length === 0 && passes === 0) reasons.push('has given us nothing concrete');
  for (const sp of g.speeches) {
    if (sp.seat === s || !sp.accuses.includes(s)) continue;
    if (g.isWolfTeam(sp.seat)) continue;
    reasons.push(`was already called out by ${g.tag(sp.seat)}`);
    break;
  }
  const today = g.votes.get(g.v.day - 1) ?? [];
  const v = today.find((vt) => vt.seat === s);
  if (v && v.target !== null && g.alive.has(v.target) && v.target !== g.me) reasons.push(`voted for ${g.tag(v.target)} yesterday without a real case`);
  if (reasons.length === 0) reasons.push('keeps hedging and deflecting');
  const a = pick(reasons, g.game, k, 'r1', s);
  const rest = reasons.filter((r) => r !== a);
  return rest.length > 0 ? `${a}, and ${pick(rest, g.game, k, 'r2', s)}` : a;
}

function clip(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const chars = [...t];
  if (chars.length <= MAX_SAY) return t;
  const head = chars.slice(0, MAX_SAY).join('');
  const cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '));
  return cut > 100 ? head.slice(0, cut + 1) : head;
}

function seerSpeech(g: Game, round: number): string | null {
  const res = (g.v.seerResults ?? []).slice().sort((a, b) => a.night - b.night);
  const wolves = res.filter((r) => r.werewolf && g.alive.has(r.seat));
  const claimedAlready = g.speeches.some((sp) => sp.seat === g.me && /I am the seer/.test(sp.text));
  const rivals = [...g.seerClaims.values()].filter((c) => c.seat !== g.me && g.alive.has(c.seat));
  const accusedMe = g.speeches.filter((sp) => sp.day === g.v.day && sp.accuses.includes(g.me)).length;
  const shouldClaim = claimedAlready || wolves.length > 0 || rivals.length > 0 || g.v.day >= 2 || accusedMe >= 2;
  const k = g.key('seer', round);
  if (!shouldClaim) {
    if (round === 1) return pick([
      `Night 1 gave us a death and little else. I want everyone to name one suspect and a reason this round, so we can see who dodges. I'll share more once I have something solid.`,
      `Let's keep this concrete: each of us should name a suspect with a reason. Quiet players and people who only echo others are what I'm watching today.`,
    ], ...k);
    const sus = ranked(g.suspicion()).filter((s) => !g.myResults.has(s));
    const s = sus[0];
    return s !== undefined ? `My lean today is ${g.tag(s)}: they ${reasonAgainst(g, s, 'seerlean')}. I'd rather we all land on one name than split.` : null;
  }
  const parts: string[] = ['I am the seer.'];
  for (const r of res) parts.push(`Night ${r.night}: ${g.tag(r.seat)} is ${r.werewolf ? 'a WEREWOLF' : 'not a werewolf'}${g.alive.has(r.seat) ? '' : ' (now dead)'}.`);
  for (const c of rivals) parts.push(`${g.tag(c.seat)} claims seer too: that is a lie, so ${g.tag(c.seat)} is a werewolf.`);
  const tgt = wolves.length > 0 ? wolves[0].seat : rivals.length > 0 ? rivals[0].seat : null;
  if (tgt !== null) parts.push(`Everyone vote ${g.tag(tgt)} today; a split vote exiles nobody and helps the wolves.`);
  else {
    const sus = ranked(g.suspicion()).filter((s) => !g.myResults.has(s));
    if (sus.length > 0) parts.push(`My cleared seats are safe. Of the rest my strongest suspect is ${g.tag(sus[0])}, who ${reasonAgainst(g, sus[0], 'seerclaim')}.`);
  }
  if (round === 2 && tgt !== null) parts.push(`If I die tonight, my death proves these results.`);
  return parts.join(' ');
}

function villageSpeech(g: Game, round: number): string | null {
  const sus = g.suspicion();
  const order = ranked(sus);
  const top = order[0];
  if (top === undefined) return null;
  const k = g.key('vs', round);
  const live = g.liveSeerClaims().filter((c) => c.seat !== g.me);
  const proven = [...g.seerClaims.values()].find((c) => g.claimProven(c));
  const parts: string[] = [];
  // The doctor reveals only to escape a wagon.
  if (g.role === 'doctor' && round === 2) {
    const onMe = g.speeches.filter((sp) => sp.day === g.v.day && sp.accuses.includes(g.me)).length;
    if (onMe >= 3 || (onMe >= 2 && g.alive.size <= 5)) {
      const prot = g.v.lastProtect;
      parts.push(`I am the doctor${prot && prot.seat !== null ? `; night ${prot.night} I protected ${g.tag(prot.seat)}` : ''}. Exiling me hands the wolves the game.`);
    }
  }
  if (proven) {
    const wolves = [...proven.results].filter(([s, w]) => w && g.alive.has(s)).map(([s]) => s);
    if (wolves.length > 0) parts.push(`${g.tag(proven.seat)} died as the real seer and named ${seatsWord(g, wolves)} as a werewolf. That is confirmed, vote ${g.tag(wolves[0])}.`);
    const fakes = live.filter((c) => c.seat !== proven.seat);
    if (fakes.length > 0) parts.push(`${seatsWord(g, fakes.map((c) => c.seat))} claimed seer while the real seer was someone else: that is a wolf.`);
  } else if (live.length === 1 && (sus.get(live[0].seat) ?? 0) < 50) {
    const c = live[0];
    const w = [...c.results].filter(([s, x]) => x && g.alive.has(s)).map(([s]) => s);
    if (w.length > 0) parts.push(`I believe ${g.tag(c.seat)}'s seer claim and nobody has countered it. They named ${g.tag(w[0])} as a werewolf, so ${g.tag(w[0])} is my vote.`);
    else parts.push(`I take ${g.tag(c.seat)}'s seer claim seriously; doctor, keep them alive.`);
  } else if (live.length >= 2) {
    const bad = live.slice().sort((a, b) => (sus.get(b.seat) ?? 0) - (sus.get(a.seat) ?? 0))[0];
    parts.push(`Two seer claims: ${seatsWord(g, live.map((c) => c.seat))}. One is a wolf. I trust ${bad === live[0] ? g.tag(live[1].seat) : g.tag(live[0].seat)} more; ${g.tag(bad.seat)} looks like the fake.`);
  }
  for (const x of g.exiles) if (x.seat !== null && x.role === 'werewolf' && x.day === g.v.day - 1) {
    const defenders = g.speeches.filter((sp) => sp.defends.includes(x.seat as number) && g.alive.has(sp.seat) && sp.seat !== g.me).map((sp) => sp.seat);
    if (defenders.length > 0) parts.push(`${g.tag(defenders[0])} defended the wolf ${g.tag(x.seat)} yesterday; that matters.`);
  }
  const already = parts.join(' ').includes(`vote ${g.tag(top)}`) || parts.join(' ').includes(`${g.tag(top)} is my vote`);
  if (!already) {
    const sc = sus.get(top) ?? 0;
    if (sc >= 500) parts.push(`${g.tag(top)} is a werewolf. Vote them.`);
    else parts.push(`${round === 1 ? 'My read' : 'Where I land'}: ${g.tag(top)} ${reasonAgainst(g, top, `v${round}`)}. ${round === 2 ? `I'm voting ${g.tag(top)}; let's not split the vote.` : `Convince me otherwise, ${g.name(top)}.`}`);
  }
  if (g.v.day === 1 && round === 1 && parts.length === 1 && g.speeches.filter((sp) => sp.day === 1).length < 2) {
    return pick([
      `Nothing to go on yet, so let's make the talk count: name one suspect and a reason. Seer, if you found a wolf, say so plainly and we'll back you.`,
      `First day. I'd like every player to name a suspect with a reason; whoever dodges that is the one I'll look at. Seer, a wolf hit is worth sharing today.`,
    ], ...k);
  }
  return parts.join(' ');
}

function wolfSpeech(g: Game, round: number): string | null {
  const k = g.key('ws', round);
  const tgt = wolfPushTarget(g);
  const live = g.liveSeerClaims();
  const parts: string[] = [];
  const accusedMe = g.speeches.filter((sp) => sp.day === g.v.day && sp.accuses.includes(g.me) && sp.seat !== g.partner);
  // Someone claims seer and names my side: discredit them.
  const hostile = live.find((c) => !g.isWolfTeam(c.seat) && (c.results.get(g.me) === true || (g.partner !== null && c.results.get(g.partner) === true)));
  if (hostile) {
    const hit = hostile.results.get(g.me) === true ? g.me : (g.partner as number);
    parts.push(`${g.tag(hostile.seat)}'s "seer" claim is convenient: a wolf can say anything, and naming ${hit === g.me ? 'me' : g.tag(hit)} is exactly what a wolf trying to steer the vote would do.`);
    if (hit === g.me) parts.push(`I'm a villager and I'll prove it with my votes.`);
  }
  if (accusedMe.length > 0 && !hostile) {
    const a = accusedMe[0].seat;
    parts.push(`${g.tag(a)}, you've pointed at me with nothing behind it. I'm village.`);
  }
  if (g.v.day === 1 && round === 1 && g.speeches.filter((sp) => sp.day === 1).length < 2 && parts.length === 0) {
    return pick([
      `Nothing to go on yet, so let's make the talk count: name one suspect and a reason. Seer, if you found a wolf, say so plainly and we'll back you.`,
      `First day. Let's not waste it: everyone name one suspect with a reason, and watch who dodges. I'll follow the evidence, not the loudest voice.`,
    ], ...k);
  }
  if (tgt !== null) {
    parts.push(`${round === 1 ? 'My read today' : 'Where I land'}: ${g.tag(tgt)} ${reasonAgainst(g, tgt, `w${round}`)}. ${round === 2 ? `I'm voting ${g.tag(tgt)}; let's not split the vote.` : `I want to hear ${g.name(tgt)} explain that.`}`);
  }
  return parts.join(' ');
}

function speak(g: Game, round: number): string | null {
  if (g.role === 'werewolf') return wolfSpeech(g, round);
  if (g.role === 'seer') {
    const s = seerSpeech(g, round);
    if (s !== null) return s;
  }
  return villageSpeech(g, round);
}

// ---------------------------------------------------------------- one decision

function roundOf(v: View): number {
  let round = 1;
  for (let i = v.log.length - 1; i >= 0; i -= 1) {
    const e = v.log[i];
    if (e.kind === 'debate') break;
    if ((e.kind === 'speech' || e.kind === 'pass') && e.day === v.day) {
      // my turn comes once a cycle: count my own turns today
    }
  }
  const mine = v.log.filter((e) => (e.kind === 'speech' || e.kind === 'pass') && e.day === v.day && e.seat === v.you.seat).length;
  round = mine + 1;
  return round;
}

export function decide(p: Pending): Act {
  const g = new Game(p.game, p.view);
  const opts = p.options ?? [];
  switch (p.decision) {
    case 'kill':
      return { target: chooseKill(g, opts) };
    case 'protect':
      return { target: chooseProtect(g, opts) };
    case 'inspect':
      return { target: chooseInspect(g, opts) };
    case 'vote':
      return { target: g.role === 'werewolf' ? wolfVote(g, opts) : villageVote(g, opts) };
    case 'speak': {
      const text = speak(g, roundOf(p.view));
      if (text === null || text.trim().length === 0) return { pass: true };
      return { text: clip(text) };
    }
  }
  return { target: null };
}

function fallback(p: Pending): Act {
  if (p.decision === 'speak') return { pass: true };
  if (p.decision === 'vote' || p.decision === 'kill') return { target: null };
  return { target: (p.options ?? [])[0] ?? null };
}

// ---------------------------------------------------------------- the run

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, body: json };
    } catch (err) {
      if (attempt > 200) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function main(): Promise<void> {
  for (;;) {
    const r = await post('/observe', {});
    if (r.status !== 200 || r.body === null) {
      await new Promise((res) => setTimeout(res, 300));
      continue;
    }
    const obs = r.body as { done: boolean; pending: Pending[] };
    if (obs.done) return;
    for (const p of obs.pending) {
      let a: Act;
      try {
        a = decide(p);
      } catch (err) {
        trace({ game: p.game, error: String((err as Error)?.stack ?? err) });
        a = fallback(p);
      }
      trace({ game: p.game, day: p.view.day, decision: p.decision, role: p.view.you.role, act: a });
      const res = await post('/act', { game: p.game, decision: p.decision, ...a });
      if (res.status !== 200 && res.status !== 409) {
        trace({ game: p.game, refused: res.body });
        await post('/act', { game: p.game, decision: p.decision, ...fallback(p) });
      }
    }
  }
}

if (process.env.BOT_NO_RUN !== '1') {
  main().then(
    () => process.exit(0),
    (err) => {
      process.stderr.write(`${String(err)}\n`);
      process.exit(1);
    },
  );
}
