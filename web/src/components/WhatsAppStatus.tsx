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
      // keep previous QR briefly if reconnecting without new one yet
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
      // Baileys needs a moment to emit QR
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
      <div className="bg-white rounded-xl shadow-lg p-6">
        <div className="flex items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          <span className="ml-3 text-gray-600">Loading WhatsApp status...</span>
        </div>
      </div>
    );
  }

  if (status?.connected) {
    return (
      <div className="bg-white rounded-xl shadow-lg p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center">
            <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center text-sm font-bold text-green-700">
              OK
            </div>
            <div className="ml-4">
              <h3 className="text-lg font-bold text-gray-900">WhatsApp Connected</h3>
              <p className="text-sm text-gray-600">Siap terima & kirim pesan proaktif</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-sm text-gray-500">Authorized</p>
            <p className="font-mono text-sm font-medium text-gray-900">{status.authorizedPhone}</p>
          </div>
        </div>
        <button
          onClick={restartPairing}
          disabled={restarting}
          className="text-sm text-red-600 hover:underline disabled:opacity-50"
        >
          {restarting ? 'Restarting...' : 'Logout & re-pair device'}
        </button>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-bold text-gray-900">WhatsApp Connection</h3>
          <p className="text-sm text-gray-500">
            Status: <span className="font-medium">{status?.status || 'unknown'}</span>
          </p>
        </div>
        <button
          onClick={restartPairing}
          disabled={restarting}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          {restarting ? 'Generating QR...' : 'Restart Pairing / New QR'}
        </button>
      </div>

      {error ? (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {status?.lastError ? (
        <div className="mb-4 bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-800">
          Backend: {status.lastError}
        </div>
      ) : null}

      {status?.reconnectAttempts ? (
        <div className="mb-4 text-sm text-yellow-700">
          Reconnect attempts: {status.reconnectAttempts}
        </div>
      ) : null}

      {qrCode ? (
        <div className="space-y-4">
          <div className="bg-gray-50 rounded-lg p-6 flex flex-col items-center">
            <p className="text-sm text-gray-600 mb-4 text-center">
              Scan QR ini di WhatsApp → Linked Devices
              <br />
              <span className="text-xs text-gray-500">
                (QR digenerate backend Baileys, ditampilkan di UI seperti whatsmeow)
              </span>
            </p>
            <div className="bg-white p-4 rounded-lg shadow-sm">
              <QRCodeSVG value={qrCode} size={220} level="M" includeMargin={true} />
            </div>
            <p className="text-xs text-gray-500 mt-3">
              QR refresh otomatis. Kalau expired, klik Restart Pairing.
            </p>
          </div>
          <ol className="text-sm text-gray-700 list-decimal list-inside space-y-1">
            <li>Buka WhatsApp di HP</li>
            <li>Settings → Linked Devices</li>
            <li>Link a Device</li>
            <li>Scan QR di atas</li>
          </ol>
        </div>
      ) : (
        <div className="bg-gray-50 rounded-lg p-8 text-center space-y-3">
          <p className="text-gray-600">Belum ada QR.</p>
          <p className="text-sm text-gray-500">
            Klik <strong>Restart Pairing / New QR</strong> untuk generate dari backend.
          </p>
        </div>
      )}
    </div>
  );
}
