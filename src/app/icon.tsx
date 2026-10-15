import { ImageResponse } from "next/og";

// Replaces the default Next.js favicon with the brand mark — the app's
// green accent (WhatsApp-style default, `--primary` #21c063) as a round
// badge with the dark chat glyph used by the loading screen
// (`wa-loading-screen.tsx`, lucide MessagesSquare). Original artwork, no
// WhatsApp logo. Next.js renders this at build time and auto-injects
// <link rel="icon"> into <head>.
//
// This route takes precedence over src/app/favicon.ico, which is the
// Next.js default and can stay on disk harmlessly (or be removed).

export const runtime = "edge";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#21c063", // default accent (whatsapp green)
          borderRadius: 16,
        }}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#0a0a0a"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {/* lucide MessagesSquare */}
          <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" />
          <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
