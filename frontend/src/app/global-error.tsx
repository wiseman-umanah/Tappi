"use client";

// Last-resort page when the root layout itself fails, so it carries its own document and styles.
export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          background: "linear-gradient(180deg,#1a1a1b 0%,#1a3462 60%,#0c57ec 100%)",
          color: "#fff",
          fontFamily: "system-ui, sans-serif",
          textAlign: "center",
          padding: "24px",
        }}
      >
        <title>Something went wrong | Tappi</title>
        <div>
          <p style={{ fontSize: 56, fontWeight: 800, margin: 0 }}>Tappi</p>
          <h1 style={{ fontSize: 28, margin: "16px 0 8px" }}>Something went wrong.</h1>
          <p style={{ opacity: 0.75, margin: "0 0 24px" }}>Please try again in a moment.</p>
          <button
            type="button"
            onClick={() => retry()}
            style={{
              height: 48,
              padding: "0 24px",
              borderRadius: 999,
              border: 0,
              background: "#3b82f6",
              color: "#fff",
              fontSize: 16,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
