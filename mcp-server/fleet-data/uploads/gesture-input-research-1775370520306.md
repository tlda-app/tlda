# Sound-Based Gesture Input — Research Report

## What Already Exists in tlda

The codebase already has a working sound gesture system:

- **`clickDetect.ts`** — Web Audio transient detector using `AnalyserNode` + FFT. Detects tongue clicks (high-frequency transients >2kHz) and lip pops (lower-frequency). Adaptive noise floor, frame-by-frame polling at ~60fps. Emits `click`, `dblclick`, `enter`.
- **`useClickActions.ts`** — Wires click detector to tldraw: tongue click → pointer click, double click → context-sensitive (drag/enter/dblclick), lip pop → Enter.
- **`useFootControl.ts`** — Gamepad API integration for Thrustmaster T.Flight Rudder Pedals. Cursor movement via rudder + throttle, with physics model (response curve, sensitivity). Combined with click detection for fully hands-free control.

This is already more sophisticated than most projects in this space. The question is: what's the next tier?

---

## 1. Browser-Based Sound Classification

### What you have now: frequency-band heuristics
The current `clickDetect.ts` uses spectral energy ratios to distinguish tongue clicks from other transients. This works well for tongue clicks (very distinctive spectral signature) but doesn't scale to more sound types — adding whistle, hiss, shush, cluck, etc. would mean hand-tuning overlapping frequency bands.

### Option A: TensorFlow.js Speech Commands + Transfer Learning
**The most practical upgrade path for the browser.**

