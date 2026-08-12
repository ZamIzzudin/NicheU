'use client';

import { useCallback, useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';

interface WhatsAppStatusData {
  connected: boolean;
  status: string;
  authorizedPhone: string;
  reconnectAttempts: number;
  hasQr?: boolean;
  qrUpdatedAt?: number | null;
  lastError?: string | null;
}

interface QRResponse {
  qr: string | null;
  connected: boolean;
  status?: string;
  qrUpdatedAt?: number | null;
  lastError?: string | null;
}

export default function WhatsAppStatus() {
  const [status, setStatus] = useState<WhatsAppStatusData | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/whatsapp/status');
      if (!response.ok) throw new Error('status failed');
      const data: WhatsAppStatusData = await response.json();
      setStatus(data);
      setError(null);
      return data;
    } catch (err) {
      setError('Failed to fetch status');
      console.error('Status fetch error:', err);
      return null;
    }
  }, []);

  const fetchQR = useCallback(async () => {
    try {
      const response = await fetch('/api/whatsapp/qr');
      if (!response.ok) throw new Error('qr failed');
      const data: QRResponse = await response.json();
      if (data.qr) setQrCode(data.qr);
      else if (data.connected) setQrCode(null);
      setError(null);
      return data;
    } catch (err) {
      setError('Failed to fetch QR code');
      console.error('QR fetch error:', err);
      return null;
    }
  }, []);

  const restartPairing = async () => {
    setRestarting(true);
    setError(null);
    try {
      const response = await fetch('/api/whatsapp/restart', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'restart failed');
      setQrCode(null);
      setStatus(data.status || null);
      setTimeout(() => {
        fetchQR();
        fetchStatus();
      }, 1500);
    } catch (err: any) {
      setError(err.message || 'Failed to restart pairing');
    } finally {
      setRestarting(false);
    }
  };

  useEffect(() => {
    let active = true;
    const boot = async () => {
      setLoading(true);
      await Promise.all([fetchStatus(), fetchQR()]);
      if (active) setLoading(false);
    };
    boot();

    const statusInterval = setInterval(fetchStatus, 3000);
    const qrInterval = setInterval(() => {
      fetchStatus().then((s) => {
        if (!s?.connected) fetchQR();
      });
    }, 4000);

    return () => {
      active = false;
      clearInterval(statusInterval);
      clearInterval(qrInterval);
    };
  }, [fetchStatus, fetchQR]);

  if (loading) {
    return (
      <div className="card-xl flex items-center justify-center p-10">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-sage-deep"></div>
        <span className="ml-3 text-ink-soft">Loading WhatsApp status...</span>
      </div>
    );
  }

  if (status?.connected) {
    return (
      <div className="card-xl space-y-5 p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-sage text-2xl text-white shadow-soft-sm">
              ✓
            </div>
            <div className="ml-4">
              <h3 className="font-display text-xl font-bold text-brown">WhatsApp Connected</h3>
              <p className="text-sm text-ink-soft">Siap terima & kirim pesan proaktif</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-widest text-ink-soft">Authorized</p>
            <p className="font-mono text-sm font-semibold text-brown">{status.authorizedPhone}</p>
          </div>
        </div>
        <button
          onClick={restartPairing}
          disabled={restarting}
          className="btn btn-secondary !px-5 !py-2.5 text-sm disabled:opacity-50"
        >
          {restarting ? 'Restarting...' : 'Logout & re-pair device'}
        </button>
      </div>
    );
  }

  return (
    <div className="card-xl space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-display text-xl font-bold text-brown">WhatsApp Connection</h3>
          <p className="text-sm text-ink-soft">
            Status: <span className="pill-tag mt-1 bg-mustard-pale text-[#8A5B0E]">{status?.status || 'unknown'}</span>
          </p>
        </div>
        <button
          onClick={restartPairing}
          disabled={restarting}
          className="btn btn-accent disabled:opacity-50"
        >
          {restarting ? 'Generating QR...' : 'Restart Pairing / New QR'}
        </button>
      </div>

      {error ? (
        <div className="rounded-md border border-coral/30 bg-coral-pale p-3 text-sm text-[#B4531E]">
          {error}
        </div>
      ) : null}

      {status?.lastError ? (
        <div className="rounded-md border border-mustard/40 bg-mustard-pale p-3 text-sm text-[#8A5B0E]">
          Backend: {status.lastError}
        </div>
      ) : null}

      {status?.reconnectAttempts ? (
        <div className="text-sm text-[#8A5B0E]">Reconnect attempts: {status.reconnectAttempts}</div>
      ) : null}

      {qrCode ? (
        <div className="space-y-5">
          <div className="flex flex-col items-center rounded-lg bg-cream p-6">
            <p className="mb-4 text-center text-sm text-ink-soft">
              Scan QR ini di WhatsApp → Linked Devices
              <br />
              <span className="text-xs text-ink-soft/70">
                (QR digenerate backend Baileys, ditampilkan di UI seperti whatsmeow)
              </span>
            </p>
            <div className="rounded-lg bg-paper p-4 shadow-soft-sm">
              <QRCodeSVG value={qrCode} size={220} level="M" includeMargin={true} />
            </div>
            <p className="mt-3 text-xs text-ink-soft">
              QR refresh otomatis. Kalau expired, klik Restart Pairing.
            </p>
          </div>
          <ol className="list-inside list-decimal space-y-1 text-sm text-ink-soft">
            <li>Buka WhatsApp di HP</li>
            <li>Settings → Linked Devices</li>
            <li>Link a Device</li>
            <li>Scan QR di atas</li>
          </ol>
        </div>
      ) : (
        <div className="space-y-3 rounded-lg bg-cream p-8 text-center">
          <p className="text-ink-soft">Belum ada QR.</p>
          <p className="text-sm text-ink-soft">
            Klik <strong className="text-brown">Restart Pairing / New QR</strong> untuk generate dari
            backend.
          </p>
        </div>
      )}
    </div>
  );
}
