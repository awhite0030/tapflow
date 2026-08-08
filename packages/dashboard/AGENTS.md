---
type: rules
topics: [dashboard, react, ui]
status: living
---

# dashboard — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## Design Reference

Before any design or frontend work, read **[DESIGN.md](./DESIGN.md)** and follow the color tokens, typography, and elevation rules defined there.

## WHAT

React SPA team dashboard: provides the simulator viewer, build comments, and team invite screens.
The audience is the whole team (PO, PM, designers, backend, QA) — not just QA. See root [AGENTS.md](../../AGENTS.md) for the two testing modes (manual vs. AI Agent via MCP).
**No standalone deployment** — bundled to `dist/` via `vite build`, then copied to the relay package's `public/` directory and served directly by the relay server.

### App Center Structure

`/app-center` route. Left app list sidebar + center Release Accordion + Build cards.

- **App sidebar**: `GET /api/v1/apps` → selecting an app manages state via `?appId=N` URL parameter.
- **Release Accordion**: `GET /api/v1/builds?app_id=N` → grouped by `version_name` (`groupByRelease()`). No dedicated `releases` table — UI grouping uses `version_name` metadata.
- **Build card**: shows `build_number`, `platform`, `status_label`, uploader, `uploaded_at`. Inline status dropdown. **"Start QA" CTA** → `/app-center/build?id={build_id}`.
- **Upload**: `UploadBuildDialog` — iOS `.app.zip` or `.tar.gz`/`.tgz` (EAS simulator build) / Android `.apk`. `version_name` / `build_number` are auto-extracted from plist, so no manual input fields.

## HOW

- **Stack**: Vite + React 19 + React Router v7 + Shadcn/Tailwind + next-themes
- **Structure**: `src/` — app entry, router, pages; `components/` — shared components; `hooks/` — custom hooks; `lib/` — utils, types, API client
- **Routing**: `BrowserRouter`-based. `/login` and `/invite` are public. Everything else is protected by `DashboardLayout` via `useAuth` (redirects to `/login`).
- **Auth**: Session confirmed via `GET /api/v1/auth/me`. HttpOnly cookie (not readable from JS).
- **Streaming**: set `binaryType = 'arraybuffer'` in `useRelay`, branch on `e.data instanceof ArrayBuffer` for binary frames.
- **Outbound message shapes live in [`@tapflowio/protocol`](../protocol/AGENTS.md)**, imported with `import type` so nothing lands in the bundle. `send()` takes `BrowserToRelay`, so a new message has to be added to that union first. `RelayMessage` in `lib/types.ts` is what the viewer *receives* — it deliberately no longer lists outbound messages, because that list drifted from the wire while nothing checked it.
- **Dev server proxy**: `vite.config.ts` proxies `/api` and `/uploads` → `http://localhost:4000`.
- **Build order**: dashboard first → relay second (`agent-core → dashboard → relay`).

## Testing

- `pnpm test` is always run foreground (terminal). **Never run vitest as a background process** — worker forks accumulate as zombies and exhaust CPU/RAM.
- If a test appears to hang, Ctrl+C immediately and diagnose. Do not re-run without fixing the root cause.
- Components that combine multiple `useEffect` + `react-hook-form` `Controller` + `useWatch` (e.g. `DefaultSettings`) can hang in jsdom under full render. `vitest.config.ts` has `testTimeout: 10000` as a safety net — a timeout failure means the test setup needs fixing, not more retries.
- When mocking `fetch` in a component that fires multiple concurrent `useEffect` fetches (e.g. `GET /api/v1/settings` + `GET /api/v1/apps`), use URL-based dispatch (`mockImplementation((url) => {...})`) instead of `mockResolvedValueOnce` chains — call order is non-deterministic.

### `input:error` is shown per input, and there is no session-level input state

A failed input surfaces as a toast keyed on the wire `reason` (`lib/inputErrorNotice.ts`), or is shown
nowhere for the two reasons that fix themselves. `input:done` is **not handled at all**.

A latched "input unavailable" line on the status card was designed and discarded, and it will look
like the obvious improvement to whoever reads this next. It cannot be made honest on the current
protocol, for three independent reasons:

