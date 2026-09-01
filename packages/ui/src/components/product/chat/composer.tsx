import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, LoaderCircle, Mic, Paperclip, Square, X } from "lucide-react";
import { cn } from "../../../lib/utils";
import { useAnnounce } from "../../../lib/announce";
import { AutoTextarea, Button, Switch, Tooltip } from "../../ui";
import { t as translate } from "./localize";

export type DictationState = "idle" | "requesting" | "recording" | "processing" | "error";
export interface DictationAdapter {
  start: (handlers: {
    readonly onRequest?: () => void;
    readonly onStart?: () => void;
    readonly onResult: (text: string) => void;
    readonly onError: () => void;
    readonly onEnd: (text: string) => void;
    readonly locale: string;
  }) => void;
  stop: () => void;
  abort: () => void;
}
export interface ComposerProps {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  onSend: (text: string) => void | Promise<void>;
  onStop?: () => void | Promise<void>;
  onAttach?: (file: File) => void | Promise<void>;
  runActive?: boolean;
  disabled?: boolean;
  webSearchEnabled?: boolean;
  onWebSearchChange?: (enabled: boolean) => void;
  webSearchAllowed?: boolean;
  webSearchDisabledReason?: string;
  placeholder?: string;
  sendLabel?: string;
  stopLabel?: string;
  webLabel?: string;
  dictationLabel?: string;
  className?: string;
  locale?: string;
  dictationAdapter?: DictationAdapter;
}

type DictationError = "permission" | "unsupported" | "noSpeech" | "generic";
type DictationStopReason = "cancel" | "confirm" | null;

interface DictationAlternativeLike {
  transcript: string;
}

interface DictationResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: DictationAlternativeLike;
}

interface DictationResultListLike {
  length: number;
  [index: number]: DictationResultLike;
}

interface DictationResultEventLike extends Event {
  resultIndex: number;
  results: DictationResultListLike;
}

interface DictationErrorEventLike extends Event {
  error?: string;
  message?: string;
}

