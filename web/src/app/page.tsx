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
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      <div className="container mx-auto px-4 py-8 max-w-6xl">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">Niche Daily</h1>
          <p className="text-gray-600">
            Partner agent WhatsApp dengan kepribadian, mood harian, jadwal, memory, dan self-tools
          </p>
        </div>

        <div className="mb-6 flex gap-2 flex-wrap">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 rounded-full transition-all ${
                tab === t.id
                  ? 'bg-blue-600 text-white shadow-lg'
                  : 'bg-white text-gray-700 hover:bg-gray-50'
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
    </div>
  );
}

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
        <h2 className="text-xl font-bold mb-2">Belum ada mood</h2>
        <p className="text-gray-600 mb-4">
          Mood digenerate setelah onboarding persona, atau tekan regenerate di bawah.
        </p>
        <button
          onClick={regenerate}
          disabled={saving}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50"
        >
          Generate mood hari ini
        </button>
      </Card>
    );
  }

  const c: MoodSnapshot = mood.current;

  return (
    <div className="space-y-4">
      <div
        className="rounded-2xl shadow-lg p-6 text-white"
        style={{
          background: `linear-gradient(135deg, ${c.color} 0%, ${shade(c.color, -25)} 100%)`,
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm/none opacity-90 mb-2">Mood hari ini · {mood.date}</p>
            <h2 className="text-3xl font-bold capitalize">
              {c.emoji} {c.label}
            </h2>
            <p className="mt-2 max-w-2xl opacity-95">{c.note}</p>
          </div>
          <div
            className="w-16 h-16 rounded-full border-4 border-white/40 shadow-inner"
            style={{ backgroundColor: c.color }}
            title={c.color}
          />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-6">
          <Metric label="Warna" value={c.color} />
          <Metric label="Valence" value={c.valence.toFixed(2)} />
          <Metric label="Energy" value={c.energy.toFixed(2)} />
          <Metric label="Speech" value={c.speechHint.slice(0, 42) + (c.speechHint.length > 42 ? '…' : '')} />
        </div>
      </div>

      <Card>
        <h3 className="font-bold text-lg mb-3">Atur mood (manual)</h3>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="text-sm text-gray-600">Label</label>
            <select
              className="w-full border rounded-lg px-3 py-2 mt-1"
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
            <label className="text-sm text-gray-600">Catatan</label>
            <input
              className="w-full border rounded-lg px-3 py-2 mt-1"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Kenapa moodnya seperti ini..."
            />
          </div>
          <div>
            <label className="text-sm text-gray-600">Valence ({valence.toFixed(2)})</label>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.05}
              value={valence}
              onChange={(e) => setValence(Number(e.target.value))}
              className="w-full mt-2"
            />
          </div>
          <div>
            <label className="text-sm text-gray-600">Energy ({energy.toFixed(2)})</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={energy}
              onChange={(e) => setEnergy(Number(e.target.value))}
              className="w-full mt-2"
            />
          </div>
        </div>
        <div className="flex gap-2 mt-4">
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Simpan mood'}
          </button>
          <button
            onClick={regenerate}
            disabled={saving}
            className="px-4 py-2 border rounded-lg disabled:opacity-50"
          >
            Regenerate AI
          </button>
        </div>
      </Card>

      <Card>
        <h3 className="font-bold text-lg mb-3">Riwayat mood hari ini</h3>
        {mood.history?.length ? (
          <div className="space-y-2 max-h-72 overflow-auto">
            {[...mood.history].reverse().map((h, i) => (
              <div key={i} className="flex items-center gap-3 bg-gray-50 rounded-lg p-3">
                <div className="w-4 h-4 rounded-full" style={{ backgroundColor: h.color }} />
                <div className="flex-1">
                  <div className="font-medium capitalize">
                    {h.label} · <span className="text-xs text-gray-500">{h.source}</span>
                  </div>
                  <div className="text-xs text-gray-600">{h.note}</div>
                </div>
                <div className="text-xs text-gray-500 whitespace-nowrap">
                  {new Date(h.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-gray-500 text-sm">Belum ada history</p>
        )}
      </Card>

      <Card>
        <h3 className="font-bold text-lg mb-3">7 hari terakhir</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
          {history.map((d) => (
            <div key={d.date} className="rounded-xl p-3 text-white" style={{ backgroundColor: d.current.color }}>
              <div className="text-xs opacity-90">{d.date.slice(5)}</div>
              <div className="font-bold capitalize mt-1">
                {d.current.emoji} {d.current.label}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white/15 rounded-xl p-3 backdrop-blur-sm">
      <div className="text-xs opacity-80">{label}</div>
      <div className="font-semibold text-sm mt-1 break-all">{value}</div>
    </div>
  );
}

function shade(hex: string, percent: number): string {
  const raw = hex.replace('#', '');
  if (raw.length !== 6) return hex;
  const num = parseInt(raw, 16);
  const r = Math.min(255, Math.max(0, (num >> 16) + Math.round(2.55 * percent)));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0xff) + Math.round(2.55 * percent)));
  const b = Math.min(255, Math.max(0, (num & 0xff) + Math.round(2.55 * percent)));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

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
        <h2 className="text-xl font-bold mb-2">Belum onboard</h2>
        <p className="text-gray-600">
          Kirim pesan WhatsApp ke bot. Dia akan minta kamu perkenalkan siapa dia (nama, peran,
          sifat, gaya bicara).
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <h2 className="text-2xl font-bold mb-4">{persona.name}</h2>
      <div className="grid md:grid-cols-2 gap-4 text-sm">
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
    <div className="space-y-4">
      <Card>
        <h2 className="text-xl font-bold mb-1">Jadwal {schedule.date}</h2>
        <p className="text-gray-600 mb-4">{schedule.summary}</p>
        <div className="space-y-2">
          {schedule.activities?.map((a) => (
            <div key={a.id} className="bg-gray-50 rounded-lg p-3 flex items-start justify-between gap-3">
              <div>
                <div className="font-medium text-gray-900">{a.title}</div>
                {a.description ? <div className="text-sm text-gray-600">{a.description}</div> : null}
              </div>
              <div className="text-right text-xs text-gray-500 whitespace-nowrap">
                <div>{new Date(a.startAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  {' - '}
                  {new Date(a.endAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
                <div className="mt-1 uppercase tracking-wide">{a.status}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <h3 className="font-bold mb-2">Context text</h3>
        <pre className="text-xs whitespace-pre-wrap text-gray-700">{context}</pre>
      </Card>
    </div>
  );
}

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
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Stat label="Total" value={tools.length} />
        <Stat label="Aktif" value={tools.filter((t) => t.enabled).length} />
        <Stat label="Custom" value={tools.filter((t) => t.category === 'custom').length} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {tools.map((tool) => (
          <div key={tool.id} className="bg-white rounded-xl shadow p-5">
            <div className="flex justify-between items-start mb-2">
              <div>
                <h3 className="font-bold text-gray-900">{tool.name}</h3>
                <p className="text-xs text-gray-500">{tool.category} · {tool.source || 'n/a'}</p>
              </div>
              <input type="checkbox" checked={tool.enabled} onChange={() => toggle(tool)} />
            </div>
            <p className="text-sm text-gray-600 mb-4 line-clamp-3">{tool.description}</p>
            <div className="flex gap-2">
              <button
                onClick={() => openDetails(tool)}
                className="flex-1 bg-blue-50 text-blue-700 rounded-lg py-2 text-sm"
              >
                Detail
              </button>
              {!tool.builtin && (
                <button onClick={() => remove(tool.id)} className="px-3 text-red-600 text-sm">
                  Hapus
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={() => setShowCreate(true)}
        className="fixed bottom-8 right-8 w-14 h-14 bg-blue-600 text-white rounded-full shadow-lg text-3xl"
      >
        +
      </button>

      {selectedTool && (
        <Modal onClose={() => setSelectedTool(null)} title={selectedTool.name}>
          <p className="text-gray-600 mb-4">{selectedTool.description}</p>
          <h4 className="font-bold mb-2">Parameters</h4>
          <pre className="text-xs bg-gray-50 p-3 rounded mb-4 overflow-auto">
            {JSON.stringify(selectedTool.parameters, null, 2)}
          </pre>
          <h4 className="font-bold mb-2">Recent executions</h4>
          {executions.length === 0 ? (
            <p className="text-gray-500 text-sm">Belum ada</p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-auto">
              {executions.map((e, i) => (
                <div key={i} className="bg-gray-50 rounded p-2 text-xs">
                  <div className="flex justify-between mb-1">
                    <span>{e.success ? 'success' : 'failed'}</span>
                    <span>{new Date(e.timestamp).toLocaleString()}</span>
                  </div>
                  <pre className="overflow-auto">{JSON.stringify(e.parameters, null, 2)}</pre>
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
          className="w-full border rounded-lg px-3 py-2"
          placeholder="tool_name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <textarea
          className="w-full border rounded-lg px-3 py-2"
          placeholder="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
        />
        <textarea
          className="w-full border rounded-lg px-3 py-2 font-mono text-sm"
          rows={10}
          value={functionCode}
          onChange={(e) => setFunctionCode(e.target.value)}
          required
        />
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 border rounded-lg py-2">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="flex-1 bg-blue-600 text-white rounded-lg py-2 disabled:opacity-50"
          >
            {busy ? 'Saving...' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="bg-white rounded-xl shadow-lg p-6">{children}</div>;
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-gray-900">{value}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-white rounded-xl shadow p-5">
      <div className="text-3xl font-bold text-blue-600">{value}</div>
      <div className="text-gray-600">{label}</div>
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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-5 border-b flex items-center justify-between sticky top-0 bg-white">
          <h2 className="text-xl font-bold">{title}</h2>
          <button onClick={onClose} className="text-2xl text-gray-500">
            ×
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
