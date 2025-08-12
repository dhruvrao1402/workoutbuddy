import { useEffect, useMemo, useState } from "react";
import { supabase } from './lib/supabase';
// ------------------------------
// WorkoutBuddy — Phone-first MVP (Local-first; Supabase-ready)
// - Tabs: Today / Goals / History / Templates
// - 1-tap logging, auto-metrics, simple suggestions
// - Tailwind for styling; no external deps
// ------------------------------

// Types
export type Units = "kg" | "lb";
export type RIR = 0 | 1 | 2 | 3 | 4;

export type Exercise = {
  id: string;
  name: string;
  group: "upper" | "lower" | "full" | "mobility";
  isBodyweight?: boolean; // e.g., Pull-up, Push-up, Dips
  defaultIncrement: number; // 2.5 kg
  loadFactor?: number; // bodyweight % for calisthenics (e.g., push-up ~0.65)
};

export type SetEntry = {
  id: string;
  sessionId: string;
  exerciseId: string;
  weight: number; // external load in kg; for bodyweight lifts, this is extra load (+) or assistance (-)
  reps: number;
  rir: RIR;
  isWarmup?: boolean;
  timestamp: number;
};

export type Session = {
  id: string;
  date: string; // YYYY-MM-DD
  templateDay?: string; // e.g., "Legs A" / "Push" / "Pull" / "Legs B" / "Mobility"
  notes?: string;
  fatigue?: number; // 1-5 subjective
};

export type Goal = {
  id: string;
  label: string; // e.g., "Pull-ups @BW 15 reps"
  metric: "e1rm" | "reps" | "volume" | "waist_cm" | "weight_kg" | "mobility";
  exerciseId?: string; // when applicable
  target: number;
  current?: number;
  unit?: string;
};

// ---------- Defaults ----------
const DEFAULT_INCREMENT = 2.5;

const EXERCISES: Exercise[] = [
  // Upper — bodyweight strength emphasis
  { id: "pullup", name: "Pull-up (BW)", group: "upper", isBodyweight: true, defaultIncrement: DEFAULT_INCREMENT, loadFactor: 1.0 },
  { id: "chinup", name: "Chin-up (BW)", group: "upper", isBodyweight: true, defaultIncrement: DEFAULT_INCREMENT, loadFactor: 1.0 },
  { id: "dip", name: "Dip (BW)", group: "upper", isBodyweight: true, defaultIncrement: DEFAULT_INCREMENT, loadFactor: 0.95 },
  { id: "pushup", name: "Push-up (BW)", group: "upper", isBodyweight: true, defaultIncrement: DEFAULT_INCREMENT, loadFactor: 0.65 },
  { id: "pike_pushup", name: "Pike Push-up (BW)", group: "upper", isBodyweight: true, defaultIncrement: DEFAULT_INCREMENT, loadFactor: 0.7 },
  { id: "inverted_row", name: "Inverted Row (BW)", group: "upper", isBodyweight: true, defaultIncrement: DEFAULT_INCREMENT, loadFactor: 0.6 },
  { id: "ohp", name: "Overhead Press", group: "upper", defaultIncrement: DEFAULT_INCREMENT },
  { id: "row", name: "Barbell Row", group: "upper", defaultIncrement: DEFAULT_INCREMENT },
  { id: "bench", name: "Bench Press", group: "upper", defaultIncrement: DEFAULT_INCREMENT },

  // Lower — anterior & posterior options
  { id: "front_squat", name: "Front Squat", group: "lower", defaultIncrement: DEFAULT_INCREMENT },
  { id: "squat", name: "Back Squat", group: "lower", defaultIncrement: DEFAULT_INCREMENT },
  { id: "bulgarian", name: "Bulgarian Split Squat", group: "lower", defaultIncrement: DEFAULT_INCREMENT },
  { id: "leg_press", name: "Leg Press", group: "lower", defaultIncrement: DEFAULT_INCREMENT },
  { id: "leg_ext", name: "Leg Extension", group: "lower", defaultIncrement: DEFAULT_INCREMENT },
  { id: "tibialis_raise", name: "Tibialis Raise", group: "lower", defaultIncrement: DEFAULT_INCREMENT },
  { id: "calf", name: "Standing Calf Raise", group: "lower", defaultIncrement: DEFAULT_INCREMENT },

  { id: "rdl", name: "Romanian Deadlift", group: "lower", defaultIncrement: DEFAULT_INCREMENT },
  { id: "hip_thrust", name: "Hip Thrust", group: "lower", defaultIncrement: DEFAULT_INCREMENT },
  { id: "nordic_curl", name: "Nordic Ham Curl (BW)", group: "lower", isBodyweight: true, defaultIncrement: DEFAULT_INCREMENT, loadFactor: 0.4 },
  { id: "back_ext", name: "Back Extension (BW)", group: "lower", isBodyweight: true, defaultIncrement: DEFAULT_INCREMENT, loadFactor: 0.4 },

  // Accessories
  { id: "lpull", name: "Lat Pulldown", group: "upper", defaultIncrement: DEFAULT_INCREMENT },
  { id: "mob_flow", name: "Mobility Flow", group: "mobility", defaultIncrement: DEFAULT_INCREMENT },
];