- **Nothing announces recovery.** iOS replaces a dead helper eagerly and is injecting again ~200ms
  later, with no message to the browser. And `channel-unavailable`'s own advice is *do not blindly
  retry*, so the only edge that could clear a latch requires the tester to do what the UI just told
  them not to.
- **The acks are unordered.** `ackInput` awaits a `simctl` / `adb` child on the success path and sends
  refusals synchronously, so an earlier input's `input:done` can arrive after a later input's
  `input:error` and clear a latch that is still true.
- **An ack does not say which channel answered.** On Android a button always takes the adb path while
  touch takes the pointer channel, so pressing Home to check whether input works at all succeeds — and
  under the latch that success erased the warning about the dead touch channel.

Instead the toast's own lifetime carries the state: repeats reuse `id`, which sonner refreshes rather
than stacks, so it stays up while inputs keep failing and fades on its own when they stop. **Being
observed rather than stored is the point** — there is no clear edge to get wrong.

Copy lives here rather than in the agents because `message` on the wire is free prose each agent owns
and cannot be localised; `reason` is the contract. `message` rides along as the description, where its
diagnostic detail (`unknown key code: KeyFoo`) belongs. Absent or unrecognised reasons resolve to
`channel-unavailable` — absence means *unknown*, never *fine*.

A persistent indicator needs a protocol-level input-health signal, or acks that identify their channel
and arrive in order. Two tests guard the decision (`DeviceViewer.inputError.test.tsx`): `input:done`
must do nothing, and a success between two failures must change nothing.

## HOW NOT

- Do not reintroduce the `next` package.
- Do not call the Agent directly from the dashboard — always go through the relay.
- Do not put platform-specific conditionals (`if platform === 'ios'`) in UI components.
- Do not send session recording data to external storage.

---

## Compound

### WebSocket Binary Frame Reception

**When**: receiving and rendering binary stream frames

**How**: `useRelay` receives binary frames (set `socket.binaryType = 'arraybuffer'`, else `e.data` is a `Blob`); `IOSViewer` / `AndroidViewer` render via a decoder chosen by `pickDecoder` (`lib/decoders/`) — WebCodecs on secure contexts, WASM (tinyh264) on plain HTTP, `createImageBitmap` for the JPEG fallback.

**Why** (not obvious from the code):
- Both H.264 tiers paint **straight to a canvas with no `<video>` media element** — WebCodecs decodes to a `VideoFrame`, WASM (tinyh264) decodes to I420 rendered by `YUVWebGLRenderer` — so there is no media-element buffer adding latency. H.264 is hardware-decoded (WebCodecs) on secure contexts; only the JPEG fallback is CPU-decoded (`createImageBitmap`).
- Release the GPU texture/frame every frame (`bitmap.close()` / `VideoFrame.close()`) — otherwise GPU memory leaks per frame.

---

<!-- a11y-lens:begin -->
## Accessibility rules (a11y-lens)

This package is the only one with DOM/client code, so the a11y-lens rules apply here. Staged UI changes are checked at commit time by the root lefthook `a11y-lens` job; findings with `error` severity block the commit.

When writing or modifying UI code (JSX/TSX/HTML), apply the rule set in `node_modules/@a11y-lens/cli/skills/a11y-lens/references/` — read the relevant category before implementing:

- `01-landmarks-headings.md` — document outline, one h1, no level skips, labelled landmarks
- `02-images-alt.md` — alt text that describes function in context; icon-only controls need accessible names
- `03-forms-labels.md` — placeholder is not a label; errors tied via `aria-describedby`; name matches visible label
- `04-aria-widgets.md` — prefer native elements; custom widgets implement the complete WAI-ARIA APG pattern
- `05-keyboard-interaction.md` — full APG key sets, no hover-only affordances, no keyboard traps
- `06-focus-management.md` — overlays move and return focus; async results are announced via live regions

Tip: agents with skills support get richer guidance via `npx skills add jo-duchan/a11y-lens`.

Self-check against these categories before finishing any UI task — it is cheaper than failing the pre-commit gate.
<!-- a11y-lens:end -->
