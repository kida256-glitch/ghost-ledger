"use client";
// The feature-phone simulator (D12). Calls the real POST /api/ussd. Keeps the
// session in memory only; nothing is stored (D12.4).
import { useEffect, useRef, useState } from "react";
import { SERVICE_CODE, isRateLimited, maskStep, newSessionId, parseReply, ussdForm } from "./sim";

export interface DemoMember {
  readonly name: string;
  readonly role: string;
  readonly phone: string;
  readonly pin: string | null;
}

type Line = { readonly who: "you" | "phone"; readonly text: string };

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

export function Phone({ members, rateLimitedScreens }: { members: readonly DemoMember[]; rateLimitedScreens: readonly string[] }) {
  const [phone, setPhone] = useState(members[0]?.phone ?? "");
  const [session, setSession] = useState<{ id: string; steps: string[] } | null>(null);
  const [screen, setScreen] = useState<string>(`Dial ${SERVICE_CODE} to start.`);
  const [ended, setEnded] = useState(true);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<"rate" | "network" | null>(null);
  const [log, setLog] = useState<Line[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!ended) inputRef.current?.focus();
  }, [ended, screen]);

  async function send(id: string, steps: string[], typed: string | null) {
    setBusy(true);
    setNotice(null);
    if (typed !== null) setLog((l) => [...l, { who: "you", text: maskStep(typed, screen) }]);
    try {
      const r = await fetch("/api/ussd", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: ussdForm(id, phone, steps),
        cache: "no-store",
      });
      const raw = await r.text();
      const reply = parseReply(raw);
      if (isRateLimited(raw, rateLimitedScreens)) setNotice("rate");
      setScreen(reply.body);
      setLog((l) => [...l, { who: "phone", text: reply.body }]);
      setEnded(reply.kind === "END");
      setSession(reply.kind === "END" ? null : { id, steps });
    } catch {
      setNotice("network");
      setScreen("Network error. Dial again.");
      setEnded(true);
      setSession(null);
    } finally {
      setBusy(false);
      setInput("");
    }
  }

  function dial() {
    setLog([{ who: "you", text: `Dial ${SERVICE_CODE} from ${phone}` }]);
    void send(newSessionId(), [], null);
  }

  function submit() {
    if (busy) return;
    if (ended || !session) return dial();
    const step = input.trim();
    void send(session.id, [...session.steps, step], step);
  }

  function hangUp() {
    setSession(null);
    setEnded(true);
    setScreen("Call ended.");
    setLog((l) => [...l, { who: "you", text: "Hang up" }]);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_1fr]">
      {/* The handset */}
      <div className="mx-auto w-full max-w-[22rem] rounded-[2.5rem] border border-line bg-gradient-to-b from-surface-2 to-surface p-5 shadow-2xl">
        <div className="mx-auto mb-3 h-1.5 w-16 rounded-full bg-line" aria-hidden="true" />
        <div
          className="min-h-56 whitespace-pre-wrap rounded-xl border border-ecto-dim/40 bg-[#0f1a16] p-3 font-mono text-[15px] leading-snug text-[#b8f5dc] shadow-inner"
          aria-live="polite"
          aria-label="Phone screen"
          data-testid="phone-screen"
        >
          {busy ? "..." : screen}
        </div>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={ended || busy}
            inputMode="numeric"
            autoComplete="off"
            aria-label="Your reply"
            placeholder={ended ? "" : "Type a reply"}
            className="min-h-11 min-w-0 flex-1 rounded-xl border border-line bg-bg px-3 font-mono text-base text-text disabled:opacity-40"
          />
          <button type="submit" disabled={busy || phone === ""} className="min-h-11 rounded-xl bg-ecto px-4 text-sm font-semibold text-bg disabled:opacity-50">
            {ended ? "Dial" : "Send"}
          </button>
        </form>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {KEYS.map((k) => (
            <button
              key={k}
              type="button"
              disabled={ended || busy}
              onClick={() => setInput((v) => v + k)}
              className="min-h-11 rounded-xl border border-line bg-surface-2 font-mono text-lg text-text hover:border-ecto-dim disabled:opacity-40"
            >
              {k}
            </button>
          ))}
          <button type="button" onClick={() => setInput((v) => v.slice(0, -1))} disabled={ended || busy} className="min-h-11 rounded-xl border border-line text-sm text-muted disabled:opacity-40">
            Clear
          </button>
          <button type="button" onClick={hangUp} disabled={ended || busy} className="col-span-2 min-h-11 rounded-xl border border-danger/50 text-sm font-semibold text-danger disabled:opacity-40">
            End call
          </button>
        </div>
        {notice === "rate" ? (
          <p role="status" className="mt-3 rounded-xl border border-warning/50 bg-warning/10 p-3 text-sm text-warning">
            This demo phone has made too many requests in the last few minutes, probably because other judges are using it too. Wait a few minutes, or pick another demo member.
          </p>
        ) : null}
        {notice === "network" ? (
          <p role="status" className="mt-3 rounded-xl border border-danger/50 bg-danger/10 p-3 text-sm text-danger">
            Couldn&apos;t reach the USSD service. Check your connection and dial again.
          </p>
        ) : null}
      </div>

      {/* Demo members and the session log */}
      <div className="space-y-4">
        <section className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
          <h2 className="font-semibold">Demo members</h2>
          <p className="mt-1 text-sm text-muted">
            Fictional group &ldquo;Tubeera Together&rdquo;. Tap a member to dial as them. <strong className="text-text">Waiswa Henry has no PIN yet</strong>, so his
            first dial shows PIN setup.
          </p>
          <ul className="mt-3 divide-y divide-line">
            {members.map((m) => (
              <li key={m.phone}>
                <button
                  type="button"
                  onClick={() => {
                    setPhone(m.phone);
                    hangUp();
                    setScreen(`Dial ${SERVICE_CODE} to start.`);
                    setLog([]);
                  }}
                  aria-pressed={phone === m.phone}
                  className={`flex min-h-11 w-full items-center justify-between gap-3 px-2 py-2 text-left text-sm ${phone === m.phone ? "rounded-lg bg-ecto/10 text-ecto" : ""}`}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{m.name}</span>
                    <span className="block text-xs text-muted">{m.role}</span>
                  </span>
                  <span className="text-right font-mono text-xs">
                    <span className="block">{m.phone}</span>
                    <span className="block text-muted">{m.pin ? `PIN ${m.pin}` : "no PIN: first dial"}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
          <h2 className="font-semibold">This session</h2>
          {log.length === 0 ? (
            <p className="mt-2 text-sm text-muted">Nothing yet. Press Dial.</p>
          ) : (
            <ol className="mt-2 space-y-1 font-mono text-xs">
              {log.map((l, i) => (
                <li key={i} className={l.who === "you" ? "text-info" : "whitespace-pre-wrap text-muted"}>
                  {l.who === "you" ? `> ${l.text}` : l.text}
                </li>
              ))}
            </ol>
          )}
          <p className="mt-3 text-xs text-muted">PINs are masked here and nothing is saved in your browser.</p>
        </section>
      </div>
    </div>
  );
}
