import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase, isSupabaseConfigured } from "./lib/supabase";

// ---------------------------------------------
// Minimal Workout Split Tracker — v2 (Sets + Reps)
// Features:
// - Pick Day (Legs Anterior / Push / Pull / Legs Posterior / Mobility)
// - Shows fixed exercises for that day
// - For each exercise: previous session lookup (date-aware)
// - Track *per-set* reps & weight (or reps-only for mobility/bodyweight)
// - Per-exercise Rest Timer with start/stop and optional desktop notification
// - LocalStorage persistence; v1→v2 migration supported
// ---------------------------------------------

// Types
 type Day = "Legs Anterior" | "Push" | "Pull" | "Legs Posterior" | "Mobility";
 type ExerciseType = "primary" | "secondary" | "accessory" | "mobility";
 type Exercise = {
  id: string;
  name: string;
  day: Day;
  type: ExerciseType;
  defaultRestSec: number; // recommended rest time in seconds
  trackWeight: boolean; // mobility items can set false
};
 type SetEntry = { reps: number; weight: number }; // weight can be 0 for bodyweight
 type ExerciseLog = {
  date: string; // YYYY-MM-DD
  day: Day;
  exerciseId: string;
  exerciseName: string;
  sets: SetEntry[]; // per-set tracking
  notes?: string;
};

// Utilities
const DAYS: Day[] = [
  "Legs Anterior",
  "Push",
  "Pull",
  "Legs Posterior",
  "Mobility",
];

function todayStr() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function beep(duration = 600, freq = 880) {
  const Ctx: any = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  setTimeout(() => {
    osc.stop();
    ctx.close();
  }, duration);
}

// Data: Fixed split from the minimal program
const EXERCISES: Exercise[] = [
  // Day 1 — Legs Anterior
  { id: "front-squat", name: "Front Squat", day: "Legs Anterior", type: "primary", defaultRestSec: 120, trackWeight: true },
  { id: "standing-calf-raise", name: "Standing Calf Raise", day: "Legs Anterior", type: "accessory", defaultRestSec: 75, trackWeight: true },
  { id: "bulgarian-split-squat", name: "Bulgarian Split Squat", day: "Legs Anterior", type: "secondary", defaultRestSec: 90, trackWeight: true },
  { id: "banded-lateral-walk", name: "Banded Lateral Walk", day: "Legs Anterior", type: "accessory", defaultRestSec: 45, trackWeight: false },

  // Day 2 — Push
  { id: "overhead-press", name: "Overhead Press", day: "Push", type: "primary", defaultRestSec: 120, trackWeight: true },
  { id: "barbell-bench-press", name: "Barbell Bench Press", day: "Push", type: "secondary", defaultRestSec: 90, trackWeight: true },
  { id: "db-lateral-raise", name: "Dumbbell Lateral Raise", day: "Push", type: "accessory", defaultRestSec: 60, trackWeight: true },
  { id: "face-pull", name: "Face Pull", day: "Push", type: "accessory", defaultRestSec: 60, trackWeight: false },

  // Day 3 — Pull
  { id: "weighted-pullup", name: "Weighted Pull-Up/Chin-Up", day: "Pull", type: "primary", defaultRestSec: 120, trackWeight: true },
  { id: "chest-supported-row", name: "Chest-Supported Row", day: "Pull", type: "secondary", defaultRestSec: 90, trackWeight: true },
  { id: "hammer-curl", name: "Hammer Curl", day: "Pull", type: "accessory", defaultRestSec: 60, trackWeight: true },
  { id: "hanging-leg-raise", name: "Hanging Leg Raise", day: "Pull", type: "accessory", defaultRestSec: 60, trackWeight: false },

  // Day 4 — Legs Posterior
  { id: "trapbar-deadlift", name: "Trap-Bar Deadlift", day: "Legs Posterior", type: "primary", defaultRestSec: 150, trackWeight: true },
  { id: "romanian-deadlift", name: "Romanian Deadlift", day: "Legs Posterior", type: "secondary", defaultRestSec: 120, trackWeight: true },
  { id: "seated-calf-raise", name: "Seated Calf Raise", day: "Legs Posterior", type: "accessory", defaultRestSec: 75, trackWeight: true },
  { id: "dead-bug", name: "Dead Bug", day: "Legs Posterior", type: "accessory", defaultRestSec: 45, trackWeight: false },

  // Day 5 — Mobility/GPP
  { id: "cossack-squat", name: "Cossack Squat (bodyweight)", day: "Mobility", type: "mobility", defaultRestSec: 40, trackWeight: false },
  { id: "hip-9090", name: "90/90 Hip Switch", day: "Mobility", type: "mobility", defaultRestSec: 40, trackWeight: false },
  { id: "ankle-ktw", name: "Ankle Knee-to-Wall", day: "Mobility", type: "mobility", defaultRestSec: 40, trackWeight: false },
  { id: "scap-retractions", name: "Hanging Scapular Retractions", day: "Mobility", type: "mobility", defaultRestSec: 45, trackWeight: false },
];

