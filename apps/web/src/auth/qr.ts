// Tiny wrapper around `qrcode` so the setup view can render a QR for
// an otpauth:// URI. Returns an SVG string that the caller injects via
// dangerouslySetInnerHTML — qrcode's `toString` with type='svg'
// produces a static, sandbox-safe SVG (no scripts, no external refs).

import QRCode from 'qrcode';

export async function qrToSvg(content: string): Promise<string> {
  return QRCode.toString(content, {
    type: 'svg',
    margin: 0,
    width: 192,
    errorCorrectionLevel: 'M',
    color: { dark: '#0f172a', light: '#ffffff' },
  });
}
