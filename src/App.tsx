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

function offsetDateStr(baseDateStr: string, daysDelta: number): string {
  const d = new Date(`${baseDateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return baseDateStr;
  d.setDate(d.getDate() + daysDelta);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

let sharedAudioCtx: any = null;

function ensureAudioCtx(): any {
  const Ctx: any = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedAudioCtx) {
    sharedAudioCtx = new Ctx();
  }
  if (sharedAudioCtx && sharedAudioCtx.state === "suspended" && sharedAudioCtx.resume) {
    sharedAudioCtx.resume();
  }
  return sharedAudioCtx;
}

function beep(duration = 600, freq = 880) {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.value = 0.2;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  setTimeout(() => {
    osc.stop();
  }, duration);
}

// Data: Fixed split — updated (neck/forearm focus in Push/Pull)
const EXERCISES: Exercise[] = [
  // --- LEGS ANTERIOR (unchanged)
  { id: "front-squat",           name: "Front Squat",                         day: "Legs Anterior", type: "primary",   defaultRestSec: 120, trackWeight: true },
  { id: "standing-calf-raise",   name: "Standing Calf Raise",                 day: "Legs Anterior", type: "accessory", defaultRestSec: 75,  trackWeight: true },
  { id: "bulgarian-split-squat", name: "Bulgarian Split Squat",               day: "Legs Anterior", type: "secondary", defaultRestSec: 90,  trackWeight: true },
  { id: "banded-lateral-walk",   name: "Banded Lateral Walk",                 day: "Legs Anterior", type: "accessory", defaultRestSec: 45,  trackWeight: false },

  // --- PUSH (neck + forearms focus; light aesthetics)
  { id: "neck-flexion",          name: "Neck Flexion (harness/band)",         day: "Push",          type: "primary",   defaultRestSec: 60,  trackWeight: true },
  { id: "neck-extension",        name: "Neck Extension (harness)",            day: "Push",          type: "primary",   defaultRestSec: 60,  trackWeight: true },
  { id: "wrist-curl",            name: "Wrist Curl",                           day: "Push",          type: "secondary", defaultRestSec: 60,  trackWeight: true },
  { id: "wrist-extension-curl",  name: "Wrist Extension Curl",                 day: "Push",          type: "secondary", defaultRestSec: 60,  trackWeight: true },
  { id: "incline-db-press",      name: "Incline Dumbbell Press (maintenance)", day: "Push",          type: "accessory", defaultRestSec: 75,  trackWeight: true },
  { id: "db-lateral-raise",      name: "Dumbbell Lateral Raise",               day: "Push",          type: "accessory", defaultRestSec: 60,  trackWeight: true },

  // --- PULL (neck + forearms focus; light back)
  { id: "neck-lat-flexion",      name: "Neck Lateral Flexion (harness/band)",  day: "Pull",          type: "primary",   defaultRestSec: 60,  trackWeight: true },
  { id: "neck-rotation-iso",     name: "Neck Rotation (isometric towel/band)", day: "Pull",          type: "primary",   defaultRestSec: 45,  trackWeight: false },
  { id: "reverse-curl",          name: "Reverse Curl (EZ/DB)",                 day: "Pull",          type: "secondary", defaultRestSec: 60,  trackWeight: true },
  { id: "hammer-curl",           name: "Hammer Curl",                           day: "Pull",          type: "secondary", defaultRestSec: 60,  trackWeight: true },
  { id: "chest-supported-row",   name: "Chest-Supported Row (maintenance)",     day: "Pull",          type: "accessory", defaultRestSec: 75,  trackWeight: true },
  { id: "pull-up",               name: "Pull-Up (bodyweight/weighted)",         day: "Pull",          type: "accessory", defaultRestSec: 90,  trackWeight: true },

  // --- LEGS POSTERIOR (unchanged)
  { id: "trapbar-deadlift",      name: "Trap-Bar Deadlift",                    day: "Legs Posterior", type: "primary",   defaultRestSec: 150, trackWeight: true },
  { id: "romanian-deadlift",     name: "Romanian Deadlift",                    day: "Legs Posterior", type: "secondary", defaultRestSec: 120, trackWeight: true },
  { id: "seated-calf-raise",     name: "Seated Calf Raise",                    day: "Legs Posterior", type: "accessory", defaultRestSec: 75,  trackWeight: true },
  { id: "dead-bug",              name: "Dead Bug",                              day: "Legs Posterior", type: "accessory", defaultRestSec: 45,  trackWeight: false },

  // --- MOBILITY/GPP (unchanged)
  { id: "cossack-squat",         name: "Cossack Squat (bodyweight)",           day: "Mobility",       type: "mobility",  defaultRestSec: 40,  trackWeight: false },
  { id: "hip-9090",              name: "90/90 Hip Switch",                     day: "Mobility",       type: "mobility",  defaultRestSec: 40,  trackWeight: false },
  { id: "ankle-ktw",             name: "Ankle Knee-to-Wall",                   day: "Mobility",       type: "mobility",  defaultRestSec: 40,  trackWeight: false },
  { id: "scap-retractions",      name: "Hanging Scapular Retractions",         day: "Mobility",       type: "mobility",  defaultRestSec: 45,  trackWeight: false },
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
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }} className="timer timer-buttons">
      <button
        onClick={() => { ensureAudioCtx(); setRunning(true); }}
        disabled={running}
        style={btnStyle}
        className="btn"
        aria-label={`Start rest for ${label}`}
      >
        ▶️ Start
      </button>
      <button
        onClick={() => {
          setRunning(false);
          if (timerRef.current) window.clearInterval(timerRef.current);
        }}
        style={btnGhost}
        className="btn-ghost"
        aria-label={`Stop rest for ${label}`}
      >
        ⏹️ Stop
      </button>
      <button
        onClick={() => {
          setRunning(false);
          if (timerRef.current) window.clearInterval(timerRef.current);
          setRemaining(seconds);
          document.title = "Workout Buddy";
        }}
        style={btnGhost}
        className="btn-ghost"
        aria-label={`Reset rest for ${label}`}
      >
        🔄 Reset
      </button>
      <div style={{ 
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "8px 12px",
        background: "#2d2d5f",
        border: "1px solid #3d3d7f",
        borderRadius: "8px",
        minWidth: "80px",
        justifyContent: "center"
      }}>
        <span style={{ fontSize: "10px", color: "#ffd700", fontWeight: "600", textTransform: "uppercase" }}>⏱️</span>
        <span style={{ 
          fontFamily: "monospace", 
          fontSize: "16px", 
          fontWeight: "700", 
          color: "#ffd700"
        }}>
          {mm}:{ss}
        </span>
      </div>
    </div>
  );
}

// Styles (clean dark theme matching reference image)
const appShell: React.CSSProperties = {
  fontFamily: "Inter, system-ui, Arial, sans-serif",
  color: "#ffffff",
  background: "#0f0f23",
  minHeight: "100vh",
  padding: "16px 0",
};

const container: React.CSSProperties = {
  maxWidth: 480,
  margin: "0 auto",
  padding: "0 16px",
};

const headerCard: React.CSSProperties = {
  background: "#1a1a2e",
  border: "1px solid #2d2d5f",
  borderRadius: 16,
  padding: 20,
  marginBottom: 20,
};

const card: React.CSSProperties = {
  background: "#1a1a2e",
  border: "1px solid #2d2d5f",
  borderRadius: 16,
  padding: 16,
  marginBottom: 16,
};

const hRow: React.CSSProperties = { 
  display: "flex", 
  flexWrap: "wrap", 
  gap: 12, 
  alignItems: "center" 
};

const selectStyle: React.CSSProperties = { 
  padding: "10px 12px", 
  borderRadius: 8, 
  border: "1px solid #2d2d5f", 
  background: "#0f0f23", 
  color: "#ffffff",
  fontSize: "14px",
  cursor: "pointer",
  width: "100%",
  minWidth: 130,
};

const inputStyle: React.CSSProperties = { 
  padding: "10px 12px", 
  borderRadius: 8, 
  border: "1px solid #2d2d5f", 
  background: "#0f0f23", 
  color: "#ffffff",
  fontSize: "14px",
  width: "100%",
  maxWidth: 150,
  minWidth: 130,
};

const smallInput: React.CSSProperties = { 
  padding: "8px 10px", 
  borderRadius: 6, 
  border: "1px solid #2d2d5f", 
  background: "#0f0f23", 
  color: "#ffffff",
  fontSize: "13px",
  width: 70,
};

const btnStyle: React.CSSProperties = {
  padding: "10px 16px",
  borderRadius: 8,
  border: "1px solid #ffd700",
  background: "#ffd700",
  color: "#000000",
  cursor: "pointer",
  fontSize: "14px",
  fontWeight: "600",
};

const btnGhost: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 6,
  border: "1px solid #2d2d5f",
  background: "transparent",
  color: "#ffffff",
  cursor: "pointer",
  fontSize: "13px",
};

const tag: React.CSSProperties = { 
  padding: "4px 8px", 
  borderRadius: 12, 
  fontSize: 11, 
  fontWeight: "600",
  background: "#ffd700", 
  color: "#000000",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};

const titleStyle: React.CSSProperties = {
  fontSize: 24,
  margin: 0,
  color: "#ffffff",
  fontWeight: "700",
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 14,
  color: "rgba(255, 255, 255, 0.7)",
  margin: "4px 0 0 0",
  fontWeight: "400",
};

const metricCard: React.CSSProperties = {
  background: "#2d2d5f",
  border: "1px solid #3d3d7f",
  borderRadius: 12,
  padding: "12px 16px",
  textAlign: "center",
  minWidth: 80,
};

const tableHeaderStyle: React.CSSProperties = {
  textAlign: "left",
  fontSize: 12,
  color: "#ffd700",
  fontWeight: "600",
  padding: "8px 6px",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};

const tableRowStyle: React.CSSProperties = {
  borderTop: "1px solid #2d2d5f",
};

const tableCellStyle: React.CSSProperties = {
  padding: "8px 6px",
  fontSize: "13px",
};

const prevWeekCard: React.CSSProperties = {
  background: "#2d2d5f",
  border: "1px solid #3d3d7f",
  borderRadius: 8,
  padding: 12,
  marginTop: 12,
};

const prevWeekTitle: React.CSSProperties = {
  fontSize: 11,
  color: "#ffd700",
  textAlign: "center",
  marginBottom: 8,
  fontWeight: "600",
  textTransform: "uppercase",
  letterSpacing: "0.3px",
};

const prevWeekTable: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 10,
};

const prevWeekHeader: React.CSSProperties = {
  textAlign: "center",
  fontSize: 9,
  color: "rgba(255, 215, 0, 0.8)",
  fontWeight: "600",
  padding: "3px 3px",
  textTransform: "uppercase",
  letterSpacing: "0.2px",
};

const prevWeekCell: React.CSSProperties = {
  padding: "3px 3px",
  textAlign: "center",
  fontSize: 10,
  color: "rgba(255, 255, 255, 0.9)",
};

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
      <style>
        {`
          @media (max-width: 480px) {
            .container { padding: 0 8px; }
            .header-card { padding: 12px; }
            .card { padding: 12px; }
            .metric-card { min-width: 60px; padding: 8px 12px; }
            .metric-card div:first-child { font-size: 18px; }
            .metric-card div:last-child { font-size: 9px; }
            .title { font-size: 20px; }
            .subtitle { font-size: 12px; }
            .exercise-name { font-size: 14px; }
            .prev-week-card { padding: 8px; }
            .prev-week-title { font-size: 10px; }
            .prev-week-table { font-size: 9px; }
            .prev-week-header { font-size: 8px; padding: 2px 2px; }
            .prev-week-cell { font-size: 9px; padding: 2px 2px; }
            .table-header { font-size: 11px; padding: 6px 4px; }
            .table-cell { font-size: 12px; padding: 6px 4px; }
            .small-input { width: 50px; }
            .input { max-width: 120px; min-width: 120px; }
            .select { padding: 8px 10px; min-width: 120px; }
            .btn { padding: 8px 12px; font-size: 12px; }
            .btn-ghost { padding: 6px 10px; font-size: 11px; }
            .tag { font-size: 10px; padding: 3px 6px; }
            .header-inputs { flex-direction: column; align-items: stretch; gap: 16; }
            .header-inputs label { min-width: auto; width: 100%; }
            .header-inputs .input, .header-inputs .select { width: 100%; max-width: none; }
            .header-status { margin-top: 16; text-align: center; min-width: auto; }
          }
          
          @media (max-width: 768px) {
            .container { max-width: 100%; }
            .h-row { gap: 8; }
            .exercise-card { flex-direction: column; align-items: stretch; }
            .exercise-right { align-items: center; min-width: auto; }
            .sets-table { font-size: 12px; }
            .timer { flex-direction: column; align-items: stretch; gap: 8; }
            .timer-buttons { justify-content: center; }
            .header-inputs { flex-direction: column; align-items: stretch; gap: 16; }
            .header-inputs label { min-width: auto; width: 100%; }
            .header-inputs .input, .header-inputs .select { width: 100%; max-width: none; }
            .header-status { margin-top: 16; text-align: center; min-width: auto; }
          }
          
          @media (min-width: 769px) {
            .container { max-width: 600px; }
            .exercise-card { flex-direction: row; }
            .exercise-right { align-items: flex-end; }
            .header-inputs { flex-direction: row; align-items: center; }
            .header-status { margin-top: 0; text-align: right; }
          }
        `}
      </style>
      
      <div style={container}>
        {/* Header Section */}
        <header style={headerCard} className="header-card">
          <div style={{ ...hRow, justifyContent: "space-between", marginBottom: 16 }}>
            <div>
              <h1 style={titleStyle} className="title">💪 Workout Buddy</h1>
              <p style={subtitleStyle} className="subtitle">Track your progress, crush your goals</p>
            </div>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <div style={metricCard} className="metric-card">
                <div style={{ fontSize: "20px", fontWeight: "700", color: "#ffd700" }}>
                  {dayExercises.length}
                </div>
                <div style={{ fontSize: "10px", color: "rgba(255, 255, 255, 0.7)", textTransform: "uppercase" }}>
                  EXERCISES
                </div>
              </div>
              <div style={metricCard} className="metric-card">
                <div style={{ fontSize: "20px", fontWeight: "700", color: "#ffd700" }}>
                  {logs.filter(l => l.date === dateStr).length}
                </div>
                <div style={{ fontSize: "10px", color: "rgba(255, 255, 255, 0.7)", textTransform: "uppercase" }}>
                  TODAY
                </div>
              </div>
            </div>
          </div>
          
          <div style={{ ...hRow, justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 16 }} className="header-inputs">
            <div style={{ display: "flex", gap: 25, alignItems: "center", flexWrap: "wrap", minWidth: "300px" }}>
              <label style={{ display: "flex", flexDirection: "column", fontSize: 11, minWidth: "130px" }}>
                <span style={{ marginBottom: 4, color: "#ffd700", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.3px" }}>📅 DATE</span>
                <input
                  type="date"
                  value={dateStr}
                  onChange={(e) => setDateStr(e.target.value)}
                  style={inputStyle}
                  className="input"
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", fontSize: 11, minWidth: "130px" }}>
                <span style={{ marginBottom: 4, color: "#ffd700", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.3px" }}>🔔 NOTIFICATIONS</span>
                <select
                  value={notify ? "on" : "off"}
                  onChange={(e) => setNotify(e.target.value === "on")}
                  style={selectStyle}
                  className="select"
                >
                  <option value="off">Off</option>
                  <option value="on">On</option>
                </select>
              </label>
            </div>
            
            <div style={{ textAlign: "right", minWidth: "120px", marginTop: "8px" }} className="header-status">
              <div style={{ fontSize: 11, color: syncError ? "#ff6b6b" : "#ffd700", fontWeight: "600", marginBottom: 4 }}>
                {isSupabaseConfigured() ? (syncing ? "🔄 Syncing…" : syncError ? `❌ Sync error: ${syncError}` : "✅ Synced with Supabase") : "📱 Offline (no Supabase env)"}
              </div>
              <div style={{ fontSize: 10, color: "rgba(255, 255, 255, 0.5)" }}>
                {new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
              </div>
            </div>
          </div>
        </header>

        {/* Day Selection */}
        <section style={card} className="card">
          <div style={hRow} className="h-row">
            <span style={{ fontSize: 14, color: "#ffd700", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.3px" }}>🎯 SELECT DAY:</span>
            <select
              value={selectedDay}
              onChange={(e) => setSelectedDay(e.target.value as Day)}
              style={selectStyle}
              className="select"
            >
              {DAYS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
        </section>

        {/* Exercises Grid */}
        <section style={{ display: "grid", gap: 16, gridTemplateColumns: "1fr" }}>
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

        {/* Footer */}
        <footer style={{ ...card, textAlign: "center", marginTop: 8 }} className="card">
          <div style={{ ...hRow, justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }} className="h-row">
            <button
              style={btnGhost}
              className="btn-ghost"
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
              🗑️ Clear All Logs
            </button>
            <span style={{ fontSize: 12, color: "rgba(255, 255, 255, 0.7)", fontStyle: "italic" }}>
              💡 Tip: Log each set with reps & weight. Previous sessions auto-fill your sets.
            </span>
          </div>
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
  const prevWeekCutoff = useMemo(() => offsetDateStr(dateStr, -7), [dateStr]);
  const prevWeek = useMemo(() => getLastLogForExercise(ex.id, logs, prevWeekCutoff), [ex.id, logs, prevWeekCutoff]);
  const isSecondsOnly = ex.id === "neck-rotation-iso" && !ex.trackWeight;

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

  function setSetField(idx: number, key: keyof SetEntry, raw: string) {
    setSets((prev) => prev.map((s, i) => {
      if (i !== idx) return s;
      if (raw === "") {
        return { ...s, [key]: Number.NaN } as SetEntry;
      }
      let n = Number(raw);
      if (!Number.isFinite(n)) n = 0;
      if (n < 0) n = 0;
      const next = { ...s } as any;
      next[key] = n;
      return next as SetEntry;
    }));
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
      const roundToStep = (value: number, step: number) => Math.round(value / step) * step;
      const sanitized = sets.map((s) => ({
        reps: Math.max(0, Math.round(Number.isFinite(s.reps) ? s.reps : 0)),
        weight: Math.max(0, roundToStep(Number.isFinite(s.weight) ? s.weight : 0, 0.5)),
      }));
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
    <div style={card} className="card exercise-card">
      <div style={{ ...hRow, justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 12 }} className="h-row">
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: "200px" }}>
          <div style={{ ...hRow, marginBottom: 6 }}>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#ffffff" }} className="exercise-name">{ex.name}</h3>
            <span style={tag} className="tag">{ex.type}</span>
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: "rgba(255, 255, 255, 0.8)" }}>
            {last ? (
              <span>
                📊 Previous ({last.date}): <strong style={{ color: "#ffd700" }}>{summarizeSets(last.sets, ex.trackWeight)}</strong>
              </span>
            ) : (
              <span>🆕 No previous log yet.</span>
            )}
          </div>
        </div>
        
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, minWidth: "120px" }} className="exercise-right">
          <div style={{ ...hRow }}>
            <label style={{ display: "flex", flexDirection: "column", fontSize: 10 }}>
              <span style={{ marginBottom: 3, color: "#ffd700", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.2px" }}>⏱️ RES</span>
              <input
                type="number"
                value={restSec}
                onChange={(e) => updateRest(Number(e.target.value))}
                style={smallInput}
                className="small-input"
                min={10}
                max={999}
              />
            </label>
          </div>
          
          {/* Previous Week (compact) */}
          <div style={prevWeekCard} className="prev-week-card">
            <div style={prevWeekTitle} className="prev-week-title">
              {prevWeek ? (
                <span>📅 Prev week ({prevWeek.date})</span>
              ) : (
                <span>📅 NO PREV W</span>
              )}
            </div>
            {prevWeek?.sets?.length ? (
              <div style={{ overflowX: "auto" }}>
                <table style={prevWeekTable} className="prev-week-table">
                  <thead>
                    <tr>
                      <th style={prevWeekHeader} className="prev-week-header">#</th>
                      <th style={prevWeekHeader} className="prev-week-header">{isSecondsOnly ? "Seconds" : "Reps"}</th>
                      {ex.trackWeight && <th style={prevWeekHeader} className="prev-week-header">Weight</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {prevWeek.sets.map((s, i) => (
                      <tr key={i} style={tableRowStyle}>
                        <td style={prevWeekCell} className="prev-week-cell">{i + 1}</td>
                        <td style={prevWeekCell} className="prev-week-cell">{s.reps}</td>
                        {ex.trackWeight && (
                          <td style={prevWeekCell} className="prev-week-cell">{s.weight}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Sets Table */}
      <div style={{ marginTop: 16 }} className="sets-table">
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={tableHeaderStyle} className="table-header">#</th>
                <th style={tableHeaderStyle} className="table-header">{isSecondsOnly ? "Seconds" : "Reps"}</th>
                {ex.trackWeight && <th style={tableHeaderStyle} className="table-header">Weight (kg)</th>}
                <th style={tableHeaderStyle} className="table-header"></th>
              </tr>
            </thead>
            <tbody>
              {sets.map((s, i) => (
                <tr key={i} style={tableRowStyle}>
                  <td style={tableCellStyle} className="table-cell">{i + 1}</td>
                  <td style={tableCellStyle} className="table-cell">
                    <input
                      type="number"
                      value={Number.isNaN(s.reps) ? "" : s.reps}
                      min={0}
                      onChange={(e) => setSetField(i, "reps", e.target.value)}
                      style={{ ...smallInput, width: 60 }}
                      className="small-input"
                    />
                  </td>
                  {ex.trackWeight && (
                    <td style={tableCellStyle} className="table-cell">
                      <input
                        type="number"
                        value={Number.isNaN(s.weight) ? "" : s.weight}
                        min={0}
                        step={0.5}
                        onChange={(e) => setSetField(i, "weight", e.target.value)}
                        style={{ ...smallInput, width: 70 }}
                        className="small-input"
                      />
                    </td>
                  )}
                  <td style={tableCellStyle} className="table-cell">
                    <button style={btnGhost} className="btn-ghost" onClick={() => removeSet(i)} aria-label={`Remove set ${i + 1}`}>
                      ❌
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ ...hRow, marginTop: 12, gap: 8, flexWrap: "wrap" }} className="h-row">
          <button style={btnGhost} className="btn-ghost" onClick={addSet}>➕ Add Set</button>
          <button style={btnGhost} className="btn-ghost" onClick={prefillLast} disabled={!last?.sets?.length}>
            📋 Prefill Last
          </button>
          <button onClick={saveToday} style={btnStyle} className="btn">
            💾 Save Today
          </button>
        </div>
      </div>

      <div style={{ marginTop: 16 }} className="timer">
        <RestTimer label={ex.name} seconds={restSec} notify={notify} />
      </div>
    </div>
  );
}
