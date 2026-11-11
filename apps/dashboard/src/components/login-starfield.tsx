import { Particles, ParticlesProvider, type ParticlesPluginRegistrar } from "@tsparticles/react";
import { loadSlim } from "@tsparticles/slim";
import type { ISourceOptions } from "@tsparticles/engine";

/*
 * The sign-in sky: tsParticles (MIT) with the slim preset — the same engine
 * behind the Aceternity/Magic UI sparkle backgrounds, without their full
 * bundle. Stars twinkle (opacity animation, unsynchronised) and drift slowly;
 * the palette stays in the brand's blue-violet neighbourhood so the sky reads
 * as one design with the button, not a rainbow.
 */
const options: ISourceOptions = {
  fullScreen: { enable: false },
  fpsLimit: 60,
  detectRetina: true,
  pauseOnBlur: true,
  pauseOnOutsideViewport: true,
  particles: {
    number: { value: 90, density: { enable: true, width: 1200, height: 800 } },
    color: { value: ["#ffffff", "#93c5fd", "#a78bfa", "#67e8f9"] },
    shape: { type: "circle" },
    opacity: {
      value: { min: 0.15, max: 0.9 },
      animation: { enable: true, speed: 1.4, sync: false }
    },
    size: { value: { min: 0.6, max: 2.4 } },
    move: {
      enable: true,
      speed: { min: 0.05, max: 0.3 },
      direction: "none",
      random: true,
      outModes: { default: "out" }
    },
    links: { enable: false }
  },
  interactivity: {
    events: { onClick: { enable: false }, onHover: { enable: false } }
  }
};

const init: ParticlesPluginRegistrar = async engine => {
  await loadSlim(engine);
};

export default function LoginStarfield() {
  // Motion is decoration here; an operator who asked the OS for less of it gets
  // the gradient sky alone.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  return (
    <ParticlesProvider init={init}>
      <Particles id="login-stars" className="absolute inset-0" options={options} />
    </ParticlesProvider>
  );
}