// Local Storage helpers (v2 + migration from v1)
const LS_LOGS_KEY_V2 = "wb_logs_v2";
const LS_LOGS_KEY_V1 = "wb_logs_v1"; // old: single weight per exercise
const LS_REST_OVERRIDES_KEY = "wb_rest_overrides_v1";
const LS_CLIENT_ID = "wb_client_id";

function loadLogs(): ExerciseLog[] {
  try {
    const v2 = localStorage.getItem(LS_LOGS_KEY_V2);
    if (v2) return JSON.parse(v2) as ExerciseLog[];

    const v1 = localStorage.getItem(LS_LOGS_KEY_V1);
    if (v1) {
      // migrate v1 → v2 (weight → single set with reps=0)
      const old = JSON.parse(v1) as any[];
      const migrated: ExerciseLog[] = old.map((l) => ({
        date: l.date,
        day: l.day,
        exerciseId: l.exerciseId,
        exerciseName: l.exerciseName,
        sets: [{ reps: 0, weight: Number(l.weight) || 0 }],
      }));
      localStorage.setItem(LS_LOGS_KEY_V2, JSON.stringify(migrated));
      return migrated;
    }
  } catch {}
  return [];
}

function saveLogs(logs: ExerciseLog[]) {
  localStorage.setItem(LS_LOGS_KEY_V2, JSON.stringify(logs));
}

function loadRestOverrides(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LS_REST_OVERRIDES_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function saveRestOverrides(o: Record<string, number>) {
  localStorage.setItem(LS_REST_OVERRIDES_KEY, JSON.stringify(o));
}

function getLastLogForExercise(exerciseId: string, logs: ExerciseLog[], beforeDate?: string): ExerciseLog | undefined {
  const list = logs
    .filter((l) => l.exerciseId === exerciseId && (!beforeDate || l.date <= beforeDate))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  return list[0];
}

function summarizeSets(sets: SetEntry[], trackWeight: boolean) {
  if (!sets || sets.length === 0) return "no sets";
  return sets
    .map((s) => (trackWeight ? `${s.reps}×${s.weight}kg` : `${s.reps} reps`))
    .join(" | ");
}

// Timer Component
function RestTimer({
  label,
  seconds,
  notify,
}: {
  label: string;
  seconds: number;
  notify: boolean;
}) {
  const [remaining, setRemaining] = useState<number>(seconds);
  const [running, setRunning] = useState<boolean>(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    setRemaining(seconds);
  }, [seconds]);

  useEffect(() => {
    if (!running) return;
    timerRef.current = window.setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          window.clearInterval(timerRef.current!);
          timerRef.current = null;
          setRunning(false);
          beep();
          document.title = "⏰ Rest over";
          if (notify && "Notification" in window && Notification.permission === "granted") {
            new Notification("Rest over — " + label);
          }
          if (navigator.vibrate) navigator.vibrate(200);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [running, notify, label]);

  const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
  const ss = String(remaining % 60).padStart(2, "0");

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button
        onClick={() => setRunning(true)}
        disabled={running}
        style={btnStyle}
        aria-label={`Start rest for ${label}`}
      >
        ▶ Start
      </button>
      <button
        onClick={() => {
          setRunning(false);
          if (timerRef.current) window.clearInterval(timerRef.current);
        }}
        style={btnGhost}
        aria-label={`Stop rest for ${label}`}
      >
        ■ Stop
      </button>
      <button
        onClick={() => {
          setRunning(false);
          if (timerRef.current) window.clearInterval(timerRef.current);
          setRemaining(seconds);
          document.title = "Workout Buddy";
        }}
        style={btnGhost}
        aria-label={`Reset rest for ${label}`}
      >
        ↺ Reset
      </button>
      <span style={{ fontFamily: "monospace", minWidth: 60, textAlign: "center" }}>
        {mm}:{ss}
      </span>
    </div>
  );
}