const DEFAULT_GOALS: Goal[] = [
  { id: "g_pullups", label: "Pull-ups @BW — 15 reps", metric: "reps", exerciseId: "pullup", target: 15, unit: "reps" },
  { id: "g_squat_e1rm", label: "Back Squat e1RM — 140 kg", metric: "e1rm", exerciseId: "squat", target: 140, unit: "kg" },
  { id: "g_calf", label: "Calf Raises — 60 total reps (heavy)", metric: "reps", exerciseId: "calf", target: 60, unit: "reps" },
  { id: "g_mob", label: "Mobility — 40 min dedicated", metric: "mobility", target: 40, unit: "min" },
];

// ---------- Utilities ----------
const uid = () => Math.random().toString(36).slice(2);

const todayISO = () => new Date().toISOString().slice(0, 10);

function toNumberSafe(val: string): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

function epleyE1RM(loadKg: number, reps: number): number {
  if (reps <= 1) return loadKg;
  return loadKg * (1 + reps / 30);
}

// For bodyweight movements: effective load = (BW * factor) + external load (can be negative for assistance)
function effectiveLoadKg(ex: Exercise, bodyweightKg: number, externalLoadKg: number): number {
  if (!ex.isBodyweight) return externalLoadKg;
  const factor = ex.loadFactor ?? 1.0;
  return bodyweightKg * factor + externalLoadKg;
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

// Suggestion rules (auto-regulated, simple)
function suggestNext(ex: Exercise, lastSets: SetEntry[]) {
  if (lastSets.length === 0) return { advice: "Start conservative: pick a load you can do ~8 reps with RIR 2.", nextWeight: null, nextReps: 8 };

  const recent = lastSets[lastSets.length - 1];
  const reps = recent.reps;
  const rir = recent.rir;
  const weight = recent.weight;

  // Heuristics
  if (rir >= 3) {
    const inc = ex.defaultIncrement || DEFAULT_INCREMENT;
    return { advice: `Looked easy (RIR ${rir}). Add +${inc} kg or +2 reps.`, nextWeight: weight + inc, nextReps: reps };
  }
  if (rir <= 1) {
    return { advice: `Near limit (RIR ${rir}). Hold weight, add +1 rep across sets.`, nextWeight: weight, nextReps: reps + 1 };
  }
  return { advice: `Solid set. Keep weight, match reps or add +1 if form was clean.`, nextWeight: weight, nextReps: reps + 1 };
}

// ---------- Dev sanity tests (run once in dev) ----------
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isDev = typeof import.meta !== 'undefined' && (import.meta as any).env && (import.meta as any).env.DEV;
  if (isDev) {
    const approx = (a: number, b: number, eps = 0.2) => Math.abs(a - b) < eps;
    console.assert(approx(epleyE1RM(100, 10), 133.33), 'e1RM calc failed');
    const bwEx: Exercise = { id: 'pullup', name: 'Pull-up (BW)', group: 'upper', isBodyweight: true, defaultIncrement: 2.5, loadFactor: 1 };
    console.assert(effectiveLoadKg(bwEx, 75, 0) === 75, 'effectiveLoadKg failed for BW');
    const ex: Exercise = { id: 'bench', name: 'Bench', group: 'upper', defaultIncrement: 2.5 } as Exercise;
    const s: SetEntry = { id: '1', sessionId: 's', exerciseId: 'bench', weight: 60, reps: 8, rir: 3, timestamp: Date.now() } as SetEntry;
    const sug = suggestNext(ex, [s]);
    console.assert(sug.nextWeight === 62.5, 'suggestNext increment failed');
    const ps = parseScheme('3×6–10 @ RIR2');
    console.assert(ps.sets === 3 && ps.repText.includes('6–10') && ps.rirText === '@ RIR 2', 'parseScheme failed');
  }
} catch { /* ignore in prod */ }