interface DictationRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: ((event: Event) => void) | null;
  onresult: ((event: DictationResultEventLike) => void) | null;
  onerror: ((event: DictationErrorEventLike) => void) | null;
  onend: ((event: Event) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type DictationRecognitionConstructor = new () => DictationRecognitionLike;
type WindowWithSpeechApis = Window & {
  SpeechRecognition?: DictationRecognitionConstructor;
  webkitSpeechRecognition?: DictationRecognitionConstructor;
  webkitAudioContext?: typeof AudioContext;
};

const WAVEFORM_BAR_COUNT = 22;
const INITIAL_WAVEFORM = Array.from(
  { length: WAVEFORM_BAR_COUNT },
  (_, index) => 0.25 + ((index * 7) % 5) * 0.04,
);

function recognitionConstructor(): DictationRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const speechWindow = window as WindowWithSpeechApis;
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

function audioContextConstructor(): (new () => AudioContext) | null {
  if (typeof window === "undefined") return null;
  const audioWindow = window as WindowWithSpeechApis;
  return window.AudioContext ?? audioWindow.webkitAudioContext ?? null;
}

function appendTranscript(existing: string, transcript: string): string {
  const cleanTranscript = transcript.replace(/\s+/g, " ").trim();
  if (!cleanTranscript) return existing;
  const existingEnd = existing.trimEnd();
  return existingEnd ? `${existingEnd} ${cleanTranscript}` : cleanTranscript;
}

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = Math.max(0, totalSeconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function errorForRecognition(error: string | undefined): DictationError {
  if (error === "not-allowed" || error === "service-not-allowed" || error === "permission-denied")
    return "permission";
  if (error === "no-speech") return "noSpeech";
  return "generic";
}

/**
 * Composer: auto-growing textarea, Enter sends / Shift+Enter newline, and
 * send morphs to Stop while streaming. Dictation uses native browser speech
 * recognition and a local analyser only while the microphone is active.
 */
export function Composer({
  value: controlled,
  defaultValue = "",
  onChange,
  onSend,
  onStop,
  onAttach,
  runActive = false,
  disabled = false,
  webSearchEnabled = false,
  onWebSearchChange,
  webSearchAllowed = true,
  webSearchDisabledReason,
  placeholder,
  sendLabel,
  stopLabel,
  webLabel,
  dictationLabel,
  className,
  locale = "en-US",
  dictationAdapter: _dictationAdapter,
}: ComposerProps) {
  const t = (key: string, params?: Record<string, string | number>) => {
    if (key === "composer.placeholder" && placeholder) return placeholder;
    if (key === "composer.send" && sendLabel) return sendLabel;
    if (key === "composer.stop" && stopLabel) return stopLabel;
    if (key === "composer.webSearch" && webLabel) return webLabel;
    if (key === "composer.dictation.start" && dictationLabel) return dictationLabel;
    return translate(locale, key, params);
  };
  const announce = useAnnounce();
  const [text, setText] = useState(controlled ?? defaultValue);
  const [attachment, setAttachment] = useState<{ name: string } | null>(null);
  const [dictation, setDictation] = useState<DictationState>("idle");
  const [dictationError, setDictationError] = useState<DictationError | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [waveform, setWaveform] = useState(INITIAL_WAVEFORM);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef(controlled ?? defaultValue);
  const mountedRef = useRef(true);
  const sessionRef = useRef(0);
  const dictationStateRef = useRef<DictationState>("idle");
  const stopReasonRef = useRef<DictationStopReason>(null);
  const finalTranscriptRef = useRef("");
  const interimTranscriptRef = useRef("");
  const recognitionRef = useRef<DictationRecognitionLike | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const recordingStartedAtRef = useRef<number | null>(null);
  const lastWaveformUpdateRef = useRef(0);

  const streaming = runActive;
  useEffect(() => {
    if (controlled !== undefined && controlled !== text) {
      textRef.current = controlled;
      setText(controlled);
    }
  }, [controlled, text]);

  const updateText = (next: string) => {
    textRef.current = next;
    setText(next);
    onChange?.(next);
  };

  const setDictationState = (next: DictationState) => {
    dictationStateRef.current = next;
    setDictation(next);
  };

  const stopTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    recordingStartedAtRef.current = null;
  };

  const stopWaveform = (reset = true) => {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    lastWaveformUpdateRef.current = 0;
    if (reset) setWaveform(INITIAL_WAVEFORM);
  };

  const stopAudio = (resetWaveform = true) => {
    stopTimer();
    stopWaveform(resetWaveform);
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    analyserRef.current?.disconnect();
    analyserRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context) {
      try {
        void context.close().catch(() => undefined);
      } catch {
        // A mocked or already-closed context may throw while closing.
      }
    }
    const stream = streamRef.current;
    streamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
  };

  const detachRecognition = (abort: boolean) => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (!recognition) return;
    recognition.onstart = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    if (abort) {
      try {
        recognition.abort();
      } catch {
        // The browser may already have ended recognition.
      }
    }
  };

  const resetToIdle = (focus = false) => {
    stopAudio();
    detachRecognition(true);
    stopReasonRef.current = null;
    finalTranscriptRef.current = "";
    interimTranscriptRef.current = "";
    setDictationError(null);
    setDictationState("idle");
    if (focus) window.requestAnimationFrame(() => taRef.current?.focus());
  };

  const failDictation = (session: number, error: DictationError) => {
    if (!mountedRef.current || sessionRef.current !== session) return;
    sessionRef.current += 1;
    stopReasonRef.current = null;
    stopAudio();
    detachRecognition(true);
    finalTranscriptRef.current = "";
    interimTranscriptRef.current = "";
    setDictationError(error);
    setDictationState("error");
    announce.alert(t(`composer.dictation.${error}`));
  };

  const finishTranscript = (session: number) => {
    if (!mountedRef.current || sessionRef.current !== session) return;
    stopAudio();
    detachRecognition(false);
    const transcript = `${finalTranscriptRef.current} ${interimTranscriptRef.current}`.trim();
    if (!transcript.replace(/\s+/g, "").length) {
      failDictation(session, "noSpeech");
      return;
    }
    const nextText = appendTranscript(textRef.current, transcript);
    updateText(nextText);
    finalTranscriptRef.current = "";
    interimTranscriptRef.current = "";
    stopReasonRef.current = null;
    setDictationError(null);
    setDictationState("idle");
    announce.status(t("composer.dictation.finish"));
    window.requestAnimationFrame(() => taRef.current?.focus());
  };

  const handleRecognitionEnd = (session: number) => {
    if (!mountedRef.current || sessionRef.current !== session) return;
    if (stopReasonRef.current === "cancel") {
      sessionRef.current += 1;
      resetToIdle(true);
      return;
    }
    setDictationState("processing");
    announce.status(t("composer.dictation.transcribing"));
    finishTranscript(session);
  };

  const startWaveform = (session: number, analyser: AnalyserNode) => {
    const data = new Uint8Array(analyser.fftSize);
    const update = (timestamp: number) => {
      if (!mountedRef.current || sessionRef.current !== session || analyserRef.current !== analyser)
        return;
      if (timestamp - lastWaveformUpdateRef.current >= 80) {
        analyser.getByteTimeDomainData(data);
        const next = Array.from({ length: WAVEFORM_BAR_COUNT }, (_, index) => {
          const from = Math.floor((index * data.length) / WAVEFORM_BAR_COUNT);
          const to = Math.max(
            from + 1,
            Math.floor(((index + 1) * data.length) / WAVEFORM_BAR_COUNT),
          );
          let energy = 0;
          for (let cursor = from; cursor < to; cursor += 1)
            energy += Math.abs(data[cursor]! - 128) / 128;
          const average = energy / (to - from);
          return Math.min(1, Math.max(0.16, 0.16 + average * 1.7));
        });
        lastWaveformUpdateRef.current = timestamp;
        setWaveform(next);
      }
      animationFrameRef.current = window.requestAnimationFrame(update);
    };
    animationFrameRef.current = window.requestAnimationFrame(update);
  };

  const startTimer = () => {
    stopTimer();
    const startedAt = Date.now();
    recordingStartedAtRef.current = startedAt;
    timerRef.current = window.setInterval(() => {
      if (recordingStartedAtRef.current === startedAt) {
        setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
      }
    }, 250);
  };

  const startDictation = async () => {
    if (
      streaming ||
      (dictationStateRef.current !== "idle" && dictationStateRef.current !== "error")
    )
      return;
    const Recognition = recognitionConstructor();
    const AudioContext = audioContextConstructor();
    if (
      !Recognition ||
      !AudioContext ||
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      sessionRef.current += 1;
      setDictationError("unsupported");
      setDictationState("error");
      announce.alert(t("composer.dictation.unsupported"));
      return;
    }

    sessionRef.current += 1;
    const session = sessionRef.current;
    stopAudio();
    detachRecognition(true);
    stopReasonRef.current = null;
    finalTranscriptRef.current = "";
    interimTranscriptRef.current = "";
    setElapsedSeconds(0);
    setDictationError(null);
    setDictationState("requesting");
    announce.status(t("composer.dictation.requesting"));

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current || sessionRef.current !== session) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const context = new AudioContext();
      audioContextRef.current = context;
      await context.resume();
      if (!mountedRef.current || sessionRef.current !== session) return;
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.78;
      source.connect(analyser);
      sourceRef.current = source;
      analyserRef.current = analyser;
      startWaveform(session, analyser);

      const recognition = new Recognition();
      recognition.lang = locale === "fr" ? "fr-FR" : "en-US";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onstart = () => {
        if (!mountedRef.current || sessionRef.current !== session) return;
        setDictationState("recording");
        startTimer();
        announce.status(t("composer.dictation.listening"));
      };
      recognition.onresult = (event) => {
        if (!mountedRef.current || sessionRef.current !== session) return;
        let finalText = "";
        let interimText = "";
        for (let index = 0; index < event.results.length; index += 1) {
          const result = event.results[index];
          if (!result) continue;
          const transcript = result[0]?.transcript ?? "";
          if (result.isFinal) finalText += transcript;
          else interimText += transcript;
        }
        finalTranscriptRef.current = finalText;
        interimTranscriptRef.current = interimText;
      };
      recognition.onerror = (event) => {
        failDictation(session, errorForRecognition(event.error));
      };
      recognition.onend = () => {
        handleRecognitionEnd(session);
      };
      recognitionRef.current = recognition;
      try {
        recognition.start();
      } catch {
        failDictation(session, "generic");
      }
    } catch (error) {
      const name =
        typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
      failDictation(
        session,
        name === "NotAllowedError" || name === "PermissionDeniedError" ? "permission" : "generic",
      );
    }
  };

  const cancelDictation = () => {
    if (dictationStateRef.current === "idle" || dictationStateRef.current === "error") return;
    stopReasonRef.current = "cancel";
    sessionRef.current += 1;
    resetToIdle(true);
    announce.status(t("composer.dictation.cancel"));
  };

  const confirmDictation = () => {
    if (dictationStateRef.current !== "recording") return;
    const session = sessionRef.current;
    stopReasonRef.current = "confirm";
    setDictationState("processing");
    announce.status(t("composer.dictation.transcribing"));
    stopAudio();
    const recognition = recognitionRef.current;
    if (!recognition) {
      finishTranscript(session);
      return;
    }
    try {
      recognition.stop();
    } catch {
      finishTranscript(session);
    }
  };

  const dismissDictationError = () => resetToIdle(true);

  const submit = () => {
    if (streaming || text.trim() === "") return;
    if (dictationStateRef.current !== "idle") cancelDictation();
    void onSend(text.trim());
    updateText("");
    taRef.current?.focus();
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sessionRef.current += 1;
      stopAudio(false);
      detachRecognition(true);
    };
  }, []);

  const errorText = dictationError ? t(`composer.dictation.${dictationError}`) : "";
  const actionDisabled = disabled || dictation !== "idle";

  return (
    <div className={cn("border-t border-line bg-paper px-4 py-3", className)}>
      <div className="mx-auto max-w-[52rem]">
        {/* Attachment chip */}
        {attachment && (
          <p className="animate-enter mb-1.5 inline-flex items-center gap-1.5 rounded-tiny border border-line-2 bg-paper-deep/60 px-2 py-1 font-mono text-[11px] text-ink">
            <Paperclip aria-hidden="true" className="size-3 text-ink-2" />
            {attachment.name}
            <button
              type="button"
              aria-label={t("composer.removeAttachment", { name: attachment.name })}
              onClick={() => setAttachment(null)}
              className="flex size-4 items-center justify-center rounded-tiny text-ink-2 transition-colors duration-100 hover:bg-paper-deep hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <X aria-hidden="true" className="size-2.5" />
            </button>
          </p>
        )}

        <div className="flex items-end gap-2">
          {dictation === "idle" ? (
            <AutoTextarea
              ref={taRef}
              value={text}
              maxRows={10}
              aria-label={t("composer.label")}
              placeholder={t("composer.placeholder")}
              disabled={disabled}
              onChange={(e) => updateText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              className="min-w-0 min-h-9 flex-1 overscroll-contain border-0 bg-transparent px-3 py-2 leading-5 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent"
            />
          ) : dictation === "error" ? (
            <div
              role="alert"
              className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-tiny border border-danger/60 bg-danger-soft/50 px-3 py-1.5 text-[12px] text-danger"
            >
              <span className="min-w-0 flex-1 truncate">{errorText}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0 text-danger"
                onClick={startDictation}
              >
                {t("common.retry")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="shrink-0"
                onClick={dismissDictationError}
              >
                {t("composer.dictation.dismiss")}
              </Button>
            </div>
          ) : (
            <div className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-tiny border border-line-2 bg-surface px-2.5">
              {dictation === "requesting" && (
                <>
                  <span className="sr-only" role="status" aria-live="polite">
                    {t("composer.dictation.requesting")}
                  </span>
                  <LoaderCircle
                    aria-hidden="true"
                    className="size-3.5 shrink-0 animate-spin-slow text-ink-2"
                  />
                  <span className="truncate text-[12px] text-ink-2">
                    {t("composer.dictation.requesting")}
                  </span>
                </>
              )}
              {dictation === "recording" && (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    title={t("composer.dictation.cancel")}
                    aria-label={t("composer.dictation.cancel")}
                    className="shrink-0 text-ink-2 hover:text-ink"
                    onClick={cancelDictation}
                  >
                    <X aria-hidden="true" />
                  </Button>
                  <span className="sr-only" role="status" aria-live="polite">
                    {t("composer.dictation.listening")}
                  </span>
                  <span
                    className="flex min-w-0 flex-1 items-center justify-center gap-[3px]"
                    aria-hidden="true"
                  >
                    {waveform.map((height, index) => (
                      <span
                        key={index}
                        className="w-px rounded-full bg-accent transition-[height] duration-100"
                        style={{ height: `${Math.round(7 + height * 15)}px` }}
                      />
                    ))}
                  </span>
                  <time
                    className="shrink-0 font-mono text-[11px] tabular-nums text-ink-2"
                    dateTime={`PT${elapsedSeconds}S`}
                  >
                    {formatElapsed(elapsedSeconds)}
                  </time>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    title={t("composer.dictation.finish")}
                    aria-label={t("composer.dictation.finish")}
                    className="shrink-0 text-accent hover:text-accent-deep"
                    onClick={confirmDictation}
                  >
                    <Check aria-hidden="true" />
                  </Button>
                </>
              )}
              {dictation === "processing" && (
                <>
                  <span className="sr-only" role="status" aria-live="polite">
                    {t("composer.dictation.transcribing")}
                  </span>
                  <LoaderCircle
                    aria-hidden="true"
                    className="size-3.5 shrink-0 animate-spin-slow text-ink-2"
                  />
                  <span className="truncate text-[12px] text-ink-2">
                    {t("composer.dictation.transcribing")}
                  </span>
                </>
              )}
            </div>
          )}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <div className="flex items-center gap-2">
            <Tooltip content={t("composer.attach")}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title={t("composer.attach")}
                aria-label={t("composer.attach")}
                className="text-ink-2"
                onClick={() => fileRef.current?.click()}
              >
                <Paperclip />
              </Button>
            </Tooltip>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,application/pdf,text/markdown,.md"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  setAttachment({ name: file.name });
                  void onAttach?.(file);
                  announce.status(t("composer.attached", { name: file.name }));
                }
                e.target.value = "";
              }}
            />
            <span className="flex items-center gap-2">
              <Switch
                id="web-search-toggle"
                checked={webSearchEnabled}
                disabled={!webSearchAllowed || disabled}
                onCheckedChange={(checked) => onWebSearchChange?.(checked)}
                aria-label={t("composer.webSearch")}
              />
              <label
                title={webSearchDisabledReason}
                htmlFor="web-search-toggle"
                className={cn("text-[12px]", webSearchEnabled ? "text-ink" : "text-ink-2")}
              >
                {t("composer.webSearch")}
              </label>
            </span>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title={t("composer.dictation.start")}
              aria-label={t("composer.dictation.start")}
              disabled={streaming || actionDisabled}
              className="text-ink-2"
              onClick={startDictation}
            >
              <Mic aria-hidden="true" />
            </Button>
            {streaming ? (
              <Button
                type="button"
                variant="secondary"
                size="icon"
                aria-label={t("composer.stop")}
                title={t("composer.stop")}
                onClick={() => void onStop?.()}
                className="border-ink"
              >
                <Square className="size-3 fill-current" />
              </Button>
            ) : (
              <Button
                type="button"
                variant="primary"
                size="icon"
                aria-label={t("composer.send")}
                title={t("composer.send")}
                disabled={text.trim() === ""}
                onClick={submit}
              >
                <ArrowUp />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