// Styles (minimal, self-contained)
const appShell: React.CSSProperties = {
  fontFamily: "Inter, system-ui, Arial, sans-serif",
  color: "#0b1b13",
  background: "#f6fbf8",
  minHeight: "100vh",
};
const container: React.CSSProperties = {
  maxWidth: 960,
  margin: "0 auto",
  padding: 16,
};
const card: React.CSSProperties = {
  background: "#ffffff",
  border: "1px solid #e6efe9",
  borderRadius: 16,
  padding: 16,
  boxShadow: "0 2px 10px rgba(0,0,0,0.04)",
};
const hRow: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" };
const selectStyle: React.CSSProperties = { padding: 10, borderRadius: 12, border: "1px solid #cfe4d7", background: "#fff" };
const inputStyle: React.CSSProperties = { padding: 8, borderRadius: 10, border: "1px solid #cfe4d7", width: 120 };
const smallInput: React.CSSProperties = { padding: 8, borderRadius: 10, border: "1px solid #cfe4d7", width: 80 };
const btnStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 12,
  border: "1px solid #296e3b",
  background: "#296e3b",
  color: "#fff",
  cursor: "pointer",
};
const btnGhost: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 12,
  border: "1px solid #cfe4d7",
  background: "#fff",
  color: "#0b1b13",
  cursor: "pointer",
};
const tag: React.CSSProperties = { padding: "2px 8px", borderRadius: 999, fontSize: 12, background: "#e6f4ec", border: "1px solid #cfe4d7" };

