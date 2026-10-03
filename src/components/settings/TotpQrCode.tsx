import { useMemo } from 'react';
import { encode } from 'uqr';

/** QR code of an otpauth:// URI, drawn locally so the secret never leaves the browser. */
export function TotpQrCode({ uri }: { uri: string }) {
  const qr = useMemo(() => encode(uri, { ecc: 'M', border: 4 }), [uri]);
  const path = useMemo(() => qr.data.flatMap((row, y) => row.map((dark, x) => (dark ? `M${x} ${y}h1v1h-1z` : ''))).join(''), [qr]);
  return (
    // Fixed black on white in both themes: authenticator apps do not all read inverted codes.
    <svg
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      role="img"
      aria-label="QR code for your authenticator app"
      className="h-48 w-48 shrink-0 rounded-md border border-border"
      shapeRendering="crispEdges"
    >
      <rect width={qr.size} height={qr.size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
