class CapturaVoz extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pcm = new Int16Array(4096);
    this.usados = 0;
    this.port.onmessage = () => {
      this.enviar();
      this.port.postMessage(null);
    };
  }

  enviar() {
    if (!this.usados) return;
    const bloque = this.pcm.slice(0, this.usados);
    this.port.postMessage(bloque, [bloque.buffer]);
    this.usados = 0;
  }

  process(entradas) {
    for (const muestra of entradas[0]?.[0] || []) {
      this.pcm[this.usados++] = Math.round(Math.max(-1, Math.min(1, muestra)) * 32767);
      if (this.usados === this.pcm.length) this.enviar();
    }
    return true;
  }
}

registerProcessor('captura-voz', CapturaVoz);