// Main App
export default function WorkoutBuddyApp() {
  const [selectedDay, setSelectedDay] = useState<Day>("Push");
  const [dateStr, setDateStr] = useState<string>(todayStr());
  const [logs, setLogs] = useState<ExerciseLog[]>(() => loadLogs());
  const [restOverrides, setRestOverrides] = useState<Record<string, number>>(() => loadRestOverrides());
  const [notify, setNotify] = useState<boolean>(false);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [syncError, setSyncError] = useState<string>("");

  // --- Supabase Sync ---
  function getOrCreateClientId(): string {
    let id = localStorage.getItem(LS_CLIENT_ID);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(LS_CLIENT_ID, id);
    }
    return id;
  }

  // Pull from Supabase on first load if configured, else stay with Local Storage
  useEffect(() => {
    let cancelled = false;
    async function pullFromSupabase() {
      if (!isSupabaseConfigured() || !supabase) return; 
      setSyncing(true);
      setSyncError("");
      const clientId = getOrCreateClientId();
      try {
        const { data: logsRows, error: logsErr } = await supabase
          .from("wb_logs")
          .select("date, day, exercise_id, exercise_name, sets")
          .eq("client_id", clientId)
          .order("date", { ascending: true });
        if (logsErr) throw logsErr;

        const remoteLogs: ExerciseLog[] = (logsRows ?? []).map((r: any) => ({
          date: r.date,
          day: r.day as Day,
          exerciseId: r.exercise_id,
          exerciseName: r.exercise_name,
          sets: (r.sets ?? []).map((s: any) => ({ reps: Number(s.reps)||0, weight: Number(s.weight)||0 })),
        }));

        const { data: restRows, error: restErr } = await supabase
          .from("wb_rest_overrides")
          .select("exercise_id, seconds")
          .eq("client_id", clientId);
        if (restErr) throw restErr;

        const remoteRest: Record<string, number> = {};
        (restRows ?? []).forEach((r: any) => { remoteRest[r.exercise_id] = Number(r.seconds)||0; });

        if (!cancelled) {
          if (remoteLogs.length) {
            setLogs(remoteLogs);
            saveLogs(remoteLogs);
          }
          if (Object.keys(remoteRest).length) {
            setRestOverrides(remoteRest);
            saveRestOverrides(remoteRest);
          }
        }
      } catch (e: any) {
        if (!cancelled) setSyncError(e?.message ?? String(e));
      } finally {
        if (!cancelled) setSyncing(false);
      }
    }
    pullFromSupabase();
    return () => { cancelled = true; };
  }, []);

  // Save to Local Storage always, and also push changes to Supabase when configured
  useEffect(() => {
    saveLogs(logs);
    async function pushLogs() {
      if (!isSupabaseConfigured() || !supabase) return;
      const clientId = getOrCreateClientId();
      // Upsert per (client_id, date, exercise_id)
      const rows = logs.map((l) => ({
        client_id: clientId,
        date: l.date,
        day: l.day,
        exercise_id: l.exerciseId,
        exercise_name: l.exerciseName,
        sets: l.sets,
      }));
      setSyncError("");
      const { error } = await supabase.from("wb_logs").upsert(rows, { onConflict: "client_id,date,exercise_id" });
      if (error) setSyncError(error.message);
    }
    pushLogs();
  }, [logs]);

  useEffect(() => {
    saveRestOverrides(restOverrides);
    async function pushRest() {
      if (!isSupabaseConfigured() || !supabase) return;
      const clientId = getOrCreateClientId();
      const rows = Object.entries(restOverrides).map(([exerciseId, seconds]) => ({
        client_id: clientId,
        exercise_id: exerciseId,
        seconds,
      }));
      setSyncError("");
      // Replace all entries for client for simplicity
      await supabase.from("wb_rest_overrides").delete().eq("client_id", clientId);
      const { error } = await supabase.from("wb_rest_overrides").insert(rows);
      if (error) setSyncError(error.message);
    }
    pushRest();
  }, [restOverrides]);

  // Ask Notification permission when toggled on
  useEffect(() => {
    if (!notify) return;
    if ("Notification" in window) {
      if (Notification.permission === "default") {
        Notification.requestPermission();
      }
    }
  }, [notify]);

  const dayExercises = useMemo(
    () => EXERCISES.filter((e) => e.day === selectedDay),
    [selectedDay]
  );

  return (
    <div style={appShell}>
      <div style={container}>
        <header style={{ ...hRow, justifyContent: "space-between" }}>
          <h1 style={{ fontSize: 24, margin: 0 }}>Workout Buddy — Minimal Split</h1>
          <div style={hRow}>
            <label style={{ display: "flex", flexDirection: "column", fontSize: 12 }}>
              <span style={{ marginBottom: 4 }}>Date</span>
              <input
                type="date"
                value={dateStr}
                onChange={(e) => setDateStr(e.target.value)}
                style={inputStyle}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", fontSize: 12 }}>
              <span style={{ marginBottom: 4 }}>Desktop Alerts</span>
              <select
                value={notify ? "on" : "off"}
                onChange={(e) => setNotify(e.target.value === "on")}
                style={selectStyle}
              >
                <option value="off">Off</option>
                <option value="on">On</option>
              </select>
            </label>
            <span style={{ fontSize: 12, color: syncError ? "#a5483b" : "#466a57" }}>
              {isSupabaseConfigured() ? (syncing ? "Syncing…" : syncError ? `Sync error: ${syncError}` : "Synced with Supabase") : "Offline (no Supabase env)"}
            </span>
          </div>
        </header>

        <section style={{ ...card, marginTop: 12 }}>
          <div style={hRow}>
            <span style={{ fontSize: 14 }}>Select Day:</span>
            <select
              value={selectedDay}
              onChange={(e) => setSelectedDay(e.target.value as Day)}
              style={selectStyle}
            >
              {DAYS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr" , marginTop: 12 }}>
          {dayExercises.map((ex) => (
            <ExerciseCard
              key={ex.id}
              ex={ex}
              dateStr={dateStr}
              logs={logs}
              setLogs={setLogs}
              restOverrides={restOverrides}
              setRestOverrides={setRestOverrides}
              notify={notify}
            />
          ))}
        </section>

        <footer style={{ marginTop: 20, ...hRow, justifyContent: "space-between" }}>
          <button
            style={btnGhost}
            onClick={() => {
              if (confirm("Clear ALL saved logs?")) {
                setLogs([]);
                (async () => {
                  if (isSupabaseConfigured() && supabase) {
                    const clientId = localStorage.getItem(LS_CLIENT_ID);
                    if (clientId) {
                      await supabase.from("wb_logs").delete().eq("client_id", clientId);
                    }
                  }
                })();
              }
            }}
          >
            Clear All Logs
          </button>
          <span style={{ fontSize: 12, color: "#466a57" }}>
            Tip: Log each *set* with reps & weight. Previous session can prefill your sets.
          </span>
        </footer>
      </div>
    </div>
  );
}

