import { useCallback, useEffect, useRef, useState } from 'react'

type RecordState = 'idle' | 'recording' | 'uploading' | 'done'

interface UseClientRecordingOptions {
  sessionId: string
  buildId?: number
  onRecordingUploaded?: () => void
}

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
]

/**
 * **This hook does not compile under the React Compiler, and that is recorded rather than fixed.**
 *
 * Measured with `babel-plugin-react-compiler@1.0.0`, both bails predating the viewers' rotation
 * work and neither a Rules of React violation:
 *
 * - `[InferMutationAliasingEffects] Expected value kind to be initialized` on `rafLoop` — an
 *   internal invariant, tripped by the hoisted named function expression. Declaring the same
 *   recursion inside `startClientRecording` compiles, and was tried and reverted: it buys nothing
 *   while the second bail stands, and it costs the comment below, which describes a real hazard.
 * - `Support value blocks … within a try/catch statement` on the upload — the `res.ok && json.url`
 *   test and the `onUploadedRef.current?.()` call sit inside the `try`. Hoisting them out changes
 *   what happens when the download trigger throws, and that path has no tests.
 *
 * What it costs is the auto-memoization, and every callback here is already wrapped by hand, so
 * nothing downstream reaches it. Revisit when the compiler lifts the try/catch limitation.
 */
export function useClientRecording({ sessionId, buildId, onRecordingUploaded }: UseClientRecordingOptions) {
  const [recordState, setRecordState] = useState<RecordState>('idle')
  const recordCanvasRef = useRef<HTMLCanvasElement>(null)

  // Stable ref so identity changes in the prop never trigger re-subscriptions (#58 regression)
  const onUploadedRef = useRef(onRecordingUploaded)
  useEffect(() => { onUploadedRef.current = onRecordingUploaded }, [onRecordingUploaded])

  const recordingRef = useRef(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordChunksRef = useRef<Blob[]>([])
  const recordMimeRef = useRef('')
  const rafIdRef = useRef(0)
  // Stable ref wrapper so RAF always calls the latest composeFrame without recreating the loop
  const composeFrameRef = useRef<(() => void) | null>(null)

  // Named function expression so the recursive schedule refers to itself, not to the `rafLoop`
  // binding that is still uninitialised while useCallback runs.
  const rafLoop = useCallback(function loop() {
    if (!recordingRef.current) return
    composeFrameRef.current?.()
    rafIdRef.current = requestAnimationFrame(loop)
  }, [])

  // Caller must set recordCanvasRef.current.width/height before calling this.
  // (iOS uses container px, Android multiplies by devicePixelRatio — kept as caller responsibility.)
  /**
   * Tell the recorder which function draws a frame. The newest one wins, and the frame loop reads
   * it afresh every tick.
   *
   * **A setter rather than an argument to `startClientRecording`.** Taken at start, the recorder
   * held whichever closure existed then, so a rotation mid-recording never reached the frames —
   * and `AndroidViewer`, whose composer is rebuilt on every turn, worked around that by mirroring
   * the turn into refs it wrote *after* handing the closure to this hook. That is a Rules of React
   * violation the React Compiler will not compile past. It is not an option on this hook either:
   * `composeFrame` needs `recordCanvasRef`, which this hook returns, so the viewer cannot have
   * built it yet when it calls us. (`IOSViewer`'s composer reads what it needs from refs on every
   * draw, so it registers once and never mirrored a turn.)
   *
   * **The obligation this moved out of the type system.** A caller that starts recording without
   * ever calling this gets a black video — no error, no warning, a green typecheck, where the old
   * required argument made it impossible. A guard here would silently refuse to start, which is
   * not better, so what holds it is a test per viewer that the composer is registered:
   * `AndroidViewer.composeFrame.test.tsx` and `IOSViewer.rotateAndCompose.test.tsx`.
   */
  const setComposeFrame = useCallback((compose: () => void) => { composeFrameRef.current = compose }, [])

  const startClientRecording = useCallback(() => {
    const rc = recordCanvasRef.current
    if (!rc) return
    const ctx0 = rc.getContext('2d')
    if (ctx0) { ctx0.fillStyle = '#000'; ctx0.fillRect(0, 0, rc.width, rc.height) }

    const mime = MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
    if (!mime) return

    recordMimeRef.current = mime
    recordChunksRef.current = []

    const mr = new MediaRecorder(rc.captureStream(30), { mimeType: mime })
    mr.ondataavailable = (e) => { if (e.data.size > 0) recordChunksRef.current.push(e.data) }
    mediaRecorderRef.current = mr
    mr.start(1000)

    recordingRef.current = true
    rafIdRef.current = requestAnimationFrame(rafLoop)
    setRecordState('recording')
  }, [rafLoop])

  const stopClientRecording = useCallback(async () => {
    setRecordState('uploading')
    recordingRef.current = false
    cancelAnimationFrame(rafIdRef.current)

    const mr = mediaRecorderRef.current
    if (!mr) { setRecordState('idle'); return }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 5000)
      mr.onstop = () => { clearTimeout(timeout); resolve() }
      try { mr.stop() } catch { clearTimeout(timeout); resolve() }
    })
    mediaRecorderRef.current = null

    const mime = recordMimeRef.current
    const ext = mime.includes('mp4') ? '.mp4' : '.webm'
    const blob = new Blob(recordChunksRef.current, { type: mime })
    recordChunksRef.current = []

    const formData = new FormData()
    formData.append('file', blob, `tapflow-${Date.now()}${ext}`)
    try {
      const params = new URLSearchParams({ sessionId })
      if (buildId) params.set('buildId', String(buildId))
      const res = await fetch(`/api/v1/recordings/upload?${params}`, { method: 'POST', credentials: 'include', body: formData })
      const json = await res.json() as { url?: string }
      if (res.ok && json.url) {
        const a = document.createElement('a'); a.href = json.url; a.download = ''; a.click()
        onUploadedRef.current?.()
        setRecordState('done')
        setTimeout(() => setRecordState('idle'), 2000)
      } else {
        setRecordState('idle')
      }
    } catch {
      setRecordState('idle')
    }
  }, [sessionId, buildId])

  // Auto-stop on tab hide + cleanup on unmount
  useEffect(() => {
    if (recordState !== 'recording') return
    const onVisibility = () => { if (document.visibilityState === 'hidden') stopClientRecording() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      if (recordingRef.current) {
        recordingRef.current = false
        cancelAnimationFrame(rafIdRef.current)
        mediaRecorderRef.current?.stop()
        mediaRecorderRef.current = null
      }
    }
  }, [recordState, stopClientRecording])

  return { recordState, recordCanvasRef, setComposeFrame, startClientRecording, stopClientRecording }
}
