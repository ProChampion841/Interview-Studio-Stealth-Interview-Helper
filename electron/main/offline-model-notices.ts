export const OFFLINE_MODEL_NOTICES = `Interview Studio offline English caption models

Runtime: sherpa-onnx (Apache-2.0), using ONNX Runtime.
https://github.com/k2-fsa/sherpa-onnx

English Zipformer transducer: converted by the sherpa-onnx maintainers from
Zengwei/icefall-asr-librispeech-streaming-zipformer-2023-05-17.
https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26
https://huggingface.co/Zengwei/icefall-asr-librispeech-streaming-zipformer-2023-05-17

English punctuation and casing: Edge-Punct-Casing by Jian You (Apache-2.0),
packaged as sherpa-onnx-online-punct-en-2024-08-06.
https://github.com/frankyoujian/Edge-Punct-Casing
https://github.com/frankyoujian/Edge-Punct-Casing/blob/main/LICENSE
https://github.com/k2-fsa/sherpa-onnx/releases/tag/punctuation-models
Individual data-file mirror, verified byte-for-byte against that release:
https://huggingface.co/jiangzhuo9357/edge-punct-casing-en-onnx

Legacy notices: the speaker models below are no longer downloaded or loaded.
These notices are retained for older installations that still contain them.

Speaker embeddings: NVIDIA NeMo English SpeakerNet, ONNX conversion distributed
by sherpa-onnx. See the upstream model and runtime notices for their terms.
https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models
https://github.com/NVIDIA/NeMo

Speaker segmentation: pyannote/segmentation-3.0, ONNX int8 conversion by
the sherpa-onnx maintainers.
https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0
https://huggingface.co/pyannote/segmentation-3.0

MIT License

Copyright (c) 2023 CNRS

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`
