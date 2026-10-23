export type RealtimeConnectionState =
  | "idle"
  | "requesting-microphone"
  | "connecting"
  | "connected"
  | "closed"
  | "error";

type RealtimeClientOptions = {
  onState?: (state: RealtimeConnectionState) => void;
  onTranscript?: (text: string, final: boolean, itemId: string, sequence: number) => void;
  onError?: (message: string) => void;
  context?: {
    role?: string;
    interviewType?: string;
    keywords?: string[];
    language?: string;
  };
};

type TranscriptItem = { text: string; final: boolean; sequence: number };

type RealtimeStudioApi = {
  requestConsent: (kind: "microphone") => Promise<{ token: string; expiresAt: number } | null>;
  releaseConsent: (token: string) => Promise<void>;
  createRealtimeToken: (request: NonNullable<RealtimeClientOptions["context"]> & { consentToken: string }) => Promise<StudioRealtimeToken>;
  exchangeRealtimeSdp: (request: { token: string; sdp: string }) => Promise<{ sdp: string }>;
};

function realtimeStudio(): RealtimeStudioApi | undefined {
  return window.studio as unknown as RealtimeStudioApi | undefined;
}

function tokenValue(token: StudioRealtimeToken): string {
  return token.value;
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

/** Renderer-only WebRTC transcription client using a main-process consent grant. */
export class RealtimeInterviewClient {
  private pc?: RTCPeerConnection;
  private stream?: MediaStream;
  private channel?: RTCDataChannel;
  private audioContext?: AudioContext;
  private analyser?: AnalyserNode;
  private silenceFrame?: number;
  private speechStartedAt = 0;
  private lastSpeechAt = 0;
  private hasSpeech = false;
  private options: RealtimeClientOptions;
  private state: RealtimeConnectionState = "idle";
  private generation = 0;
  private connectController?: AbortController;
  private consentToken?: string;
  private connectionDeadline?: number;
  private disconnectedDeadline?: number;
  private transcriptItems = new Map<string, TranscriptItem>();
  private transcriptSequence = 0;

  constructor(options: RealtimeClientOptions = {}) {
    this.options = options;
  }

  async connect(): Promise<void> {
    const studio = realtimeStudio();
    if (!studio?.createRealtimeToken || !studio.exchangeRealtimeSdp || !studio.requestConsent) {
      throw new Error("Realtime voice is unavailable in this build.");
    }

    this.disconnect(false);
    const generation = ++this.generation;
    const controller = new AbortController();
    this.connectController = controller;

    try {
      const audioContext = new AudioContext();
      this.audioContext = audioContext;
      if (audioContext.state === "suspended") {
        await audioContext.resume().catch(() => undefined);
        this.assertCurrent(generation);
      }

      this.setState("requesting-microphone");
      const grant = await studio.requestConsent("microphone");
      if (generation !== this.generation || controller.signal.aborted) {
        if (grant) await studio.releaseConsent(grant.token).catch(() => undefined);
        throw abortError("Realtime connection was cancelled.");
      }
      if (!grant) throw abortError("Microphone consent was cancelled.");
      this.consentToken = grant.token;

      this.setState("connecting");
      const ephemeral = tokenValue(await studio.createRealtimeToken({
        ...this.options.context,
        consentToken: grant.token,
      }));
      this.assertCurrent(generation);
      if (!ephemeral) throw new Error("The realtime session token was empty.");

      this.setState("requesting-microphone");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (generation !== this.generation || controller.signal.aborted) {
        stream.getTracks().forEach((track) => track.stop());
        throw abortError("Realtime connection was cancelled.");
      }
      this.stream = stream;
      await studio.releaseConsent(grant.token).catch(() => undefined);
      if (this.consentToken === grant.token) this.consentToken = undefined;
      this.assertCurrent(generation);
      stream.getTracks().forEach((track) => {
        track.addEventListener("ended", () => {
          if (generation === this.generation) this.finish("closed", generation);
        }, { once: true });
      });

      this.setState("connecting");
      const pc = new RTCPeerConnection();
      this.pc = pc;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      pc.onconnectionstatechange = () => {
        if (generation !== this.generation) return;
        if (pc.connectionState === "failed") {
          this.fail("Realtime connection failed.", generation);
        } else if (pc.connectionState === "closed") {
          this.finish("closed", generation);
        } else if (pc.connectionState === "disconnected") {
          if (this.disconnectedDeadline === undefined) {
            this.disconnectedDeadline = window.setTimeout(() => {
              if (generation === this.generation && pc.connectionState === "disconnected") {
                this.fail("Realtime connection was lost.", generation);
              }
            }, 8_000);
          }
        } else if (pc.connectionState === "connected" && this.disconnectedDeadline !== undefined) {
          window.clearTimeout(this.disconnectedDeadline);
          this.disconnectedDeadline = undefined;
        }
      };

      const channel = pc.createDataChannel("oai-events");
      this.channel = channel;
      this.connectionDeadline = window.setTimeout(() => {
        this.fail("Realtime connection timed out.", generation);
      }, 25_000);
      channel.onopen = () => {
        if (generation !== this.generation) return;
        if (this.connectionDeadline !== undefined) {
          window.clearTimeout(this.connectionDeadline);
          this.connectionDeadline = undefined;
        }
        this.setState("connected");
        try {
          this.beginSilenceDetection(stream, generation);
        } catch {
          this.fail("Could not start speech detection.", generation);
        }
      };
      channel.onmessage = (event) => {
        if (generation === this.generation) this.handleEvent(String(event.data));
      };
      channel.onerror = () => this.fail("Realtime data channel failed.", generation);
      channel.onclose = () => {
        if (generation === this.generation && this.state !== "error") this.finish("closed", generation);
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.assertCurrent(generation);
      const timeout = window.setTimeout(() => {
        controller.abort(new DOMException("Realtime connection timed out.", "TimeoutError"));
      }, 20_000);
      let answer: { sdp: string };
      try {
        answer = await studio.exchangeRealtimeSdp({
          token: ephemeral,
          sdp: offer.sdp ?? "",
        });
      } finally {
        window.clearTimeout(timeout);
      }
      this.assertCurrent(generation);
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      this.assertCurrent(generation);
    } catch (error) {
      if (generation !== this.generation) return;
      const cancelled = error instanceof Error && error.name === "AbortError";
      if (cancelled) {
        this.finish("closed", generation);
      } else {
        const message = error instanceof Error ? error.message : "Could not start realtime transcription.";
        this.fail(message, generation);
      }
      throw error;
    }
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation || this.connectController?.signal.aborted) {
      throw abortError("Realtime connection was cancelled.");
    }
  }

  private setState(next: RealtimeConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.options.onState?.(next);
  }

  private beginSilenceDetection(stream: MediaStream, generation: number): void {
    const audioContext = this.audioContext ?? new AudioContext();
    if (audioContext.state === "suspended") {
      void audioContext.resume().catch(() => {
        this.fail("Microphone audio processing could not start.", generation);
      });
    }
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.55;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    this.audioContext = audioContext;
    this.analyser = analyser;
    const samples = new Uint8Array(analyser.fftSize);

    const sample = () => {
      if (generation !== this.generation || !this.analyser || !this.channel || this.channel.readyState !== "open") return;
      analyser.getByteTimeDomainData(samples);
      let power = 0;
      for (const value of samples) {
        const normalized = (value - 128) / 128;
        power += normalized * normalized;
      }
      const rms = Math.sqrt(power / samples.length);
      const now = performance.now();
      if (rms > 0.035) {
        if (!this.hasSpeech) this.speechStartedAt = now;
        this.hasSpeech = true;
        this.lastSpeechAt = now;
      } else if (this.hasSpeech && now - this.lastSpeechAt > 750 && now - this.speechStartedAt > 300) {
        this.channel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        this.hasSpeech = false;
        this.speechStartedAt = 0;
        this.lastSpeechAt = 0;
      }
      this.silenceFrame = requestAnimationFrame(sample);
    };
    this.silenceFrame = requestAnimationFrame(sample);
  }

  private handleEvent(raw: string): void {
    if (raw.length > 1_000_000) return;
    try {
      const event = JSON.parse(raw) as Record<string, unknown>;
      const type = String(event.type ?? "");
      const itemId = String(event.item_id ?? (event.item as { id?: unknown } | undefined)?.id ?? "legacy");
      if (type.endsWith("input_audio_buffer.committed") && itemId !== "legacy") {
        if (!this.transcriptItems.has(itemId)) {
          this.transcriptItems.set(itemId, {
            text: "",
            final: false,
            sequence: this.transcriptSequence++,
          });
        }
      }
      if (type.endsWith("input_audio_transcription.delta") || type.endsWith("audio_transcript.delta")) {
        const item = this.transcriptItems.get(itemId) ?? {
          text: "",
          final: false,
          sequence: this.transcriptSequence++,
        };
        if (!item.final) {
          item.text += String(event.delta ?? "");
          this.transcriptItems.set(itemId, item);
          this.options.onTranscript?.(item.text, false, itemId, item.sequence);
        }
      }
      if (type.endsWith("input_audio_transcription.completed") || type.endsWith("audio_transcript.done")) {
        const item = this.transcriptItems.get(itemId) ?? {
          text: "",
          final: false,
          sequence: this.transcriptSequence++,
        };
        const text = String(event.transcript ?? event.text ?? item.text).trim();
        if (!item.final && text) this.options.onTranscript?.(text, true, itemId, item.sequence);
        item.text = text;
        item.final = true;
        this.transcriptItems.set(itemId, item);
        this.trimTranscriptItems();
      }
      if (type === "error") {
        const detail = event.error as { message?: string } | undefined;
        this.options.onError?.(detail?.message?.slice(0, 300) ?? "Realtime transcription returned an error.");
      }
    } catch {
      // Ignore malformed transport messages.
    }
  }

  private trimTranscriptItems(): void {
    if (this.transcriptItems.size <= 64) return;
    const oldest = [...this.transcriptItems.entries()].sort((a, b) => a[1].sequence - b[1].sequence)[0];
    if (oldest) this.transcriptItems.delete(oldest[0]);
  }

  private fail(message: string, generation: number): void {
    if (generation !== this.generation) return;
    this.options.onError?.(message);
    this.finish("error", generation);
  }

  private finish(finalState: "closed" | "error", generation: number): void {
    if (generation !== this.generation) return;
    this.generation++;
    this.cleanup();
    this.setState(finalState);
  }

  private cleanup(): void {
    this.connectController?.abort(abortError("Realtime connection closed."));
    this.connectController = undefined;
    if (this.channel) {
      this.channel.onopen = null;
      this.channel.onmessage = null;
      this.channel.onerror = null;
      this.channel.onclose = null;
      this.channel.close();
    }
    if (this.pc) {
      this.pc.onconnectionstatechange = null;
      this.pc.close();
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.silenceFrame !== undefined) cancelAnimationFrame(this.silenceFrame);
    if (this.connectionDeadline !== undefined) window.clearTimeout(this.connectionDeadline);
    if (this.disconnectedDeadline !== undefined) window.clearTimeout(this.disconnectedDeadline);
    void this.audioContext?.close().catch(() => undefined);
    if (this.consentToken) {
      void realtimeStudio()?.releaseConsent(this.consentToken).catch(() => undefined);
    }
    this.channel = undefined;
    this.pc = undefined;
    this.stream = undefined;
    this.audioContext = undefined;
    this.analyser = undefined;
    this.silenceFrame = undefined;
    this.connectionDeadline = undefined;
    this.disconnectedDeadline = undefined;
    this.consentToken = undefined;
    this.hasSpeech = false;
    this.speechStartedAt = 0;
    this.lastSpeechAt = 0;
    this.transcriptItems.clear();
    this.transcriptSequence = 0;
  }

  disconnect(notify = true): void {
    this.generation++;
    this.cleanup();
    if (notify) this.setState("closed");
  }
}
