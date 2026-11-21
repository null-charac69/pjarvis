export type AudioInputDevice = {
  deviceId: string;
  label: string;
};

export function supportsVoiceCapture(): boolean {
  return typeof navigator !== "undefined" && "mediaDevices" in navigator && typeof AudioContext !== "undefined";
}

export async function enumerateAudioInputs(): Promise<AudioInputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === "audioinput")
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `Microphone ${index + 1}`,
    }));
}

export function rootMeanSquare(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

export function safeVoiceError(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Microphone access was denied. Review microphone permission in Settings.";
  }
  if (error instanceof DOMException && error.name === "NotFoundError") {
    return "No microphone is available. Connect an input device and try again.";
  }
  if (error instanceof DOMException && error.name === "NotReadableError") {
    return "The microphone is busy or unavailable to this application.";
  }
  if (error instanceof Error && error.message) return error.message;
  return "Voice input could not start.";
}

export function resampleToPcm16(samples: Float32Array, sourceRate: number, targetRate = 16_000): Int16Array {
  const sampleCount = Math.floor(samples.length * targetRate / sourceRate);
  const output = new Int16Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const sourceIndex = Math.min(samples.length - 1, Math.floor(index * sourceRate / targetRate));
    const sample = Math.max(-1, Math.min(1, samples[sourceIndex]));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

export function joinPcmChunks(chunks: Int16Array[]): Int16Array {
  const output = new Int16Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export function encodePcmWav(samples: Int16Array, sampleRate = 16_000): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeText(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(44 + index * 2, samples[index], true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export function selectLocalSpeechVoice(
  voices: readonly SpeechSynthesisVoice[],
  language: string,
): SpeechSynthesisVoice | undefined {
  const localVoices = voices.filter((voice) => voice.localService);
  const normalizedLanguage = language.toLocaleLowerCase();
  const languagePrefix = normalizedLanguage.split("-")[0];
  return localVoices.find((voice) => voice.lang.toLocaleLowerCase() === normalizedLanguage)
    ?? localVoices.find((voice) => voice.lang.toLocaleLowerCase().startsWith(languagePrefix))
    ?? localVoices[0];
}