- [TensorFlow.js speech-commands](https://github.com/tensorflow/tfjs-models/tree/master/speech-commands) ships a pre-trained model (18-word vocabulary) that runs in-browser via Web Audio API.
- **Transfer learning**: You can retrain the top layers in-browser with ~15-30 seconds of examples per sound class. The base model already understands spectrograms; you just teach it your specific sounds.
- Process: collect ~20 examples each of tongue click, lip pop, hiss, whistle, silence → retrain in browser → export model → ship with app.
- Latency: ~100-200ms inference per frame (spectrogram window). The existing 60fps polling approach would need to batch into ~250ms windows.
- Model size: ~2-3MB (base) + tiny transfer head.
- **Safari/WebKit**: Works. Uses WebAssembly backend. No WebGPU needed.

Tutorial: [Transfer learning audio recognizer](https://www.tensorflow.org/js/tutorials/transfer/audio_recognizer) | [Codelab](https://codelabs.developers.google.com/codelabs/tensorflowjs-audio-codelab)

### Option B: Transformers.js + wav2vec2/audio classification
- [Transformers.js](https://github.com/huggingface/transformers.js) can run audio classification models (wav2vec2, HuBERT, Audio Spectrogram Transformer) entirely in-browser via ONNX Runtime + WASM.
- Pre-trained models on HuggingFace: [wav2vec2-base-superb-ks](https://huggingface.co/Xenova/wav2vec2-base-superb-ks) (keyword spotting).
- Heavier than TF.js speech-commands (~30-80MB models). Fine-tuning requires Python + GPU, then export to ONNX. Not trainable in-browser.
- Better accuracy for complex classification, but overkill for 5-6 sound classes.

### Option C: Custom lightweight model (ONNX Runtime Web)
- Train a small CNN or MLP on mel-spectrograms in Python (PyTorch/TF), export to ONNX, run in browser via [onnxruntime-web](https://www.npmjs.com/package/onnxruntime-web).
- Full control over model architecture, latency, and accuracy.
- Could get model size down to ~500KB for 6-class mouth sound classification.
- Most work upfront; best long-term if you want to ship this as a product.

### Recommendation: Option A (TF.js transfer learning)
Fastest path from where you are now. You could have 5-6 sound classes working in a day. The base model handles the hard part (spectrograms → features); you just label examples. If accuracy isn't good enough, graduate to Option C.

---

## 2. Whistle Detection

Whistling is easy to detect because it's a nearly pure sinusoidal tone in 500-5000Hz.

- **[Whistlerr](https://github.com/shubhamjain/whistlerr)** — Browser-based whistle detector using Web Audio API. Implements M. Nilsson's "Human Whistle Detection and Frequency Estimation" paper. Detects high-energy spikes in the 500-5000Hz band. Simple, lightweight, no ML needed.
- **[PitchDetect](https://github.com/cwilso/PitchDetect)** — Autocorrelation-based pitch detection in Web Audio. Could detect whistle pitch to distinguish e.g. high whistle vs low whistle as different gestures.
- **[pitchfinder](https://github.com/peterkhayes/pitchfinder)** — JS library with multiple pitch detection algorithms (YIN, AMDF, etc.). YIN is best for monophonic sounds like whistles.

**Practical approach**: Add a whistle band check to the existing `clickDetect.ts` — look for sustained energy in 500-5000Hz with high spectral purity (low entropy). This is ~20 lines of code on top of what you have. No ML needed.

**Pitch as a gesture dimension**: Whistle high = one action, whistle low = another. Pitch detection via autocorrelation is cheap and reliable for whistles.

---

## 3. Existing Tools & Products

### [Talon Voice](https://talonvoice.com/docs/)
- **What it is**: System-level voice + noise control for hands-free computing. Built for accessibility (RSI, motor impairment). Mac + Windows + Linux.
- **Built-in sounds**: Pop and hiss. Low latency (~50ms). Pop = click, hiss = scroll/drag.
- **Beta**: Experimental integration with parrot.py for custom sounds.
- **Architecture**: Native app, not browser-based. Uses its own speech engine (conformer model) and noise classifier. Runs as a system daemon.
- **Relevance**: If Skip wanted system-level sound control (not just in the tlda viewer), Talon is the most mature option. But it's a heavyweight dependency and doesn't integrate with Web Audio / the browser's mic stream.

### [Parrot.py](https://github.com/chaosparrot/parrot.py)
- **What it is**: Python app for mapping mouth sounds → keyboard/mouse actions. Uses scikit-learn + PyTorch for classification. MFCC features.
- **Sound types**: Trainable on anything. The [tryout bundle](https://github.com/chaosparrot/parrotpy_tryout_bundle/blob/master/sounds.MD) includes ~42 distinct vocal sounds: alveolar/lateral/palatal clicks, fricatives, sibilants, trills, vowels, whistles, pops, plus non-vocal (finger snaps, keyboard sounds).
- **Pattern system**: Threshold-based with confidence %, power, frequency checks. Supports sustained sounds (hiss), bursts (click), and combined patterns. ~60fps detection.
- **Mac**: Supported. Native app, not browser.
- **Talon integration**: Can feed detected sounds into Talon's grammar system.
- **Relevance**: Best reference for "how many sounds can you practically distinguish?" Answer: trained on one person's voice, ~10-15 reliably distinct mouth sounds. The architecture (MFCC → small classifier) could be ported to the browser with TF.js.

### Chrome Extensions / Browser Tools
- No significant Chrome extensions for non-speech sound classification found.
- The closest thing is browser-based voice typing (uses speech recognition, not sound gestures).

---

## 4. Hardware: Foot Pedals

### What Skip already has
**Thrustmaster T.Flight Rudder Pedals** — 3-axis (rudder + 2 toe brakes), connected via USB Gamepad API. Already integrated into `useFootControl.ts` with physics model, response curve editor, and sensitivity control.

### Dedicated keyboard foot pedals (if you wanted simpler/additional)

| Pedal | Pedals | Mac | Price | Notes |
|-------|--------|-----|-------|-------|
| [Kinesis Savant Elite2](https://kinesis-ergo.com/shop/savant-elite2-triple-pedal/) | 1-3 | Yes | $99-159 | Programmable via SmartSet app. Stores config on device. Any keystroke/combo/macro. Limitation: macOS doesn't let one USB device modify another's input. |
| [iKKEGOL Metal USB Pedal](https://www.ikkegol.com/switch-pedals-c-66/ikkegol-metalbody-usb-foot-pedal-programmable-switch-hid-action-p-61.html) | 1 | Yes | ~$26 | HID device, config stored on pedal. Simple single-action. |
| [StealthSwitch3](https://www.amazon.com/StealthSwitch3-USB-Foot-Controller-Programmable/dp/B00NUFCR9Y) | 1+ | Yes | ~$40 | Mac config software included. Works with Karabiner Elements. |
| [X-Keys USB Foot Pedal](https://www.amazon.com/X-keys-Foot-Pedal-Playback-Control/dp/B009PP6Z50) | 1 | Yes | ~$50 | Keyboard Maestro compatible. Keystroke stored in device memory. |
| [CH Products Pro Pedals](https://www.amazon.com/CH-Products-Pedals-Simulator-300-111/dp/B0000512IE) | 3-axis | Yes | ~$130 | Plug and play Mac, no drivers. Flight sim style like what you have. |

**Given that Skip already has the T.Flight pedals integrated via Gamepad API**, dedicated keyboard pedals would only make sense for a specific additional gesture (e.g. a single "push to talk" pedal under the other foot). The Savant Elite2 is the best option there — 3 pedals, stores macros on device, native Mac support.

---

## 5. What Works in Safari / Browser vs Needs Native

### Works in Safari (Web APIs)
- **Web Audio API** (AnalyserNode, FFT) — what you already use. Full Safari support.
- **MediaDevices.getUserMedia** — mic access. Full Safari support (requires user gesture).
- **Gamepad API** — what you already use for foot pedals. Safari support.
- **TensorFlow.js** (WASM backend) — works in Safari. No WebGPU needed.
- **ONNX Runtime Web** (WASM backend) — works in Safari.
- **AudioWorklet** — Safari 14.1+. Better than ScriptProcessorNode for low-latency audio processing. Could improve current rAF-based polling.

### Needs native / system-level
- **Talon Voice** — native daemon, system-wide control.
- **Parrot.py** — native Python app.
- **Global hotkeys from foot pedals** — if you want a pedal to work outside the browser window, you need Karabiner Elements or similar.
- **Background mic access** — browser mic only works while the tab is focused (or has a visible indicator).

### The gap
The current system requires the tlda tab to be focused for mic access. If Skip is typing in Zed and wants tongue-click to trigger something in tlda, that won't work from the browser alone. Options:
1. **Keep it browser-only** — mic works when viewer is active. Fine for review sessions.
2. **Thin native bridge** — a small node process that holds the mic and sends events via WebSocket. ~50 lines of code. Would let sound gestures work system-wide.
3. **Talon** — if you want the full system-level stack, Talon is the right tool. But it's a separate ecosystem.

---

## 6. Recommended Approach for Skip's Setup

### Short-term (hours of work)
1. **Add whistle detection** to `clickDetect.ts` — sustained energy in 500-5000Hz with high spectral purity. Map to a new event (e.g. `'whistle'`). ~20 lines.
2. **Add hiss detection** — sustained broadband energy (like the existing transient detector but checking for duration >200ms instead of sharp attack). Map to `'hiss-start'` / `'hiss-end'` for continuous control (e.g. scroll, zoom).
3. That gives you: tongue click, double click, lip pop, whistle, hiss = **5 distinct gestures**, all with the existing frequency-heuristic approach.

### Medium-term (1-2 days)
4. **Switch to TF.js speech-commands transfer learning** for the classifier. Train on Skip's specific sounds with 15-30 seconds of examples each. This replaces the hand-tuned frequency bands with a proper ML classifier that's more robust and extensible.
5. **Add AudioWorklet** for lower-latency processing (currently rAF-based, which can stall during heavy rendering).

### Long-term (if this becomes a product)
6. **Train a custom small ONNX model** on a dataset of mouth sounds. Ship as a ~500KB model with the app.
7. **Thin native bridge** for system-wide sound gestures (node process + WebSocket).
8. **Parrot.py integration** for users who want 15+ distinct sound classes.

### Hardware
- The T.Flight pedals are already the right hardware. No change needed.
- If you want a "push to talk" under the other foot, a single Kinesis Savant Elite2 pedal (~$99) mapped to a hotkey would work.

---

## Key Links

**Browser ML**
- [TF.js speech-commands](https://github.com/tensorflow/tfjs-models/tree/master/speech-commands) — pre-trained + transfer learning
- [TF.js transfer learning tutorial](https://www.tensorflow.org/js/tutorials/transfer/audio_recognizer)
- [TF.js audio codelab](https://codelabs.developers.google.com/codelabs/tensorflowjs-audio-codelab)
- [Transformers.js](https://github.com/huggingface/transformers.js) — ONNX-based, heavier models
- [ONNX Runtime Web](https://www.npmjs.com/package/onnxruntime-web)

**Sound detection**
- [Whistlerr](https://github.com/shubhamjain/whistlerr) — browser whistle detector
- [PitchDetect](https://github.com/cwilso/PitchDetect) — autocorrelation pitch detection
- [pitchfinder](https://github.com/peterkhayes/pitchfinder) — JS pitch detection library (YIN, AMDF)

**Native tools**
- [Talon Voice](https://talonvoice.com/docs/) — system-level voice + noise control
- [Parrot.py](https://github.com/chaosparrot/parrot.py) — trainable sound → action (Python, Mac supported)
- [Parrot.py sound types](https://github.com/chaosparrot/parrotpy_tryout_bundle/blob/master/sounds.MD) — 42+ trainable sounds

**Foot pedals**
- [Kinesis Savant Elite2](https://kinesis-ergo.com/shop/savant-elite2-triple-pedal/) — programmable, Mac, $99-159
- [iKKEGOL USB Pedal](https://www.ikkegol.com/switch-pedals-c-66/ikkegol-metalbody-usb-foot-pedal-programmable-switch-hid-action-p-61.html) — simple, $26
- [StealthSwitch3](https://www.amazon.com/StealthSwitch3-USB-Foot-Controller-Programmable/dp/B00NUFCR9Y) — Karabiner-compatible, $40
