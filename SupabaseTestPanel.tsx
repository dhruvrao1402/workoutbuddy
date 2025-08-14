import { supabase } from "../lib/supabase";

export default function SupabaseTestPanel() {
  async function testWrite() {
    const id = "test_" + Math.random().toString(36).slice(2);
    const { error } = await supabase
      .from("sessions")
      .insert({
        id,
        date: new Date().toISOString().slice(0, 10),
        template_day: "Test",
      });
    alert(error ? `Insert failed: ${error.message}` : "Insert OK");
  }

  async function testRead() {
    const { data, error } = await supabase
      .from("sessions")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(3);
    console.log({ data, error });
    alert(error ? `Select failed: ${error.message}` : `Read OK: ${data?.length} rows`);
  }

  return (
    <div className="p-3 rounded-xl border bg-white mt-4">
      <div className="font-medium mb-2">Supabase test</div>
      <div className="flex gap-2 flex-wrap">
        <button className="rounded-xl border px-3 py-2" onClick={testWrite}>
          Test write
        </button>
        <button className="rounded-xl border px-3 py-2" onClick={testRead}>
          Test read
        </button>
      </div>
    </div>
  );
}
