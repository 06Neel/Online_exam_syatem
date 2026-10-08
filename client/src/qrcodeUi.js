// Scannable QR codes for the join link (teacher dashboard + Home).
import QRCode from 'qrcode';
import { h } from './ui.js';

export function joinUrl(code) {
  return `${location.origin}${location.pathname}#/join?code=${encodeURIComponent(code)}`;
}

/** Render a QR image for `url`. Shows a placeholder box until the code resolves. */
export function qrImg(url, size = 150) {
  const box = h('div', { class: 'qr' });
  QRCode.toDataURL(url, {
    width: size,
    margin: 1,
    color: { dark: '#17181c', light: '#ffffff' },
  })
    .then((dataUrl) => {
      box.append(h('img', {
        src: dataUrl, width: String(size), height: String(size),
        alt: 'QR code - scan to join the quiz',
      }));
    })
    .catch(() => { box.remove(); });
  return box;
}

/** Copy helper with a boolean result; falls back to a hidden textarea where needed. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
