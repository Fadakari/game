/**
 * Zero-dependency procedural Web Audio API sound synthesizer for 3D Air Combat.
 * Synthesizes jet turbine hum, afterburner roar, autocannon bursts, radar lock tones,
 * missile launches, flares, explosions, GPWS pull-up alarms, and combat cues.
 */
export class AudioSynth {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  // Continuous turbine nodes
  private engineOsc: OscillatorNode | null = null;
  private engineNoise: AudioBufferSourceNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private engineGain: GainNode | null = null;

  // Continuous radar lock tone
  private lockOsc: OscillatorNode | null = null;
  private lockGain: GainNode | null = null;

  private muted = false;
  private started = false;
  private lastAlertTime = 0;
  private lastLockBeepTime = 0;

  public isMuted(): boolean {
    return this.muted;
  }

  public setMuted(mute: boolean): void {
    this.muted = mute;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(mute ? 0 : 0.42, this.ctx.currentTime, 0.03);
    }
  }

  public toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  public unlock(): void {
    if (this.started) {
      if (this.ctx && this.ctx.state === 'suspended') {
        void this.ctx.resume();
      }
      return;
    }

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    try {
      const ctx = new AudioCtx();
      this.ctx = ctx;

      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : 0.42;
      master.connect(ctx.destination);
      this.masterGain = master;

      // Pre-generate 2 seconds of white noise for reusable jet/cannon/explosion buffers
      const bufferLen = ctx.sampleRate * 2;
      const buffer = ctx.createBuffer(1, bufferLen, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferLen; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      this.noiseBuffer = buffer;

      // Continuous turbine roar (filtered noise + subtle low sawtooth hum)
      const engineFilter = ctx.createBiquadFilter();
      engineFilter.type = 'lowpass';
      engineFilter.frequency.value = 260;
      engineFilter.Q.value = 1.2;

      const engineGain = ctx.createGain();
      engineGain.gain.value = 0.0;
      engineFilter.connect(engineGain);
      engineGain.connect(master);

      const noiseSrc = ctx.createBufferSource();
      noiseSrc.buffer = buffer;
      noiseSrc.loop = true;
      noiseSrc.connect(engineFilter);
      noiseSrc.start();

      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 78;
      const oscGain = ctx.createGain();
      oscGain.gain.value = 0.16;
      osc.connect(oscGain);
      oscGain.connect(engineFilter);
      osc.start();

      this.engineNoise = noiseSrc;
      this.engineOsc = osc;
      this.engineFilter = engineFilter;
      this.engineGain = engineGain;

      // Continuous radar lock tone oscillator
      const lockOsc = ctx.createOscillator();
      lockOsc.type = 'sine';
      lockOsc.frequency.value = 1040;
      const lockGain = ctx.createGain();
      lockGain.gain.value = 0;
      lockOsc.connect(lockGain);
      lockGain.connect(master);
      lockOsc.start();
      this.lockOsc = lockOsc;
      this.lockGain = lockGain;

      this.started = true;
    } catch {
      // Ignore if browser blocks audio context
    }
  }

  public updateContinuous(
    active: boolean,
    speedNorm: number,
    boosting: boolean,
    lockProgress: number,
    isLocked: boolean,
    gpwsWarning: boolean,
    missileIncoming: boolean,
  ): void {
    if (!this.ctx || !this.engineGain || !this.engineFilter || !this.engineOsc || !this.lockGain || !this.lockOsc) {
      return;
    }
    const now = this.ctx.currentTime;

    if (!active || this.muted) {
      this.engineGain.gain.setTargetAtTime(0, now, 0.06);
      this.lockGain.gain.setTargetAtTime(0, now, 0.04);
      return;
    }

    // Engine turbine pitch & roar modulation
    const targetGain = boosting ? 0.24 : 0.11 + speedNorm * 0.06;
    const targetFreq = boosting ? 760 : 220 + speedNorm * 240;
    const targetPitch = 68 + speedNorm * 42 + (boosting ? 35 : 0);

    this.engineGain.gain.setTargetAtTime(targetGain, now, 0.08);
    this.engineFilter.frequency.setTargetAtTime(targetFreq, now, 0.08);
    this.engineOsc.frequency.setTargetAtTime(targetPitch, now, 0.08);

    // Radar lock tone: solid high pitch when locked, chirping when acquiring
    if (isLocked) {
      this.lockOsc.frequency.setTargetAtTime(1180, now, 0.02);
      this.lockGain.gain.setTargetAtTime(0.08, now, 0.02);
    } else if (lockProgress > 0.05) {
      const interval = 0.26 - lockProgress * 0.16;
      if (now - this.lastLockBeepTime >= interval) {
        this.lastLockBeepTime = now;
        this.playTone(680 + lockProgress * 320, 0.055, 'triangle', 0.075);
      }
      this.lockGain.gain.setTargetAtTime(0, now, 0.02);
    } else {
      this.lockGain.gain.setTargetAtTime(0, now, 0.03);
    }

    // Urgent cockpit alarms (GPWS / Incoming Missile)
    if ((gpwsWarning || missileIncoming) && now - this.lastAlertTime >= (missileIncoming ? 0.28 : 0.42)) {
      this.lastAlertTime = now;
      if (missileIncoming) {
        this.playTone(1480, 0.09, 'square', 0.085);
      } else if (gpwsWarning) {
        this.playTone(620, 0.12, 'sawtooth', 0.09);
        setTimeout(() => this.playTone(860, 0.12, 'sawtooth', 0.09), 130);
      }
    }
  }

  private playTone(
    freq: number,
    duration: number,
    type: OscillatorType,
    volume: number,
  ): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + duration + 0.01);
  }

  public playCannonShot(): void {
    if (!this.ctx || !this.masterGain || !this.noiseBuffer || this.muted) return;
    const now = this.ctx.currentTime;
    const pitchVar = 0.92 + Math.random() * 0.16;

    // Punchy mechanical cannon thump
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(210 * pitchVar, now);
    osc.frequency.exponentialRampToValueAtTime(52, now + 0.065);
    gain.gain.setValueAtTime(0.16, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.075);

    // Crisp propellant crack
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1400 * pitchVar;
    filter.Q.value = 1.5;
    const nGain = this.ctx.createGain();
    nGain.gain.setValueAtTime(0.11, now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
    noise.connect(filter);
    filter.connect(nGain);
    nGain.connect(this.masterGain);
    noise.start(now, Math.random() * 1.2, 0.05);
  }

  public playMissileLaunch(): void {
    if (!this.ctx || !this.masterGain || !this.noiseBuffer || this.muted) return;
    const now = this.ctx.currentTime;

    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1900, now);
    filter.frequency.exponentialRampToValueAtTime(420, now + 0.65);
    filter.Q.value = 1.1;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.01, now);
    gain.gain.linearRampToValueAtTime(0.28, now + 0.06);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.7);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    noise.start(now, 0, 0.72);

    this.playTone(165, 0.2, 'sawtooth', 0.14);
  }

  public playFlarePop(): void {
    if (!this.ctx || !this.masterGain || !this.noiseBuffer || this.muted) return;
    const now = this.ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const t = now + i * 0.075;
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 1200;
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.15, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      noise.connect(filter);
      filter.connect(gain);
      gain.connect(this.masterGain);
      noise.start(t, Math.random(), 0.1);
    }
  }

  public playHitConfirm(): void {
    this.playTone(1320, 0.045, 'sine', 0.11);
  }

  public playArmorCrit(): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    // Crisp high-energy armor penetration double-ping for flanking hits
    this.playTone(1580, 0.06, 'triangle', 0.15);
    setTimeout(() => this.playTone(2120, 0.09, 'sine', 0.14), 48);
  }

  public playTankCannon(): void {
    if (!this.ctx || !this.masterGain || !this.noiseBuffer || this.muted) return;
    const now = this.ctx.currentTime;
    const pitchVar = 0.94 + Math.random() * 0.12;

    // Deep 120mm cannon sub-bass punch
    const sub = this.ctx.createOscillator();
    const subGain = this.ctx.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(125 * pitchVar, now);
    sub.frequency.exponentialRampToValueAtTime(30, now + 0.34);
    subGain.gain.setValueAtTime(0.45, now);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.38);
    sub.connect(subGain);
    subGain.connect(this.masterGain);
    sub.start(now);
    sub.stop(now + 0.4);

    // Sharp metallic breech blast + muzzle crack
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1650 * pitchVar, now);
    filter.frequency.exponentialRampToValueAtTime(190, now + 0.42);
    const nGain = this.ctx.createGain();
    nGain.gain.setValueAtTime(0.36, now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.44);
    noise.connect(filter);
    filter.connect(nGain);
    nGain.connect(this.masterGain);
    noise.start(now, Math.random() * 0.6, 0.48);
  }

  public playSmokeDeploy(): void {
    if (!this.ctx || !this.masterGain || !this.noiseBuffer || this.muted) return;
    const now = this.ctx.currentTime;
    // Twin smoke canister pop + compressed gas hiss
    this.playTone(260, 0.08, 'triangle', 0.16);
    setTimeout(() => this.playTone(310, 0.08, 'triangle', 0.14), 60);

    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1100, now);
    filter.frequency.exponentialRampToValueAtTime(360, now + 0.85);
    filter.Q.value = 0.9;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.02, now);
    gain.gain.linearRampToValueAtTime(0.22, now + 0.07);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    noise.start(now, 0, 0.95);
  }

  public updateTankContinuous(
    active: boolean,
    speedNorm: number,
    boosting: boolean,
    atgmAlert: boolean,
  ): void {
    if (!this.ctx || !this.engineGain || !this.engineFilter || !this.engineOsc || !this.lockGain) {
      return;
    }
    const now = this.ctx.currentTime;

    if (!active || this.muted) {
      this.engineGain.gain.setTargetAtTime(0, now, 0.06);
      this.lockGain.gain.setTargetAtTime(0, now, 0.04);
      return;
    }

    // Heavy armored diesel engine idle rumble -> turbo growl
    const targetGain = boosting ? 0.21 : 0.085 + speedNorm * 0.075;
    const targetFreq = boosting ? 390 : 120 + speedNorm * 165;
    const targetPitch = 40 + speedNorm * 34 + (boosting ? 22 : 0);

    this.engineGain.gain.setTargetAtTime(targetGain, now, 0.09);
    this.engineFilter.frequency.setTargetAtTime(targetFreq, now, 0.09);
    this.engineOsc.frequency.setTargetAtTime(targetPitch, now, 0.09);
    this.lockGain.gain.setTargetAtTime(0, now, 0.03);

    if (atgmAlert && now - this.lastAlertTime >= 0.3) {
      this.lastAlertTime = now;
      this.playTone(1360, 0.085, 'square', 0.085);
    }
  }

  public playPlayerHit(): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    this.playTone(115, 0.22, 'sawtooth', 0.24);
  }

  public playExplosion(heavy = true): void {
    if (!this.ctx || !this.masterGain || !this.noiseBuffer || this.muted) return;
    const now = this.ctx.currentTime;
    const dur = heavy ? 0.95 : 0.45;

    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(heavy ? 680 : 950, now);
    filter.frequency.exponentialRampToValueAtTime(85, now + dur);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(heavy ? 0.42 : 0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    noise.start(now, 0, dur + 0.05);

    // Sub-bass shockwave
    const sub = this.ctx.createOscillator();
    const subGain = this.ctx.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(heavy ? 95 : 130, now);
    sub.frequency.exponentialRampToValueAtTime(26, now + dur * 0.8);
    subGain.gain.setValueAtTime(heavy ? 0.35 : 0.16, now);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + dur * 0.85);
    sub.connect(subGain);
    subGain.connect(this.masterGain);
    sub.start(now);
    sub.stop(now + dur);
  }

  public playWaveClear(): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((n, idx) => {
      setTimeout(() => this.playTone(n, 0.22, 'triangle', 0.13), idx * 95);
    });
  }

  public playDefeatSting(): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    const notes = [330, 277.18, 220, 146.83];
    notes.forEach((n, idx) => {
      setTimeout(() => this.playTone(n, 0.32, 'sawtooth', 0.13), idx * 125);
    });
  }

  public dispose(): void {
    try {
      this.engineNoise?.stop();
      this.engineOsc?.stop();
      this.lockOsc?.stop();
      void this.ctx?.close();
    } catch {
      // ignore teardown errors
    }
    this.ctx = null;
    this.started = false;
  }
}
