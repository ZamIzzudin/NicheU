'use client';

import { useEffect, useState } from 'react';
import axios from 'axios';
import {
  Tool,
  ToolExecution,
  PersonaProfile,
  DailySchedule,
  DailyMood,
  MoodLabel,
  MoodSnapshot,
} from '../../../shared/types';
import WhatsAppStatus from '../components/WhatsAppStatus';

type Tab = 'whatsapp' | 'persona' | 'mood' | 'schedule' | 'tools';

const MOOD_LABELS: MoodLabel[] = [
  'ceria',
  'romantis',
  'tenang',
  'netral',
  'fokus',
  'semangat',
  'lelah',
  'cemas',
  'sedih',
  'kesal',
];

const STATUS_STYLE: Record<string, string> = {
  planned: 'bg-sage-pale text-sage-deep',
  ongoing: 'bg-coral-pale text-coral',
  done: 'bg-mustard-pale text-[#8A5B0E]',
  skipped: 'bg-cream-deep text-ink-soft',
};

export default function Home() {
  const [tab, setTab] = useState<Tab>('whatsapp');

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'whatsapp', label: 'WhatsApp' },
    { id: 'persona', label: 'Persona' },
    { id: 'mood', label: 'Mood' },
    { id: 'schedule', label: 'Jadwal' },
    { id: 'tools', label: 'Tools' },
  ];

  return (
    <main className="min-h-screen">
      {/* HERO */}
      <header className="relative overflow-hidden px-5 pb-10 pt-12 md:px-8">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(circle at 85% 10%, #FBE7B8 0%, transparent 45%), radial-gradient(circle at 8% 85%, #D9E4C6 0%, transparent 45%)',
          }}
        />
        <div className="relative mx-auto max-w-6xl">
          <span className="eyebrow">● Niche Daily</span>
          <h1 className="mt-3 font-display text-4xl font-extrabold leading-[1.05] tracking-tight text-brown md:text-6xl">
            Partner agent <span className="text-coral">WhatsApp</span> kamu
          </h1>
          <p className="mt-4 max-w-xl text-ink-soft">
            Kepribadian, mood harian, jadwal, memory, dan pencarian web — semua hidup dalam satu bot
            WhatsApp.
          </p>
        </div>
      </header>

      {/* TABS */}
      <div className="mx-auto max-w-6xl px-5 md:px-8">
        <div className="mb-8 flex flex-wrap gap-2">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-pill px-5 py-2.5 text-sm font-semibold transition-all ${
                tab === t.id
                  ? 'bg-brown text-cream shadow-soft-sm'
                  : 'border border-ink/10 bg-paper text-brown hover:bg-cream-deep'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'whatsapp' && <WhatsAppStatus />}
        {tab === 'persona' && <PersonaPanel />}
        {tab === 'mood' && <MoodPanel />}
        {tab === 'schedule' && <SchedulePanel />}
        {tab === 'tools' && <ToolsPanel />}
      </div>

      <footer className="px-8 pb-16 pt-10 text-center text-[13px] text-ink-soft">
        Niche Daily — Serene Design
      </footer>
    </main>
  );
}

/* ============================== MOOD ============================== */