function ExerciseCard({
  ex,
  dateStr,
  logs,
  setLogs,
  restOverrides,
  setRestOverrides,
  notify,
}: {
  ex: Exercise;
  dateStr: string;
  logs: ExerciseLog[];
  setLogs: React.Dispatch<React.SetStateAction<ExerciseLog[]>>;
  restOverrides: Record<string, number>;
  setRestOverrides: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  notify: boolean;
}) {
  const last = useMemo(() => getLastLogForExercise(ex.id, logs, dateStr), [ex.id, logs, dateStr]);

  // Build initial sets: last session sets, or a single starter row
  const initialSets: SetEntry[] = useMemo(() => {
    if (last?.sets && last.sets.length > 0) return last.sets.map((s) => ({ ...s }));
    const baseW = last && last.sets && last.sets[0] ? last.sets[0].weight : 0;
    return [{ reps: 5, weight: ex.trackWeight ? baseW : 0 }];
  }, [last, ex.trackWeight]);

  const [sets, setSets] = useState<SetEntry[]>(initialSets);
  const restSec = restOverrides[ex.id] ?? ex.defaultRestSec;

  useEffect(() => {
    // If date changes (hence last could change), refresh editable sets
    setSets(initialSets);
  }, [initialSets]);

  function setSetField(idx: number, key: keyof SetEntry, val: number) {
    setSets((prev) => prev.map((s, i) => (i === idx ? { ...s, [key]: Math.max(0, Math.round(val)) } : s)));
  }

  function addSet() {
    const lastW = sets.length ? sets[sets.length - 1].weight : (last?.sets?.[0]?.weight ?? 0);
    setSets((p) => [...p, { reps: 5, weight: ex.trackWeight ? lastW : 0 }]);
  }

  function removeSet(idx: number) {
    setSets((p) => p.filter((_, i) => i !== idx));
  }

  function prefillLast() {
    if (last?.sets && last.sets.length) setSets(last.sets.map((s) => ({ ...s })));
  }

  function saveToday() {
    // basic validation: at least one set, reps>0; weight>=0 (allow bodyweight or plate add of 0)
    const valid = sets.length > 0 && sets.every((s) => s.reps > 0 && s.weight >= 0);
    if (!valid) {
      alert("Please enter reps (>0) and non-negative weight for all sets.");
      return;
    }
    const filtered = logs.filter((l) => !(l.date === dateStr && l.exerciseId === ex.id));
    const newLog: ExerciseLog = {
      date: dateStr,
      day: ex.day,
      exerciseId: ex.id,
      exerciseName: ex.name,
      sets: sets.map((s) => ({ reps: s.reps, weight: ex.trackWeight ? s.weight : 0 })),
    };
    setLogs([...filtered, newLog]);
  }

  // Auto-save: debounce changes to sets and persist to logs -> Supabase syncs
  const autoSaveRef = useRef<number | null>(null);
  useEffect(() => {
    if (autoSaveRef.current) window.clearTimeout(autoSaveRef.current);
    autoSaveRef.current = window.setTimeout(() => {
      // Require at least one set and non-negative fields
      if (!sets.length) return;
      const sanitized = sets.map((s) => ({ reps: Math.max(0, Math.round(s.reps)), weight: Math.max(0, Math.round(s.weight)) }));
      const filtered = logs.filter((l) => !(l.date === dateStr && l.exerciseId === ex.id));
      const newLog: ExerciseLog = {
        date: dateStr,
        day: ex.day,
        exerciseId: ex.id,
        exerciseName: ex.name,
        sets: sanitized.map((s) => ({ reps: s.reps, weight: ex.trackWeight ? s.weight : 0 })),
      };
      setLogs([...filtered, newLog]);
    }, 800);
    return () => {
      if (autoSaveRef.current) window.clearTimeout(autoSaveRef.current);
    };
    // include dependencies so we auto-save when these change
  }, [sets, dateStr, ex.id, ex.name, ex.day, ex.trackWeight]);

  function updateRest(sec: number) {
    setRestOverrides((prev) => ({ ...prev, [ex.id]: Math.max(10, Math.min(999, Math.round(sec))) }));
  }

  return (
    <div style={card}>
      <div style={{ ...hRow, justifyContent: "space-between" }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ ...hRow }}>
            <h3 style={{ margin: 0 }}>{ex.name}</h3>
            <span style={tag}>{ex.type}</span>
          </div>
          <div style={{ marginTop: 6, fontSize: 13, color: "#335e49" }}>
            {last ? (
              <span>
                Previous ({last.date}): <strong>{summarizeSets(last.sets, ex.trackWeight)}</strong>
              </span>
            ) : (
              <span>No previous log yet.</span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          <div style={{ ...hRow }}>
            <label style={{ display: "flex", flexDirection: "column", fontSize: 12 }}>
              <span style={{ marginBottom: 4 }}>Rest (sec)</span>
              <input
                type="number"
                value={restSec}
                onChange={(e) => updateRest(Number(e.target.value))}
                style={smallInput}
                min={10}
                max={999}
              />
            </label>
          </div>
        </div>
      </div>

      {/* Sets Table */}
      <div style={{ marginTop: 12 }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", fontSize: 13, color: "#2a5342" }}>
                <th style={{ padding: "8px 4px" }}>#</th>
                <th style={{ padding: "8px 4px" }}>Reps</th>
                {ex.trackWeight && <th style={{ padding: "8px 4px" }}>Weight (kg)</th>}
                <th style={{ padding: "8px 4px" }}></th>
              </tr>
            </thead>
            <tbody>
              {sets.map((s, i) => (
                <tr key={i} style={{ borderTop: "1px solid #eef4f0" }}>
                  <td style={{ padding: "8px 4px" }}>{i + 1}</td>
                  <td style={{ padding: "8px 4px" }}>
                    <input
                      type="number"
                      value={s.reps}
                      min={0}
                      onChange={(e) => setSetField(i, "reps", Number(e.target.value))}
                      style={{ ...smallInput, width: 90 }}
                    />
                  </td>
                  {ex.trackWeight && (
                    <td style={{ padding: "8px 4px" }}>
                      <input
                        type="number"
                        value={s.weight}
                        min={0}
                        step={0.5}
                        onChange={(e) => setSetField(i, "weight", Number(e.target.value))}
                        style={{ ...smallInput, width: 110 }}
                      />
                    </td>
                  )}
                  <td style={{ padding: "8px 4px" }}>
                    <button style={btnGhost} onClick={() => removeSet(i)} aria-label={`Remove set ${i + 1}`}>
                      ✕ Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ ...hRow, marginTop: 8 }}>
          <button style={btnGhost} onClick={addSet}>+ Add Set</button>
          <button style={btnGhost} onClick={prefillLast} disabled={!last?.sets?.length}>
            Prefill Last Session
          </button>
          <button onClick={saveToday} style={btnStyle}>
            Save Today
          </button>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <RestTimer label={ex.name} seconds={restSec} notify={notify} />
      </div>
    </div>
  );
}
