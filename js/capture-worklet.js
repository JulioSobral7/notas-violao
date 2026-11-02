// Roda no thread de áudio: junta os quanta de 128 amostras em blocos de tamanho
// fixo e os envia ao thread principal, sem perder amostras (o requestAnimationFrame
// perde quadros e tem passo irregular).
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = options.processorOptions?.blockSize ?? 512;
    this.buf = new Float32Array(this.size);
    this.filled = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) {
      let i = 0;
      while (i < ch.length) {
        const take = Math.min(ch.length - i, this.size - this.filled);
        this.buf.set(ch.subarray(i, i + take), this.filled);
        this.filled += take;
        i += take;
        if (this.filled === this.size) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(this.size);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