function MoodPanel() {
  const [mood, setMood] = useState<DailyMood | null>(null);
  const [history, setHistory] = useState<DailyMood[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [label, setLabel] = useState<MoodLabel>('netral');
  const [note, setNote] = useState('');
  const [valence, setValence] = useState(0.1);
  const [energy, setEnergy] = useState(0.45);

  const load = async () => {
    setLoading(true);
    try {
      const [todayRes, histRes] = await Promise.all([
        axios.get('/api/mood/today'),
        axios.get('/api/mood/history?days=7'),
      ]);
      const m: DailyMood | null = todayRes.data.mood || null;
      setMood(m);
      setHistory(histRes.data.history || []);
      if (m?.current) {
        setLabel(m.current.label);
        setNote(m.current.note || '');
        setValence(m.current.valence);
        setEnergy(m.current.energy);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const res = await axios.put('/api/mood', { label, note, valence, energy });
      setMood(res.data.mood);
      await load();
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Gagal update mood');
    } finally {
      setSaving(false);
    }
  };

  const regenerate = async () => {
    setSaving(true);
    try {
      const res = await axios.post('/api/mood/regenerate');
      setMood(res.data.mood);
      await load();
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Gagal regenerate mood');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Card>Loading mood...</Card>;
  if (!mood) {
    return (
      <Card>
        <h2 className="mb-2 font-display text-2xl font-bold text-brown">Belum ada mood</h2>
        <p className="mb-4 text-ink-soft">
          Mood digenerate setelah onboarding persona, atau tekan regenerate di bawah.
        </p>
        <button onClick={regenerate} disabled={saving} className="btn btn-accent disabled:opacity-50">
          Generate mood hari ini
        </button>
      </Card>
    );
  }

  const c: MoodSnapshot = mood.current;

  return (
    <div className="space-y-6">
      {/* Mood utama */}
      <div className="card-xl flex flex-col items-center gap-6 p-6 md:flex-row">
        <div
          className="flex h-28 w-28 shrink-0 items-center justify-center rounded-full text-6xl shadow-soft-sm"
          style={{ backgroundColor: c.color }}
        >
          {c.emoji}
        </div>
        <div className="flex-1 text-center md:text-left">
          <p className="text-xs uppercase tracking-widest text-ink-soft">Mood hari ini · {mood.date}</p>
          <h2 className="mt-1 font-display text-4xl font-bold capitalize text-brown">
            {c.label}
          </h2>
          <p className="mt-1 max-w-2xl text-ink-soft">{c.note}</p>
          <p className="mt-2 text-xs text-ink-soft">{c.speechHint}</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <span className="pill-tag bg-sage-pale text-sage-deep">Valence {c.valence.toFixed(2)}</span>
          <span className="pill-tag bg-mustard-pale text-[#8A5B0E]">Energy {c.energy.toFixed(2)}</span>
          <span className="pill-tag bg-coral-pale text-[#B4531E]">{c.color}</span>
        </div>
      </div>

      {/* Atur mood */}
      <Card>
        <h3 className="mb-3 font-display text-xl font-bold text-brown">Atur mood (manual)</h3>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="text-sm text-ink-soft">Label</label>
            <select
              className="mt-1 w-full rounded-md border border-ink/15 bg-paper px-3 py-2 text-ink"
              value={label}
              onChange={(e) => setLabel(e.target.value as MoodLabel)}
            >
              {MOOD_LABELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-sm text-ink-soft">Catatan</label>
            <input
              className="mt-1 w-full rounded-md border border-ink/15 bg-paper px-3 py-2 text-ink"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Kenapa moodnya seperti ini..."
            />
          </div>
          <div>
            <label className="text-sm text-ink-soft">Valence ({valence.toFixed(2)})</label>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.05}
              value={valence}
              onChange={(e) => setValence(Number(e.target.value))}
              className="mt-2 w-full accent-[#5E7A3E]"
            />
          </div>
          <div>
            <label className="text-sm text-ink-soft">Energy ({energy.toFixed(2)})</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={energy}
              onChange={(e) => setEnergy(Number(e.target.value))}
              className="mt-2 w-full accent-[#EA7A41]"
            />
          </div>
        </div>
        <div className="mt-4 flex gap-3">
          <button onClick={save} disabled={saving} className="btn btn-primary disabled:opacity-50">
            {saving ? 'Saving...' : 'Simpan mood'}
          </button>
          <button onClick={regenerate} disabled={saving} className="btn btn-secondary disabled:opacity-50">
            Regenerate AI
          </button>
        </div>
      </Card>

      {/* Riwayat hari ini */}
      <Card>
        <h3 className="mb-3 font-display text-xl font-bold text-brown">Riwayat mood hari ini</h3>
        {mood.history?.length ? (
          <div className="max-h-72 space-y-2 overflow-auto pr-1">
            {[...mood.history].reverse().map((h, i) => (
              <div key={i} className="flex items-center gap-3 rounded-md bg-cream px-3 py-2.5">
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg"
                  style={{ backgroundColor: h.color }}
                >
                  {h.emoji}
                </div>
                <div className="flex-1">
                  <div className="font-semibold capitalize text-brown">
                    {h.label} · <span className="text-xs font-normal text-ink-soft">{h.source}</span>
                  </div>
                  <div className="text-xs text-ink-soft">{h.note}</div>
                </div>
                <div className="whitespace-nowrap text-xs text-ink-soft">
                  {new Date(h.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-ink-soft">Belum ada history</p>
        )}
      </Card>

      {/* 7 hari terakhir */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-display text-xl font-bold text-brown">7 hari terakhir</h3>
          <span className="pill-tag bg-mustard-pale text-[#8A5B0E]">This week</span>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {history.map((d) => (
            <div key={d.date} className="flex flex-col items-center">
              <div
                className="flex h-14 w-14 items-center justify-center rounded-full text-2xl shadow-soft-sm"
                style={{ backgroundColor: d.current.color }}
                title={d.current.color}
              >
                {d.current.emoji}
              </div>
              <div className="mt-1 text-center text-xs font-semibold capitalize text-brown-soft">
                {d.current.label}
              </div>
              <div className="text-[10px] text-ink-soft">{d.date.slice(5)}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/* ============================== PERSONA ============================== */

function PersonaPanel() {
  const [persona, setPersona] = useState<PersonaProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    axios
      .get('/api/persona')
      .then((res) => setPersona(res.data.persona))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Card>Loading persona...</Card>;
  if (!persona) {
    return (
      <Card>
        <h2 className="mb-2 font-display text-2xl font-bold text-brown">Belum onboard</h2>
        <p className="text-ink-soft">
          Kirim pesan WhatsApp ke bot. Dia akan minta kamu perkenalkan siapa dia (nama, peran,
          sifat, gaya bicara).
        </p>
      </Card>
    );
  }

  return (
    <Card className="!p-6">
      <span className="eyebrow mb-4">● Persona</span>
      <h2 className="mb-5 font-display text-3xl font-bold text-brown">{persona.name}</h2>
      <div className="grid gap-4 text-sm md:grid-cols-2">
        <Info label="Role" value={persona.role} />
        <Info label="Relasi" value={persona.relationshipToUser} />
        <Info label="User" value={persona.userName || '-'} />
        <Info label="Timezone" value={persona.timezone} />
        <div className="md:col-span-2">
          <Info label="Gaya bicara" value={persona.speechStyle} />
        </div>
        <div className="md:col-span-2">
          <Info label="Traits" value={persona.traits?.join(', ') || '-'} />
        </div>
        <div className="md:col-span-2">
          <Info label="Boundaries" value={persona.boundaries || '-'} />
        </div>
      </div>
    </Card>
  );
}

/* ============================== SCHEDULE ============================== */

function SchedulePanel() {
  const [schedule, setSchedule] = useState<DailySchedule | null>(null);
  const [context, setContext] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    axios
      .get('/api/schedule/today')
      .then((res) => {
        setSchedule(res.data.schedule);
        setContext(res.data.context || '');
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Card>Loading schedule...</Card>;
  if (!schedule) return <Card>Belum ada jadwal. Onboard persona dulu via WhatsApp.</Card>;

  return (
    <div className="space-y-6">
      <Card className="!p-6">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-2xl font-bold text-brown">Jadwal {schedule.date}</h2>
          <span className="pill-tag bg-sage-pale text-sage-deep">{schedule.moodLabel || 'hari'}</span>
        </div>
        <p className="mb-5 text-ink-soft">{schedule.summary}</p>
        <div className="space-y-2.5">
          {schedule.activities?.map((a) => (
            <div
              key={a.id}
              className="flex items-start justify-between gap-3 rounded-md bg-cream px-4 py-3"
            >
              <div>
                <div className="font-semibold text-brown">{a.title}</div>
                {a.description ? (
                  <div className="text-sm text-ink-soft">{a.description}</div>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <span className="text-xs whitespace-nowrap text-ink-soft">
                  {new Date(a.startAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  {' - '}
                  {new Date(a.endAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className={`pill-tag ${STATUS_STYLE[a.status] || 'bg-cream-deep text-ink-soft'}`}>
                  {a.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-display text-lg font-bold text-brown">Context text</h3>
          <span className="pill-tag bg-sage-pale text-sage-deep">prompt</span>
        </div>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-cream p-4 text-xs text-ink-soft">
          {context}
        </pre>
      </Card>
    </div>
  );
}

/* ============================== TOOLS ============================== */

function ToolsPanel() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [selectedTool, setSelectedTool] = useState<Tool | null>(null);
  const [executions, setExecutions] = useState<ToolExecution[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  const fetchTools = async () => {
    const res = await axios.get('/api/tools');
    setTools(res.data.tools || []);
  };

  useEffect(() => {
    fetchTools().catch(console.error);
  }, []);

  const toggle = async (tool: Tool) => {
    await axios.put(`/api/tools/${tool.id}`, { enabled: !tool.enabled });
    fetchTools();
  };

  const openDetails = async (tool: Tool) => {
    setSelectedTool(tool);
    const res = await axios.get(`/api/tools/${tool.id}`);
    setExecutions(res.data.executionHistory || []);
  };

  const remove = async (id: string) => {
    if (!confirm('Hapus tool ini?')) return;
    await axios.delete(`/api/tools/${id}`);
    setSelectedTool(null);
    fetchTools();
  };

  return (
    <div>
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard tone="brown" label="Total Tools" value={tools.length} />
        <StatCard tone="sage" label="Aktif" value={tools.filter((t) => t.enabled).length} />
        <StatCard tone="mustard" label="Custom" value={tools.filter((t) => t.category === 'custom').length} />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {tools.map((tool) => (
          <div key={tool.id} className="card flex flex-col p-5">
            <div className="mb-2 flex items-start justify-between gap-2">
              <div>
                <h3 className="font-display text-lg font-bold text-brown">{tool.name}</h3>
                <span className="pill-tag mt-1 bg-sage-pale text-sage-deep">
                  {tool.category} · {tool.source || 'n/a'}
                </span>
              </div>
              <input
                type="checkbox"
                checked={tool.enabled}
                onChange={() => toggle(tool)}
                className="mt-1 h-5 w-5 accent-[#5E7A3E]"
              />
            </div>
            <p className="mb-4 line-clamp-3 flex-1 text-sm text-ink-soft">{tool.description}</p>
            <div className="flex gap-2">
              <button
                onClick={() => openDetails(tool)}
                className="flex-1 rounded-pill bg-sage-pale py-2 text-sm font-semibold text-sage-deep transition-colors hover:bg-sage hover:text-white"
              >
                Detail
              </button>
              {!tool.builtin && (
                <button
                  onClick={() => remove(tool.id)}
                  className="px-3 text-sm font-semibold text-coral hover:underline"
                >
                  Hapus
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <button onClick={() => setShowCreate(true)} className="fab" aria-label="Buat tool">
        +
      </button>

      {selectedTool && (
        <Modal onClose={() => setSelectedTool(null)} title={selectedTool.name}>
          <p className="mb-4 text-ink-soft">{selectedTool.description}</p>
          <h4 className="mb-2 font-display text-lg font-bold text-brown">Parameters</h4>
          <pre className="mb-4 overflow-auto rounded-md bg-cream p-3 text-xs text-ink-soft">
            {JSON.stringify(selectedTool.parameters, null, 2)}
          </pre>
          <h4 className="mb-2 font-display text-lg font-bold text-brown">Recent executions</h4>
          {executions.length === 0 ? (
            <p className="text-sm text-ink-soft">Belum ada</p>
          ) : (
            <div className="max-h-64 space-y-2 overflow-auto pr-1">
              {executions.map((e, i) => (
                <div key={i} className="rounded-md bg-cream p-2.5 text-xs">
                  <div className="mb-1 flex justify-between">
                    <span
                      className={`pill-tag ${
                        e.success ? 'bg-sage-pale text-sage-deep' : 'bg-coral-pale text-coral'
                      }`}
                    >
                      {e.success ? 'success' : 'failed'}
                    </span>
                    <span className="text-ink-soft">
                      {new Date(e.timestamp).toLocaleString()}
                    </span>
                  </div>
                  <pre className="overflow-auto text-ink-soft">
                    {JSON.stringify(e.parameters, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}

      {showCreate && (
        <CreateToolModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            fetchTools();
          }}
        />
      )}
    </div>
  );
}

function CreateToolModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [functionCode, setFunctionCode] = useState(
    `async function execute({ input }) {\n  return { ok: true, input };\n}`
  );
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await axios.post('/api/tools', {
        name,
        description,
        category: 'custom',
        functionCode,
        parameters: [],
      });
      onCreated();
    } catch (error: any) {
      alert(error?.response?.data?.error || 'Failed to create tool');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} title="Create Custom Tool">
      <form onSubmit={submit} className="space-y-3">
        <input
          className="w-full rounded-md border border-ink/15 bg-paper px-3 py-2 text-ink"
          placeholder="tool_name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <textarea
          className="w-full rounded-md border border-ink/15 bg-paper px-3 py-2 text-ink"
          placeholder="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
        />
        <textarea
          className="w-full rounded-md border border-ink/15 bg-paper px-3 py-2 font-mono text-sm"
          rows={10}
          value={functionCode}
          onChange={(e) => setFunctionCode(e.target.value)}
          required
        />
        <div className="flex gap-3">
          <button type="button" onClick={onClose} className="btn btn-secondary flex-1 justify-center">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="btn btn-primary flex-1 justify-center disabled:opacity-50">
            {busy ? 'Saving...' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ============================== SHARED ============================== */

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`card p-5 ${className}`}>{children}</div>;
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-cream px-4 py-3">
      <div className="text-[11px] uppercase tracking-widest text-ink-soft">{label}</div>
      <div className="mt-0.5 text-brown">{value}</div>
    </div>
  );
}

function StatCard({
  tone,
  label,
  value,
}: {
  tone: 'brown' | 'sage' | 'mustard';
  label: string;
  value: number;
}) {
  const tones: Record<string, string> = {
    brown: 'bg-brown text-cream',
    sage: 'bg-sage-deep text-white',
    mustard: 'bg-mustard text-brown',
  };
  return (
    <div className={`flex min-h-[150px] flex-col justify-between rounded-xl p-6 shadow-soft ${tones[tone]}`}>
      <div className="text-sm opacity-85">{label}</div>
      <div>
        <div className="font-display text-5xl font-extrabold">{value}</div>
        <div className="text-[13px] opacity-80">Niche Daily</div>
      </div>
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-brown/40 p-4">
      <div className="card-xl max-h-[90vh] w-full max-w-2xl overflow-y-auto">
        <div className="sticky top-0 flex items-center justify-between border-b border-ink/10 bg-paper p-5">
          <h2 className="font-display text-xl font-bold text-brown">{title}</h2>
          <button onClick={onClose} className="text-2xl text-ink-soft hover:text-brown">
            ×
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