// Local storage helpers
const LS_KEY = "workoutbuddy_v1";

type Persisted = {
  sessions: Session[];
  sets: SetEntry[];
  goals: Goal[];
  bodyweightKg: number;
  units: Units;
  baselineMode: boolean; // week 1: collect loads/reps only
};

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) throw new Error("empty");
    return JSON.parse(raw);
  } catch {
    return { sessions: [], sets: [], goals: DEFAULT_GOALS, bodyweightKg: 75, units: "kg", baselineMode: true };
  }
}

function savePersisted(p: Persisted) {
  localStorage.setItem(LS_KEY, JSON.stringify(p));
}

// ---------- Component ----------
export default function WorkoutBuddyApp() {
  const [tab, setTab] = useState<"today" | "goals" | "history" | "templates">("today");
  const [data, setData] = useState<Persisted>(loadPersisted());

  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const currentSession = useMemo(() => data.sessions.find(s => s.id === currentSessionId) || null, [data.sessions, currentSessionId]);
  const sessionSets = useMemo(() => data.sets.filter(s => s.sessionId === currentSessionId), [data.sets, currentSessionId]);

  useEffect(() => savePersisted(data), [data]);

  // Start or continue session
  function ensureSession(label?: string) {
    if (currentSessionId) return;
    const id = uid();
    const newSession: Session = { id, date: todayISO(), templateDay: label };
    setData(d => ({ ...d, sessions: [newSession, ...d.sessions] }));
    setCurrentSessionId(id);
  }

  function endSession() {
    setCurrentSessionId(null);
  }

  // Add set (fallback quick logger)
  const [form, setForm] = useState<{ exerciseId: string; weight: string; reps: string; rir: string; isWarmup: boolean }>({
    exerciseId: "pullup",
    weight: "0",
    reps: "8",
    rir: "2",
    isWarmup: false,
  });

  function addSet() {
    if (!currentSessionId) ensureSession();
    const sessId = currentSessionId || (data.sessions[0]?.id ?? "");
    if (!sessId) return;

    const entry: SetEntry = {
      id: uid(),
      sessionId: sessId,
      exerciseId: form.exerciseId,
      weight: toNumberSafe(form.weight),
      reps: Math.max(1, Math.floor(toNumberSafe(form.reps))),
      rir: Math.min(4, Math.max(0, Math.floor(toNumberSafe(form.rir)))) as RIR,
      isWarmup: form.isWarmup,
      timestamp: Date.now(),
    };
    setData(d => ({ ...d, sets: [entry, ...d.sets] }));
  }

  // Derived session stats
  const stats = useMemo(() => {
    let totalVolume = 0;
    let topE1RMs: { [exerciseId: string]: number } = {};

    for (const s of sessionSets) {
      const ex = EXERCISES.find(e => e.id === s.exerciseId)!;
      const effLoad = effectiveLoadKg(ex, data.bodyweightKg, s.weight);
      const e1 = epleyE1RM(effLoad, s.reps);
      totalVolume += effLoad * s.reps;
      if (!topE1RMs[s.exerciseId] || e1 > topE1RMs[s.exerciseId]) topE1RMs[s.exerciseId] = e1;
    }
    return { totalVolume: Math.round(totalVolume), topE1RMs };
  }, [sessionSets, data.bodyweightKg]);

  // Last set suggestion for the quick logger
  const lastSetsByEx = useMemo(() => {
    const map: Record<string, SetEntry[]> = {};
    for (const s of sessionSets) {
      (map[s.exerciseId] ||= []).push(s);
    }
    return map;
  }, [sessionSets]);

  const currentExercise = EXERCISES.find(e => e.id === form.exerciseId)!;
  const suggestion = suggestNext(currentExercise, lastSetsByEx[form.exerciseId] || []);

  // Goals progress
  const goalsProgress = useMemo(() => {
    return data.goals.map(g => {
      if (g.metric === "e1rm" && g.exerciseId) {
        const best = bestE1RMForExercise(g.exerciseId, data.sets, data.bodyweightKg);
        return { ...g, current: best ?? 0 };
      }
      if (g.metric === "reps" && g.exerciseId) {
        const bestReps = bestRepsForExercise(g.exerciseId, data.sets);
        return { ...g, current: bestReps ?? 0 };
      }
      if (g.metric === "mobility") {
        const minutes = data.sets.filter(s => s.exerciseId === "mob_flow" && onDate(s.timestamp, todayISO())).length * 2;
        return { ...g, current: minutes };
      }
      return g;
    });
  }, [data.goals, data.sets, data.bodyweightKg]);

  function onDate(ts: number, ymd: string) {
    return new Date(ts).toISOString().slice(0, 10) === ymd;
  }

  function bestE1RMForExercise(exId: string, sets: SetEntry[], bw: number): number | null {
    let best: number | null = null;
    for (const s of sets) {
      if (s.exerciseId !== exId) continue;
      const ex = EXERCISES.find(e => e.id === exId)!;
      const e1 = epleyE1RM(effectiveLoadKg(ex, bw, s.weight), s.reps);
      if (best == null || e1 > best) best = e1;
    }
    return best ? Math.round(best) : null;
  }

  function bestRepsForExercise(exId: string, sets: SetEntry[]): number | null {
    let best: number | null = null;
    for (const s of sets) {
      if (s.exerciseId !== exId) continue;
      if (best == null || s.reps > best) best = s.reps;
    }
    return best;
  }

  // Templates (Legs / Push / Pull / Legs + Mobility day)
  const TEMPLATE: Record<string, { label: string; items: { exerciseId: string; scheme: string }[] }> = {
  // Lower — Anterior chain focus
  legs_anterior: {
    label: "Legs — Anterior (Quads/Glutes/Calves/Tibialis)",
    items: [
      { exerciseId: "front_squat", scheme: "3×3–6 @ RIR2" },
      { exerciseId: "bulgarian", scheme: "3×6–10 @ RIR2 (per leg)" },
      { exerciseId: "leg_press", scheme: "2–3×6–10 @ RIR2" },
      { exerciseId: "leg_ext", scheme: "2×8–12 @ RIR1–2" },
      { exerciseId: "calf", scheme: "3×6–10 @ RIR1–2 (heavy)" },
      { exerciseId: "tibialis_raise", scheme: "2×15–25 @ RIR2" },
    ],
  },

  // Lower — Posterior chain focus
  legs_posterior: {
    label: "Legs — Posterior (Glutes/Hamstrings/Lower back)",
    items: [
      { exerciseId: "rdl", scheme: "3×3–6 @ RIR2" },
      { exerciseId: "hip_thrust", scheme: "3×5–8 @ RIR2" },
      { exerciseId: "nordic_curl", scheme: "3×3–6 @ RIR2 (assist as needed)" },
      { exerciseId: "back_ext", scheme: "3×8–15 @ RIR2" },
      { exerciseId: "calf", scheme: "3×12–20 @ RIR2" },
    ],
  },

  // Upper — Bodyweight strength bias
  push: {
    label: "Push — BW Strength Focus (45–50m)",
    items: [
      { exerciseId: "dip", scheme: "5×3–6 @ RIR1–2 (add weight when 6×5)" },
      { exerciseId: "pushup", scheme: "4×5–8 @ RIR1–2 (add weight when 8+)" },
      { exerciseId: "pike_pushup", scheme: "4×3–6 @ RIR1–2 (progress to HS)" },
    ],
  },
  pull: {
    label: "Pull — BW Strength Focus (45–50m)",
    items: [
      { exerciseId: "pullup", scheme: "5×3–6 @ RIR1–2 (add weight when 6×5)" },
      { exerciseId: "chinup", scheme: "3×3–6 @ RIR1–2" },
      { exerciseId: "inverted_row", scheme: "4×6–10 @ RIR2" },
    ],
  },
  mobility: {
    label: "Mobility (40m)",
    items: [
      { exerciseId: "mob_flow", scheme: "Full-body flow: hips/shoulders/T-spine — log sets as 2 min blocks" },
    ],
  },
};

  function startFromTemplate(key: keyof typeof TEMPLATE) {
    ensureSession(TEMPLATE[key].label);
  }

  function clearAll() {
    if (!confirm("Reset all local data?")) return;
    const fresh = { sessions: [], sets: [], goals: DEFAULT_GOALS, bodyweightKg: 75, units: "kg" as Units, baselineMode: true };
    setData(fresh);
    savePersisted(fresh);
  }

  // ---------- UI ----------
  return (
    <div className="min-h-screen w-full bg-neutral-50 text-neutral-900 overflow-x-hidden">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b border-neutral-200">
        <div className="max-w-[480px] mx-auto px-4 py-3 flex items-center justify-between">
          <div className="text-xl font-semibold">WorkoutBuddy</div>
          <div className="flex items-center gap-2 text-sm">
            <label className="flex items-center gap-2">
              <span className="opacity-70">BW</span>
              <input
                inputMode="decimal"
                type="number"
                className="w-20 rounded-xl border border-neutral-300 px-3 py-1"
                value={data.bodyweightKg}
                onChange={(e) => setData(d => ({ ...d, bodyweightKg: toNumberSafe(e.target.value) }))}
              />
              <span className="opacity-70">kg</span>
            </label>
            <button onClick={clearAll} className="ml-2 rounded-xl border border-neutral-300 bg-white text-neutral-900 px-3 py-1 hover:bg-neutral-100">Reset</button>
          </div>
        </div>
        <nav className="max-w-[480px] mx-auto px-2 pb-2 flex gap-2 overflow-x-auto">
          {([
            ["today", "Today"],
            ["goals", "Goals"],
            ["history", "History"],
            ["templates", "Templates"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-3 py-2 rounded-2xl text-sm ${tab === key ? 'bg-white border border-neutral-300 shadow-sm text-neutral-900' : 'bg-neutral-100 text-neutral-900'}`}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <main className="max-w-[480px] mx-auto px-4 py-4">
        {tab === "today" && (
          <section>
            {/* --- Plan selector --- */}
            <div className="mb-4 rounded-2xl border bg-white p-3">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="font-medium">Today's Split</div>
                <select
                  className="rounded-xl border px-0 py-2"
                  value={currentSession?.templateDay && Object.values(TEMPLATE).some(t => t.label === currentSession.templateDay) ? (Object.keys(TEMPLATE) as (keyof typeof TEMPLATE)[]).find(k => TEMPLATE[k].label === currentSession.templateDay) : ""}
                  onChange={(e) => {
                    const key = e.target.value as keyof typeof TEMPLATE;
                    if (!key) return;
                    if (!currentSession) {
                      ensureSession(TEMPLATE[key].label);
                    } else if (currentSession.templateDay !== TEMPLATE[key].label) {
                      if (confirm("Switch session plan to " + TEMPLATE[key].label + "?")) {
                        setData(d => ({
                          ...d,
                          sessions: d.sessions.map(s => s.id === currentSession.id ? { ...s, templateDay: TEMPLATE[key].label } : s)
                        }));
                      }
                    }
                  }}
                >
                  <option value="">Select plan…</option>
                  {(Object.keys(TEMPLATE) as (keyof typeof TEMPLATE)[]).map(k => (
                    <option key={k} value={k}>{TEMPLATE[k].label}</option>
                  ))}
                </select>

                {/* Baseline mode toggle */}
                <label className="ml-auto flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!data.baselineMode}
                    onChange={(e) => setData(d => ({ ...d, baselineMode: e.target.checked }))}
                  />
                  <span>Baseline week (record only)</span>
                </label>

                {!currentSession && (
                  <button onClick={() => ensureSession()} className="rounded-xl border border-neutral-300 bg-white px-3 py-2">Start session</button>
                )}
                {currentSession && (
                  <button onClick={endSession} className="rounded-xl border border-neutral-300 bg-white text-neutral-900 px-3 py-2 hover:bg-neutral-100">End session</button>
                )}
              </div>
            </div>

            {/* --- Planned exercises list with set logging --- */}
            {currentSession?.templateDay && (
              <PlannedExercises
                label={currentSession.templateDay}
                template={TEMPLATE}
                allSets={data.sets}
                bodyweightKg={data.bodyweightKg}
                baselineMode={!!data.baselineMode}
                onLog={(exId, payload) => {
                  const sessId = currentSessionId || (data.sessions[0]?.id ?? "");
                  if (!sessId) return;
                  const entry: SetEntry = {
                    id: uid(),
                    sessionId: sessId,
                    exerciseId: exId,
                    weight: payload.weight,
                    reps: payload.reps,
                    rir: payload.rir as RIR,
                    timestamp: Date.now(),
                  };
                  setData(d => ({ ...d, sets: [entry, ...d.sets] }));
                }}
                sessionSets={sessionSets}
              />
            )}

            {/* Fallback: original quick log sheet if no plan selected */}
            {!currentSession?.templateDay && (
              <div className="sticky bottom-4 bg-white rounded-2xl shadow-lg border p-3">
                <div className="grid grid-cols-2 gap-3">
                  <label className="col-span-2">
                    <span className="text-sm opacity-70">Exercise</span>
                    <select
                      className="w-full mt-1 rounded-xl border px-3 py-2"
                      value={form.exerciseId}
                      onChange={(e) => setForm(f => ({ ...f, exerciseId: e.target.value }))}
                    >
                      {EXERCISES.map(ex => (
                        <option key={ex.id} value={ex.id}>{ex.name}</option>
                      ))}
                    </select>
                  </label>

                  <label>
                    <span className="text-sm opacity-70">Weight (kg)</span>
                    <input
                      inputMode="decimal"
                      type="number"
                      className="w-full mt-1 rounded-xl border px-3 py-2"
                      value={form.weight}
                      onChange={(e) => setForm(f => ({ ...f, weight: e.target.value }))}
                    />
                  </label>

                  <label>
                    <span className="text-sm opacity-70">Reps</span>
                    <input
                      inputMode="numeric"
                      type="number"
                      className="w-full mt-1 rounded-xl border px-3 py-2"
                      value={form.reps}
                      onChange={(e) => setForm(f => ({ ...f, reps: e.target.value }))}
                    />
                  </label>

                  <label>
                    <span className="text-sm opacity-70">RIR (0–4)</span>
                    <input
                      inputMode="numeric"
                      type="number"
                      className="w-full mt-1 rounded-xl border px-3 py-2"
                      value={form.rir}
                      onChange={(e) => setForm(f => ({ ...f, rir: e.target.value }))}
                    />
                  </label>

                  <label className="flex items-center gap-2 mt-6">
                    <input type="checkbox" checked={form.isWarmup} onChange={(e) => setForm(f => ({ ...f, isWarmup: e.target.checked }))} />
                    <span className="text-sm">Warm-up set</span>
                  </label>
                </div>

                {/* Suggestion */}
                <div className="mt-3 text-sm bg-neutral-50 border rounded-xl p-3">
                  <div className="font-medium">Suggestion</div>
                  <div className="opacity-80">{suggestion.advice}</div>
                </div>

                <div className="mt-3 flex gap-2">
                  <button onClick={() => setForm(f => ({ ...f, weight: String(toNumberSafe(f.weight) - (currentExercise.defaultIncrement || DEFAULT_INCREMENT)) }))} className="rounded-xl border border-neutral-300 bg-white text-neutral-900 px-3 py-2 hover:bg-neutral-100">− {currentExercise.defaultIncrement || DEFAULT_INCREMENT}</button>
                  <button onClick={addSet} className="flex-1 rounded-xl bg-neutral-900 text-white px-3 py-2">Log set</button>
                  <button onClick={() => setForm(f => ({ ...f, weight: String(toNumberSafe(f.weight) + (currentExercise.defaultIncrement || DEFAULT_INCREMENT)) }))} className="rounded-xl border border-neutral-300 bg-white text-neutral-900 px-3 py-2 hover:bg-neutral-100">+ {currentExercise.defaultIncrement || DEFAULT_INCREMENT}</button>
                </div>
              </div>
            )}

            {/* Session summary */}
            {sessionSets.length > 0 && (
              <div className="mt-6">
                <div className="text-sm opacity-70">Session stats</div>
                <div className="mt-1 grid grid-cols-3 gap-2">
                  <div className="rounded-xl border p-3"><div className="text-xs opacity-70">Sets</div><div className="text-lg font-semibold">{sessionSets.length}</div></div>
                  <div className="rounded-xl border p-3"><div className="text-xs opacity-70">Tonnage</div><div className="text-lg font-semibold">{stats.totalVolume} kg</div></div>
                  <div className="rounded-xl border p-3"><div className="text-xs opacity-70">Top e1RM</div><div className="text-lg font-semibold">{Object.values(stats.topE1RMs).length ? Math.max(...Object.values(stats.topE1RMs)).toFixed(0) : "—"} kg</div></div>
                </div>

                <div className="mt-3 divide-y rounded-xl border">
                  {sessionSets.map(s => {
                    const ex = EXERCISES.find(e => e.id === s.exerciseId)!;
                    const eff = effectiveLoadKg(ex, data.bodyweightKg, s.weight);
                    const e1 = epleyE1RM(eff, s.reps);
                    return (
                      <div key={s.id} className="p-3 text-sm flex items-center justify-between">
                        <div>
                          <div className="font-medium">{ex.name}</div>
                          <div className="opacity-80">{s.reps} reps @ {round1(eff)} kg (RIR {s.rir})</div>
                        </div>
                        <div className="text-right">
                          <div className="text-xs opacity-70">e1RM</div>
                          <div className="font-semibold">{Math.round(e1)} kg</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        )}

        {tab === "goals" && (
          <section>
            <div className="text-lg font-semibold mb-2">Goals & Progress</div>
            <div className="space-y-3">
              {goalsProgress.map(g => {
                const pct = Math.max(0, Math.min(100, g.current && g.target ? Math.round((100 * (g.current as number)) / g.target) : 0));
                return (
                  <div key={g.id} className="border rounded-2xl p-3">
                    <div className="flex items-center justify-between">
                      <div className="font-medium">{g.label}</div>
                      <div className="text-sm opacity-70">{g.current ?? 0} / {g.target} {g.unit || ""}</div>
                    </div>
                    <div className="h-2 bg-neutral-200 rounded-full mt-2">
                      <div className="h-full bg-neutral-900 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {tab === "history" && (
          <section>
            <div className="text-lg font-semibold mb-2">Recent Sessions</div>
            <div className="space-y-3">
              {data.sessions.map(s => (
                <div key={s.id} className="border rounded-2xl p-3">
                  <div className="text-sm opacity-70">{s.date}</div>
                  <div className="font-medium">{s.templateDay || "Custom"}</div>
                  <div className="mt-2 text-sm grid grid-cols-2 gap-2">
                    {data.sets.filter(x => x.sessionId === s.id).slice(0, 6).map(x => {
                      const ex = EXERCISES.find(e => e.id === x.exerciseId)!;
                      return <div key={x.id} className="px-2 py-1 rounded-xl bg-neutral-100">{ex.name} — {x.reps} @ {x.weight}kg</div>;
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {tab === "templates" && (
          <section>
            <div className="text-lg font-semibold mb-2">Your Split</div>
            <div className="grid gap-3">
              {(Object.keys(TEMPLATE) as (keyof typeof TEMPLATE)[]).map(key => (
                <div key={key} className="border rounded-2xl p-3">
                  <div className="flex items-center justify-between">
                    <div className="font-medium">{TEMPLATE[key].label}</div>
                    <button onClick={() => startFromTemplate(key)} className="rounded-xl border border-neutral-300 bg-white text-neutral-900 px-3 py-2 hover:bg-neutral-100">Start</button>
                  </div>
                  <ul className="mt-2 text-sm list-disc list-inside opacity-80">
                    {TEMPLATE[key].items.map(it => {
                      const ex = EXERCISES.find(e => e.id === it.exerciseId)!;
                      return <li key={it.exerciseId}>{ex.name} — {it.scheme}</li>;
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      <footer className="h-8" />
    </div>
  );
}

// ---- Subcomponents ----
function PlannedExercises({ label, template, allSets, sessionSets, bodyweightKg, baselineMode, onLog }: {
  label: string;
  template: Record<string, { label: string; items: { exerciseId: string; scheme: string }[] }>;
  allSets: SetEntry[];
  sessionSets: SetEntry[];
  bodyweightKg: number;
  baselineMode: boolean;
  onLog: (exerciseId: string, payload: { weight: number; reps: number; rir: number }) => void;
}) {
  const plan = Object.values(template).find(t => t.label === label);
  const [forms, setForms] = useState<Record<string, { weight: string; reps: string; rir: string }>>({});

  useEffect(() => {
    if (!plan) return;
    const next: Record<string, { weight: string; reps: string; rir: string }> = {};
    for (const item of plan.items) {
      if (baselineMode) {
        next[item.exerciseId] = { weight: "", reps: "", rir: "2" };
        continue;
      }
      const exHistory = allSets.filter(s => s.exerciseId === item.exerciseId).sort((a,b)=>b.timestamp-a.timestamp);
      const exMeta = EXERCISES.find(e => e.id === item.exerciseId)!;
      const sugg = suggestNext(exMeta, exHistory.slice(0,3));
      next[item.exerciseId] = {
        weight: sugg.nextWeight != null ? String(sugg.nextWeight) : "0",
        reps: String(sugg.nextReps ?? 8),
        rir: "2",
      };
    }
    setForms(next);
  }, [label, baselineMode]);

  if (!plan) return null;

  return (
    <div className="space-y-3">
      {plan.items.map((it) => {
        const ex = EXERCISES.find(e => e.id === it.exerciseId)!;
        const parsed = parseScheme(it.scheme);
        const setsForExThisSession = sessionSets.filter(s => s.exerciseId === it.exerciseId);
        const f = forms[it.exerciseId] || { weight: "0", reps: "8", rir: "2" };

        return (
          <div key={it.exerciseId} className="rounded-2xl border bg-white p-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">{ex.name}</div>
                <div className="text-sm opacity-70">Target: {parsed.sets ?? "—"} sets · {parsed.repText} {parsed.rirText ? `· ${parsed.rirText}` : ""}</div>
              </div>
              <div className="text-xs opacity-70">{it.scheme}</div>
            </div>

            {/* Suggestion */}
            <div className="mt-2 text-sm bg-neutral-50 border rounded-xl p-2">
              {baselineMode ? (
                <div className="opacity-80">Baseline week: just record what you can move for ~3–6 reps at RIR 1–2. We'll build progressive targets next week.</div>
              ) : (
                <div className="opacity-80">Suggested start: {f.weight}{ex.isBodyweight ? " kg ext." : " kg"} × {f.reps} reps (RIR {f.rir})</div>
              )}
            </div>

            {/* Log row */}
            <div className="mt-2 grid grid-cols-3 gap-2">
              <input
                inputMode="decimal"
                type="number"
                className="w-full rounded-xl border px-3 py-2"
                value={f.weight}
                onChange={(e)=> setForms(v=>({ ...v, [it.exerciseId]: { ...f, weight: e.target.value } }))}
                placeholder="Weight"
              />
              <input
                inputMode="numeric"
                type="number"
                className="w-full rounded-xl border px-3 py-2"
                value={f.reps}
                onChange={(e)=> setForms(v=>({ ...v, [it.exerciseId]: { ...f, reps: e.target.value } }))}
                placeholder="Reps"
              />
              <input
                inputMode="numeric"
                type="number"
                className="w-full rounded-xl border px-3 py-2"
                value={f.rir}
                onChange={(e)=> setForms(v=>({ ...v, [it.exerciseId]: { ...f, rir: e.target.value } }))}
                placeholder="RIR"
              />
            </div>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => setForms(v=>({ ...v, [it.exerciseId]: { ...f, weight: String(toNumberSafe(f.weight) - (ex.defaultIncrement || 2.5)) } }))}
                className="rounded-xl border border-neutral-300 bg-white px-3 py-2"
              >− {ex.defaultIncrement || 2.5}</button>
              <button
                onClick={() => onLog(it.exerciseId, { weight: toNumberSafe(f.weight), reps: Math.max(1, Math.floor(toNumberSafe(f.reps))), rir: Math.min(4, Math.max(0, Math.floor(toNumberSafe(f.rir)))) })}
                className="flex-1 rounded-xl bg-neutral-900 text-white px-3 py-2"
              >Log set</button>
              <button
                onClick={() => setForms(v=>({ ...v, [it.exerciseId]: { ...f, weight: String(toNumberSafe(f.weight) + (ex.defaultIncrement || 2.5)) } }))}
                className="rounded-xl border border-neutral-300 bg-white px-3 py-2"
              >+ {ex.defaultIncrement || 2.5}</button>
            </div>

            {/* Sets so far for this exercise */}
            {setsForExThisSession.length > 0 && (
              <div className="mt-2 rounded-xl border">
                {setsForExThisSession.map((s, idx) => {
                  const eff = effectiveLoadKg(ex, bodyweightKg, s.weight);
                  const e1 = epleyE1RM(eff, s.reps);
                  return (
                    <div key={s.id} className="p-2 text-sm flex items-center justify-between">
                      <div>Set {setsForExThisSession.length - idx}: {s.reps} reps @ {round1(eff)} kg (RIR {s.rir})</div>
                      <div className="text-xs opacity-70">e1RM {Math.round(e1)} kg</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function parseScheme(s: string): { sets: number | null; repText: string; rirText?: string } {
  // Patterns like "3×6–10 @ RIR2" or "3×5 @ RIR1–2" or "AMRAP sets to RIR2"
  const setMatch = s.match(/(\d+)\s*[x×]/i);
  const repRange = s.match(/(\d+)\s*[–-]\s*(\d+)/);
  const singleRep = s.match(/(\d+)\s*(?:reps?|$)/i);
  const rir = s.match(/RIR\s*(\d(?:[–-]\d)?)/i);

  let sets: number | null = setMatch ? Number(setMatch[1]) : null;
  let repText = 'AMRAP';
  if (repRange) repText = `${repRange[1]}–${repRange[2]} reps`;
  else if (singleRep) repText = `${singleRep[1]} reps`;

  const rirText = rir ? `@ RIR ${rir[1]}` : undefined;
  return { sets, repText, rirText };
}
