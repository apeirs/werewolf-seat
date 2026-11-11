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
const VARIANT = process.env.BOT_VARIANT ?? '';
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

const ACCUSE_RE = /\b(suspicious|suspect\w*|sus|wolf|werewolf|lying|liar|deflect\w*|red flag|scum|vote (?:for|out|to exile|against)|voting (?:for|out)|voting \w+ today|vote \w+ today|lean(?:ing)? (?:toward|towards|on)|my (?:lean|read) is|evasive|dodg\w*|fake|counter-?claim\w*|doesn't add up|concern\w*)\b/i;
const RESULT_RE = /\b(inspect\w*|check\w*|result|came back|(?:is|are|was) (?:a |NOT a |not a )?(?:were)?wolf|NOT a)\b/i;
const HINT_RE = /\b(?:holding|have|hold|got) (?:some |important |key |useful )?(?:information|info)\b|\bi (?:know|learned) something\b/i;
const NO_INFO_RE = /\bno (?:real |special |night |reliable |direct |hard )?(?:information|info)\b/i;
const DEFEND_RE = /\b(trust\w*|clean|innocent|not a (?:were)?wolf|isn't a (?:were)?wolf|village-aligned|confirmed village|believe|credible|town|cleared|protect)\b/i;
const SEER_CLAIM_RE = /\b(?:i am|i'm|im)\s+(?:the\s+|actually\s+the\s+|the real\s+)?seer\b|\bseer here\b|\bi(?:'m| am) claiming seer\b|\bi (?:inspected|investigated)\b|\bi checked (?:seat \d|\w+ (?:on|last) night)|\bmy (?:inspection|seer result)s?\b|\bclaim(?:ing)? (?:the )?seer\b/i;
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
    if (s.seerClaim && (clean || WOLF_RE.test(sent)) && RESULT_RE.test(sent)) {
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
  /** Night (day number) to the seat a doctor claimant said they protected. */
  docSaid: Map<number, number> = new Map();
  /** Seats that hinted at hidden information without claiming. */
  hinters: Set<number> = new Set();

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
        if (s.docClaim && !s.seerClaim) {
          // "I protected X" on day d reports night d.
          const m = /\bprotected ([^.,;]*)/i.exec(s.text);
          if (m) {
            const who = mentionsIn(m[1], this.names, s.seat)[0];
            if (who !== undefined) this.docSaid.set(e.day, who);
          }
        }
        if (HINT_RE.test(s.text) && !NO_INFO_RE.test(s.text) && !s.seerClaim) this.hinters.add(s.seat);
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
  /** The checks this seat announced as a (claimed) seer, read back from its own statements. */
  announced(): Map<number, { seat: number; wolf: boolean }> {
    const out = new Map<number, { seat: number; wolf: boolean }>();
    for (const sp of this.speeches) {
      if (sp.seat !== this.me) continue;
      for (const m of sp.text.matchAll(/Night (\d+): seat (\d) \([^)]*\) is (a WEREWOLF|not a werewolf)/g)) {
        out.set(Number(m[1]), { seat: Number(m[2]), wolf: m[3] === 'a WEREWOLF' });
      }
    }
    return out;
  }
  iClaimedSeer(): boolean {
    return this.speeches.some((sp) => sp.seat === this.me && /\bI am the seer\b/.test(sp.text));
  }
  myTurnsToday(): number {
    return this.v.log.filter((e) => (e.kind === 'speech' || e.kind === 'pass') && e.day === this.v.day && e.seat === this.me).length;
  }
  saidToday(): Speech[] {
    return this.speeches.filter((sp) => sp.day === this.v.day && sp.seat !== this.me);
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
  const live = g.liveSeerClaims().filter((c) => !g.isWolfTeam(c.seat));
  const seer = live.length > 0 ? live[0].seat : null;
  // The doctor said they guarded the seer last night: tonight they cannot, so the seer is open.
  const seerOpen = seer !== null && (g.docSaid.get(n - 1) === seer || blocked === seer);
  const docs = [...g.docClaims.keys()].filter((s) => options.includes(s));
  for (const s of options) {
    let x = rnd(g.game, 'kill', n, s) * 3;
    if (s === blocked) x += 150;
    if (s === seer) x += seerOpen ? 220 : 100;
    else if (live.some((c) => c.seat === s)) x += 60;
    // With a seer to guard, the doctor guards them: the doctor themself is the sure kill.
    if (docs.includes(s)) x += seer !== null && !seerOpen ? 130 : 50;
    if (g.hinters.has(s)) x += 70;
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
  // Day 1 with nothing real to go on: a lone vote can exile a random villager, so hold it.
  if (g.v.day === 1 && topScore < 6 && (t.get(top) ?? 0) === 0) return null;
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
  const mine = t.get(g.me) ?? 0;
  // Partner already doomed: join to look clean.
  if (p !== null && options.includes(p) && pv > bestV + remaining + 1 && mine < pv) return p;
  // A seer (real) naming my side: vote the seer, and so does my fake-seer story.
  const hostile = hostileSeer(g);
  if (hostile !== null && options.includes(hostile)) return hostile;
  if (g.iClaimedSeer()) {
    const rival = g.liveSeerClaims().find((c) => c.seat !== g.me && !g.isWolfTeam(c.seat));
    if (rival && options.includes(rival.seat)) return rival.seat;
  }
  // My side leads: put my vote where it ties or overtakes.
  if (Math.max(pv, mine) > bestV) {
    if (best !== null) return best;
    const push = wolfPushTarget(g);
    return push !== null && options.includes(push) ? push : null;
  }
  if (best !== null && (bestV >= 2 || (bestV >= 1 && g.v.day >= 2))) return best;
  if (g.v.day === 1) return null;
  const push = wolfPushTarget(g);
  return push !== null && options.includes(push) ? push : null;
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
  if (said.length > 1 && said.every((sp) => sp.accuses.length === 0)) reasons.push("haven't named a single suspect in all their statements");
  if (said.length === 0 && passes === 0) reasons.push("haven't given us anything concrete");
  for (const sp of g.speeches) {
    if (sp.seat === s || !sp.accuses.includes(s)) continue;
    if (g.isWolfTeam(sp.seat) || sp.seat === g.me) continue;
    reasons.push(`were already called out by ${g.name(sp.seat)} and never really answered`);
    break;
  }
  const today = g.votes.get(g.v.day - 1) ?? [];
  const v = today.find((vt) => vt.seat === s);
  if (v && v.target !== null && g.alive.has(v.target) && v.target !== g.me) reasons.push(`voted for ${g.tag(v.target)} yesterday without giving a real case`);
  if (v && v.target === null && g.v.day >= 2) reasons.push('abstained yesterday instead of committing');
  if (reasons.length === 0) reasons.push('keep agreeing with everyone without committing to any read');
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
    const dl = round === 1 ? deathLine(g) : '';
    return `${intro(g, k)} ${dl} ${pick([
      `No hard read from me yet. I'd like each of us to name one concrete suspect with a reason this round, so we can see who dodges.`,
      `Nothing solid to go on yet, so I won't push anyone on vibes. Let's hear concrete reads from the quieter seats.`,
    ], ...k)}`;
  }
  const opening = claimedAlready
    ? 'I am the seer, as I said.'
    : wolves.length > 0
      ? `${g.name(g.me)} here: I am the seer, and I'm revealing because I found a wolf.`
      : `${g.name(g.me)} here: I am the seer. I'm sharing my checks now so they aren't lost if I die.`;
  const parts: string[] = [opening];
  for (const r of res) {
    const why = r.night === 1 && !claimedAlready ? ' (night 1 was a blind pick, I had nothing else to go on)' : '';
    parts.push(`Night ${r.night}: ${g.tag(r.seat)} is ${r.werewolf ? 'a WEREWOLF' : 'not a werewolf'}${g.alive.has(r.seat) ? '' : ' (now dead)'}${why}.`);
  }
  for (const c of rivals) parts.push(`${g.name(c.seat)} also claims seer, but I am the seer, so ${g.tag(c.seat)} is lying, and only a wolf lies about that.`);
  const tgt = wolves.length > 0 ? wolves[0].seat : rivals.length > 0 ? rivals[0].seat : null;
  if (tgt !== null) {
    if (round === 1) parts.push(`Exile ${g.tag(tgt)} today: the role is revealed when they go, so if ${g.name(tgt)} flips villager, exile me tomorrow. A wolf could not offer you that test.`);
    else {
      const denied = g.saidToday().some((sp) => sp.seat === tgt);
      parts.push(`${denied ? `${g.name(tgt)}'s denial answers nothing; every wolf says villager. ` : ''}I'm voting ${g.tag(tgt)}, and a split vote only helps the wolves. If I die tonight, my death proves these results. Doctor, guard me.`);
    }
  } else {
    const sus = ranked(g.suspicion()).filter((s) => !g.myResults.has(s));
    if (sus.length > 0) parts.push(`My cleared players are safe to trust. Of the rest, my strongest suspect is ${g.tag(sus[0])}: they ${reasonAgainst(g, sus[0], 'seerclaim')}. I'll check another player tonight.`);
  }
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
    if (w.length > 0) parts.push(`I believe ${g.tag(c.seat)}'s seer claim and nobody has countered it. They named ${g.tag(w[0])} as a werewolf, so ${g.tag(w[0])} is my vote. Exiling ${g.name(w[0])} is a safe test: the role is revealed, and if it's a villager, ${g.name(c.seat)} goes next.`);
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
  const sc = sus.get(top) ?? 0;
  if (!already && sc >= 6) {
    if (sc >= 500) parts.push(`${g.tag(top)} is a werewolf. Vote them.`);
    else parts.push(`${round === 1 ? 'My lean is' : "I'm voting"} ${g.tag(top)}: they ${reasonAgainst(g, top, `v${round}`)}. ${round === 2 ? `Let's not split the vote.` : `${g.name(top)}, I'd like a concrete answer.`}`);
  }
  const head = [intro(g, k)];
  if (round === 1 && deathLine(g)) head.push(deathLine(g));
  if (parts.length === 0) {
    parts.push(pick([
      `No hard read yet, so I won't push anyone on vibes. Seer, if you have a wolf check, share it with your reasons and we'll test it with the exile.`,
      `Nothing solid so far. I'd like every player to give one concrete read; the seer's checks matter most, and an exile reveals the role, so a claim can be tested.`,
    ], ...k, 'calm'));
  }
  return [...head, ...parts].join(' ');
}

/** A living seer claimant outside my team whose results name my side as a werewolf. */
function hostileSeer(g: Game): number | null {
  if (g.role !== 'werewolf') return null;
  for (const c of g.liveSeerClaims()) {
    if (g.isWolfTeam(c.seat)) continue;
    if (c.results.get(g.me) === true) return c.seat;
    if (g.partner !== null && g.alive.has(g.partner) && c.results.get(g.partner) === true) return c.seat;
  }
  return null;
}

function intro(g: Game, k: (string | number)[]): string {
  return pick([`${g.name(g.me)} here.`, `${g.name(g.me)} here, speaking plainly.`, `This is ${g.name(g.me)}.`], ...k, 'intro');
}

function deathLine(g: Game): string {
  const d = g.nightDeaths.find((x) => x.day === g.v.day);
  if (!d) return '';
  if (d.seat === null) return 'Nobody died last night, so the doctor probably made a save.';
  return `${g.name(d.seat)} was killed last night and was a ${d.role}.`;
}

/** The fake seer record a wolf reads out: past announcements kept, new nights filled in. */
function fakeChecks(g: Game, rival: number | null): { night: number; seat: number; wolf: boolean }[] {
  const said = g.announced();
  const used = new Set([...said.values()].map((c) => c.seat));
  const out: { night: number; seat: number; wolf: boolean }[] = [];
  const rivalNamed = rival !== null && [...said.values()].some((c) => c.seat === rival && c.wolf);
  const lastNight = g.v.day;
  for (let n = 1; n <= lastNight; n += 1) {
    const prev = said.get(n);
    if (prev) {
      out.push({ night: n, seat: prev.seat, wolf: prev.wolf });
      continue;
    }
    if (rival !== null && !rivalNamed && n === lastNight && !used.has(rival)) {
      out.push({ night: n, seat: rival, wolf: true });
      used.add(rival);
      continue;
    }
    // A clean check on a villager the table already trusts, so nothing contradicts it.
    const pool = g.living().filter((s) => !g.isWolfTeam(s) && s !== rival && !used.has(s));
    if (pool.length === 0) continue;
    const sc = new Map<number, number>();
    for (const s of pool) sc.set(s, -g.heat(s, [g.me, g.partner ?? 0]) + rnd(g.game, 'fake', n, s));
    const s = ranked(sc)[0];
    used.add(s);
    out.push({ night: n, seat: s, wolf: false });
  }
  return out;
}

function fakeSeerSpeech(g: Game, round: number, rival: number | null): string {
  const first = !g.iClaimedSeer();
  const checks = fakeChecks(g, rival);
  const parts: string[] = [first ? `I am the seer. I kept it quiet to survive the night, but I can't stay silent now.` : `I am the seer, and my results stand.`];
  for (const c of checks) parts.push(`Night ${c.night}: ${g.tag(c.seat)} is ${c.wolf ? 'a WEREWOLF' : 'not a werewolf'}.`);
  const target = rival !== null && g.alive.has(rival) ? rival : checks.find((c) => c.wolf && g.alive.has(c.seat))?.seat ?? null;
  if (target !== null) {
    parts.push(`${g.name(target)} is claiming seer to get ahead of my result and push a villager out. Exile ${g.tag(target)}: the role is revealed when they go, so if they flip villager, exile me tomorrow.`);
    if (round === 2) parts.push(`Two claims means one wolf; I'm the one offering you a test. Doctor, guard me tonight.`);
  }
  return parts.join(' ');
}

function wolfSpeech(g: Game, round: number): string | null {
  const k = g.key('ws', round);
  const hostile = hostileSeer(g);
  if (g.iClaimedSeer() || (hostile !== null && VARIANT !== 'noclaim')) {
    const rival = hostile ?? g.liveSeerClaims().find((c) => c.seat !== g.me && !g.isWolfTeam(c.seat))?.seat ?? null;
    return fakeSeerSpeech(g, round, rival);
  }
  const parts: string[] = [intro(g, k)];
  const dl = round === 1 ? deathLine(g) : '';
  if (dl) parts.push(dl);
  const live = g.liveSeerClaims().filter((c) => c.seat !== g.me);
  const accusers = g.saidToday().filter((sp) => sp.accuses.includes(g.me) && sp.seat !== g.partner).map((sp) => sp.seat);
  if (accusers.length > 0) {
    parts.push(pick([
      `${g.name(accusers[0])}, I hear you, but there is no check and no vote behind that. I'm a plain villager and my votes are on the record.`,
      `${g.name(accusers[0])}, that read on me has nothing concrete behind it. I'm a villager; check my votes, they've followed the evidence.`,
    ], ...k, 'def'));
  }
  // Back my partner's claim, or ride a real seer who has not touched my side.
  const pc = live.find((c) => c.seat === g.partner);
  if (pc) {
    const w = [...pc.results].find(([s, x]) => x && g.alive.has(s));
    parts.push(w ? `${g.name(pc.seat)}'s claim is specific and nobody has given a reason to doubt it. ${g.tag(w[0])} should answer it, and I'll vote on it.` : `${g.name(pc.seat)}'s claim is the most concrete thing we have; I'm taking it seriously.`);
  } else if (live.length === 1) {
    const c = live[0];
    const w = [...c.results].find(([s, x]) => x && g.alive.has(s) && !g.isWolfTeam(s));
    parts.push(w ? `${g.name(c.seat)}'s check on ${g.tag(w[0])} is the only hard information we have, so I'll vote with it unless ${g.name(w[0])} gives us something real.` : `${g.name(c.seat)}'s claim is specific, so I'll take it seriously for now.`);
  }
  const tgt = wolfPushTarget(g);
  const tgtHeat = tgt !== null ? g.heat(tgt, [g.me, g.partner ?? 0]) : 0;
  if (tgt !== null && (g.v.day >= 2 || tgtHeat >= 1.5) && !parts.join(' ').includes(g.tag(tgt))) {
    const reason = reasonAgainst(g, tgt, `w${round}`);
    parts.push(round === 1 ? `My lean is ${g.tag(tgt)}: they ${reason}. ${g.name(tgt)}, I'd like a concrete answer to that.` : `I'm leaning ${g.tag(tgt)}: they ${reason}. Unless they give a real answer, that's my vote.`);
  } else if (parts.length <= 2) {
    parts.push(pick([
      `I'm a plain villager with no night information. I'd rather hear concrete reads than vote on vibes, and I'll be watching who pushes a vote without a reason.`,
      `No night information from me, I'm a villager. Nothing so far is solid enough to exile on, so I want each of us to give one concrete read before the vote.`,
      `I'm a villager and have nothing hidden to share. Let's keep it to checkable reasons; whoever pushes hardest with nothing behind it is who I'll look at.`,
    ], ...k, 'calm'));
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
      trace({ game: p.game, day: p.view.day, decision: p.decision, role: p.view.you.role, act: a, p });
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
