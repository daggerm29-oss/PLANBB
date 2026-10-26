/**
 * Voice I/O:
 *  - Input: Browser Web Speech API with automatic fallback to MediaRecorder + server Gemini STT
 *    (so voice input works even in browsers/iframes where webkitSpeechRecognition is blocked).
 *  - Output: Browser speechSynthesis.
 */

interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionCtor = new () => Recognition;

function ctor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const speechInputSupported = () =>
  typeof window !== "undefined" && (!!ctor() || !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));

export const speechOutputSupported = () => typeof window !== "undefined" && "speechSynthesis" in window;

export interface ListenHandle {
  stop(): void;
}

/** Fallback recorder using getUserMedia + MediaRecorder + /api/ai/stt with automatic silence detection. */
function listenWithMediaRecorder(
  handlers: {
    onInterim?: (t: string) => void;
    onFinal: (t: string) => void;
    onError?: (e: string) => void;
    onEnd?: () => void;
  },
  base = ""
): ListenHandle {
  let stopped = false;
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let silenceTimer: number | undefined;
  let maxTimer: number | undefined;

  const cleanup = () => {
    window.clearInterval(silenceTimer);
    window.clearTimeout(maxTimer);
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }
  };

  void (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (stopped) {
        cleanup();
        handlers.onEnd?.();
        return;
      }
      handlers.onInterim?.("Listening… speak now");

      const mime =
        typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "";

      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = async () => {
        cleanup();
        if (!chunks.length) {
          handlers.onEnd?.();
          return;
        }
        try {
          handlers.onInterim?.("Transcribing voice command…");
          const blob = new Blob(chunks, { type: recorder?.mimeType || "audio/webm" });
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result));
            fr.onerror = () => reject(fr.error);
            fr.readAsDataURL(blob);
          });
          const r = await fetch(`${base}/api/ai/stt`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ audio: dataUrl }),
          });
          const j = (await r.json()) as { text?: string; error?: string };
          handlers.onInterim?.("");
          if (r.ok && j.text?.trim()) {
            handlers.onFinal(j.text.trim());
          } else if (!r.ok && j.error) {
            handlers.onError?.(j.error);
          }
        } catch (err) {
          handlers.onError?.((err as Error).message || "Voice transcription failed");
        } finally {
          handlers.onEnd?.();
        }
      };

      recorder.start();

      // Voice activity / silence auto-stop (stops 1.4s after user finishes speaking, or after 9s max)
      try {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (Ctx) {
          audioCtx = new Ctx();
          const src = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 256;
          src.connect(analyser);
          const buf = new Float32Array(analyser.fftSize);
          let heardSpeech = false;
          let lastVoiceAt = Date.now();
          const startedAt = Date.now();

          silenceTimer = window.setInterval(() => {
            analyser.getFloatTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
            const rms = Math.sqrt(sum / buf.length);
            if (rms > 0.018) {
              heardSpeech = true;
              lastVoiceAt = Date.now();
              handlers.onInterim?.("Hearing voice…");
            } else if (heardSpeech && Date.now() - lastVoiceAt > 1400) {
              if (recorder && recorder.state === "recording") recorder.stop();
            } else if (!heardSpeech && Date.now() - startedAt > 6000) {
              if (recorder && recorder.state === "recording") recorder.stop();
            }
          }, 100);
        }
      } catch {
        /* fallback to maxTimer */
      }

      maxTimer = window.setTimeout(() => {
        if (recorder && recorder.state === "recording") recorder.stop();
      }, 9000);
    } catch (e) {
      cleanup();
      const errName = (e as DOMException)?.name || "";
      if (errName === "NotAllowedError" || errName === "PermissionDeniedError" || errName === "SecurityError") {
        handlers.onError?.(
          "Microphone permission blocked. Click the lock/tune icon in your browser address bar to Allow Microphone and reload the page."
        );
      } else if (errName === "NotFoundError") {
        handlers.onError?.("No microphone detected on this device.");
      } else {
        handlers.onError?.((e as Error)?.message || "Microphone unavailable");
      }
      handlers.onEnd?.();
    }
  })();

  return {
    stop: () => {
      stopped = true;
      if (recorder && recorder.state === "recording") {
        recorder.stop();
      } else {
        cleanup();
        handlers.onEnd?.();
      }
    },
  };
}

/** One utterance: resolves interim text via onInterim, final text via onFinal. */
export function listenOnce(
  handlers: {
    onInterim?: (t: string) => void;
    onFinal: (t: string) => void;
    onError?: (e: string) => void;
    onEnd?: () => void;
  },
  base = ""
): ListenHandle | null {
  const C = ctor();
  if (!C) {
    return listenWithMediaRecorder(handlers, base);
  }

  let fallbackHandle: ListenHandle | null = null;
  let switchedToFallback = false;

  const rec = new C();
  rec.lang = navigator.language || "en-US";
  rec.continuous = false;
  rec.interimResults = true;
  let finalText = "";

  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    handlers.onInterim?.((finalText + interim).trim());
  };

  rec.onerror = (e) => {
    // If Web Speech API is blocked by iframe policy or browser service, fall back to MediaRecorder + /api/ai/stt
    if (
      (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "network") &&
      navigator.mediaDevices?.getUserMedia &&
      !switchedToFallback
    ) {
      switchedToFallback = true;
      fallbackHandle = listenWithMediaRecorder(handlers, base);
      return;
    }
    handlers.onError?.(e.error);
  };

  rec.onend = () => {
    if (switchedToFallback) return;
    if (finalText.trim()) handlers.onFinal(finalText.trim());
    handlers.onEnd?.();
  };

  try {
    rec.start();
  } catch {
    if (navigator.mediaDevices?.getUserMedia) {
      return listenWithMediaRecorder(handlers, base);
    }
    handlers.onError?.("Microphone unavailable");
    return null;
  }

  return {
    stop: () => {
      if (fallbackHandle) {
        fallbackHandle.stop();
      } else {
        try {
          rec.stop();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

let cachedVoice: SpeechSynthesisVoice | null = null;

function pickVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice) return cachedVoice;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  const lang = (navigator.language || "en-US").slice(0, 2);
  const pref = [/Google UK English Female/i, /Microsoft (Aria|Jenny|Sonia|Libby).*Online/i, /Samantha/i, /Google US English/i, /Natural/i];
  for (const re of pref) {
    const v = voices.find((x) => re.test(x.name) && x.lang.startsWith(lang));
    if (v) return (cachedVoice = v);
  }
  return (cachedVoice = voices.find((x) => x.lang.startsWith(lang)) ?? voices[0]);
}

if (typeof window !== "undefined" && "speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = () => {
    cachedVoice = null;
  };
}

/** Strip markdown / ids so the speech sounds natural. Returns a promise resolved when speaking ends. */
export function speak(text: string): Promise<void> {
  if (!speechOutputSupported() || !text.trim()) return Promise.resolve();
  const clean = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[*_`#>]/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
  window.speechSynthesis.cancel();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(clean);
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = 1.04;
    u.pitch = 1;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
  });
}

export function stopSpeaking() {
  if (speechOutputSupported()) window.speechSynthesis.cancel();
}

