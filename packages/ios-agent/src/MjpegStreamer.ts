import type { SimctlWrapper } from './SimctlWrapper.js'
import type { StreamFrame } from './ScreenCaptureStreamer.js'

type Screenshottable = Pick<SimctlWrapper, 'screenshot'>

export class MjpegStreamer {
  constructor(
    private readonly simctl: Screenshottable,
    private readonly udid: string,
    private readonly intervalMs: number = 100,
  ) {}

  start(): ReadableStream<StreamFrame> {
    let timer: ReturnType<typeof setInterval> | null = null
    let capturing = false

    return new ReadableStream<StreamFrame>({
      start: (controller) => {
        const capture = async () => {
          if (capturing) return
          capturing = true
          try {
            // `'jpeg'` explicitly. The default is PNG, so this streamer produced PNG bytes while
            // `IOSAgent` stamped CODEC_JPEG on every frame of it — the same lie #508 fixed on the
            // screenshot path, in the one place that names its codec in the class name.
            //
            // No in-repo entrypoint reaches this: `intervalMs` selects it and nothing but tests passes
            // one. It is not *unreachable*, though — `IOSAgent`, `IOSAgentOptions` and this class are
            // all public exports of a published package, so a consumer setting `intervalMs` was
            // receiving the mislabelled frames and now receives JPEG.
            const frame = await this.simctl.screenshot(this.udid, 'jpeg')
            controller.enqueue({ payload: frame, keyframe: false })
          } catch (err) {
            controller.error(err)
          } finally {
            capturing = false
          }
        }

        void capture()
        timer = setInterval(capture, this.intervalMs)
      },
      cancel: () => {
        if (timer !== null) {
          clearInterval(timer)
          timer = null
        }
      },
    })
  }
}
