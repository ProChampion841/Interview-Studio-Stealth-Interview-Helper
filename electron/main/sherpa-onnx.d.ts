declare module 'sherpa-onnx-node' {
  export interface Stream {
    acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void
    inputFinished(): void
  }
  export class OnlineRecognizer {
    constructor(config: object)
    createStream(): Stream
    isReady(stream: Stream): boolean
    decode(stream: Stream): void
    getResult(stream: Stream): { text: string; tokens: string[]; timestamps: number[]; start_time?: number; segment?: number; num_trailing_blanks?: number }
    isEndpoint(stream: Stream): boolean
    reset(stream: Stream): void
  }
  export class LinearResampler {
    constructor(inputRate: number, outputRate: number)
    flush(samples: Float32Array): Float32Array
    resample(samples: Float32Array): Float32Array
  }
  export class OnlinePunctuation {
    constructor(config: { model: { cnnBilstm: string; bpeVocab: string; numThreads: number; provider: string } })
    addPunct(text: string): string
  }
}
