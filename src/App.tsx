import { supabase } from "./lib/supabase";
import { useEffect, useState } from "react";

function SupabaseTestPanel() {
  const [email, setEmail] = useState("");
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUser(data.user));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) =>
      setUser(session?.user ?? null)
    );
    return () => sub?.subscription?.unsubscribe();
  }, []);

  async function sendMagicLink() {
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin } });
    alert(error ? error.message : "Magic link sent. Check your email.");
  }

  async function testWrite() {
    // Sessions.user_id has default auth.uid(), so no need to set it explicitly
    <button onClick={testWrite}>Test Supabase Write</button>
    const id = "test_" + Math.random().toString(36).slice(2);
    const { error } = await supabase.from("sessions").insert({ id, date: new Date().toISOString().slice(0,10), template_day: "Test" });
    alert(error ? `Insert failed: ${error.message}` : "Insert OK");
  }

  async function testRead() {
    <button onClick={testRead}>Test Supabase Read</button>
    const { data, error } = await supabase.from("sessions").select("*").order("created_at", { ascending: false }).limit(3);
    console.log({ data, error });
    alert(error ? `Select failed: ${error.message}` : `Read OK: ${data?.length} rows`);
  }

  async function signOut() {
    await supabase.auth.signOut();
    setUser(null);
  }

  return (
    <div className="p-3 rounded-xl border bg-white mt-4">
      <div className="font-medium mb-2">Supabase test</div>
      {!user ? (
        <div className="flex gap-2">
          <input className="border rounded-xl px-3 py-2 flex-1" placeholder="email@domain.com" value={email} onChange={(e)=>setEmail(e.target.value)} />
          <button className="rounded-xl border px-3 py-2" onClick={sendMagicLink}>Send magic link</button>
          <button className="rounded-xl border px-3 py-2" onClick={testSupabaseEnv}>Ping</button>
        </div>
      ) : (
        <div className="flex gap-2 flex-wrap">
          <span className="text-sm opacity-70">Signed in</span>
          <button className="rounded-xl border px-3 py-2" onClick={testWrite}>Test write</button>
          <button className="rounded-xl border px-3 py-2" onClick={testRead}>Test read</button>
          <button className="rounded-xl border px-3 py-2" onClick={signOut}>Sign out</button>
        </div>
      )}
    </div>
  );
}
